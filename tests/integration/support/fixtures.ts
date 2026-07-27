import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createSession, csrfTokenForSession, readSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/env";
import { sessionCookieName } from "@/lib/auth/cookies";
import { getDb } from "@/db";
import {
  documents,
  externalIdentities,
  households,
  items,
  memberships,
  sections,
  userPreferences,
  users,
} from "@/db/schema";

type FixtureRole = "owner" | "member" | "outsider";

export interface IntegrationSession {
  userId: string;
  sessionId: string;
  token: string;
  csrfToken: string;
  headers: Record<string, string>;
}

export interface IntegrationFixture {
  household: { id: string; name: string };
  section: { id: string };
  item: { id: string };
  document: { id: string; displayName: string };
  session(role: FixtureRole): Promise<IntegrationSession>;
}

export function sessionHeaders(session: IntegrationSession): Record<string, string> {
  return { ...session.headers };
}

export async function createIntegrationFixture(label: string): Promise<IntegrationFixture> {
  const db = getDb();
  const namespace = `${label}-${randomUUID()}`;
  const issuer = "https://oidc.invalid.example";

  async function createUser(role: FixtureRole) {
    const [user] = await db.insert(users).values({
      email: `${namespace}-${role}@example.invalid`,
      emailVerified: true,
      displayName: `Integration ${role}`,
    }).returning({ id: users.id });
    await db.insert(userPreferences).values({ userId: user.id });
    await db.insert(externalIdentities).values({
      userId: user.id,
      issuer,
      subject: `${namespace}-${role}`,
    });
    return user;
  }

  const owner = await createUser("owner");
  const member = await createUser("member");
  const outsider = await createUser("outsider");
  const householdName = `Integration household ${namespace}`;
  const [household] = await db.insert(households).values({
    name: householdName,
    timezone: "Europe/London",
    defaultCurrency: "GBP",
    setupCompleted: true,
  }).returning({ id: households.id, name: households.name });
  await db.insert(memberships).values([
    { householdId: household.id, userId: owner.id, role: "owner" },
    { householdId: household.id, userId: member.id, role: "member" },
  ]);
  const [section] = await db.insert(sections).values({
    householdId: household.id,
    slug: `documents-${namespace}`,
    name: "Documents",
    position: 0,
  }).returning({ id: sections.id });
  const [item] = await db.insert(items).values({
    householdId: household.id,
    sectionId: section.id,
    title: `Integration item ${namespace}`,
    currency: "GBP",
  }).returning({ id: items.id });
  const displayName = "integration-document.pdf";
  const [document] = await db.insert(documents).values({
    householdId: household.id,
    itemId: item.id,
    uploadedByUserId: member.id,
    displayName,
    mediaType: "application/pdf",
    sizeBytes: 128,
    contentSha256: createHash("sha256").update(namespace).digest("hex"),
    lifecycle: "available",
    scanStatus: "skipped",
    availableAt: new Date(),
  }).returning({ id: documents.id, displayName: documents.displayName });

  async function session(role: FixtureRole): Promise<IntegrationSession> {
    const userId = role === "owner" ? owner.id : role === "member" ? member.id : outsider.id;
    const config = getAuthConfig();
    const created = await createSession(userId, config);
    const sessionRequest = new NextRequest(config.appUrl.href, {
      headers: { cookie: `${sessionCookieName(config)}=${created.token}` },
    });
    const persisted = await readSession(sessionRequest, config);
    if (!persisted) throw new Error(`Integration session for ${role} was not persisted`);
    const csrfToken = csrfTokenForSession(persisted, config);
    return {
      userId,
      sessionId: persisted.id,
      token: created.token,
      csrfToken,
      headers: {
        cookie: `${sessionCookieName(config)}=${created.token}`,
        origin: config.appUrl.origin,
        "sec-fetch-site": "same-origin",
        "x-csrf-token": csrfToken,
      },
    };
  }

  return { household, section, item, document, session };
}
