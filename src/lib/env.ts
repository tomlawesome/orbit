import { z } from "zod";
import {
  OIDC_CALLBACK_PATH,
  SESSION_SECRET_RUNTIME_MESSAGE,
  isValidSessionSecret,
} from "@/lib/config-contract";
import { readRuntimeSecret } from "@/lib/runtime-secret";

const authEnvironmentSchema = z.object({
  APP_URL: z.url(),
  // The same rule scripts/configure.sh and the .env-orbit field schema apply
  // (issue #578): the runtime used to accept any 32-character string, so an
  // instance could start on a secret its own configure step refused.
  SESSION_SECRET: z.string().refine(isValidSessionSecret, { message: SESSION_SECRET_RUNTIME_MESSAGE }),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(900).max(2_592_000).default(604_800),
  OIDC_ISSUER: z.url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  OIDC_CALLBACK_URL: z.url().optional(),
  OIDC_SCOPES: z.string().default("openid profile email"),
  OIDC_EMAIL_CLAIM: z.string().min(1).default("email"),
  OIDC_EMAIL_VERIFIED_CLAIM: z.string().min(1).default("email_verified"),
  OIDC_NAME_CLAIM: z.string().min(1).default("name"),
  OIDC_AVATAR_CLAIM: z.string().min(1).default("picture"),
});

export interface AuthConfig {
  appUrl: URL;
  sessionSecret: string;
  sessionTtlSeconds: number;
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  scopes: string;
  claims: {
    email: string;
    emailVerified: string;
    name: string;
    avatar: string;
  };
  secureCookies: boolean;
}

let cachedAuthConfig: AuthConfig | undefined;

/** Loads authentication configuration lazily so builds do not require runtime secrets. */
export function getAuthConfig(environment: NodeJS.ProcessEnv = process.env): AuthConfig {
  if (environment === process.env && cachedAuthConfig) return cachedAuthConfig;

  const parsed = authEnvironmentSchema.parse({
    ...environment,
    SESSION_SECRET: readRuntimeSecret(environment, "SESSION_SECRET"),
    OIDC_CLIENT_SECRET: readRuntimeSecret(environment, "OIDC_CLIENT_SECRET"),
  });
  const appUrl = new URL(parsed.APP_URL);
  const issuerUrl = new URL(parsed.OIDC_ISSUER);
  const localApp = ["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname);

  if (appUrl.protocol !== "https:" && !(appUrl.protocol === "http:" && localApp)) {
    throw new Error("APP_URL must use HTTPS except for a loopback development address");
  }
  if (issuerUrl.protocol !== "https:") {
    throw new Error("OIDC_ISSUER must use HTTPS");
  }

  const scopes = parsed.OIDC_SCOPES.split(/\s+/).filter(Boolean);
  if (!scopes.includes("openid")) throw new Error("OIDC_SCOPES must include openid");

  const config: AuthConfig = {
    appUrl,
    sessionSecret: parsed.SESSION_SECRET,
    sessionTtlSeconds: parsed.SESSION_TTL_SECONDS,
    issuer: issuerUrl.href,
    clientId: parsed.OIDC_CLIENT_ID,
    clientSecret: parsed.OIDC_CLIENT_SECRET,
    callbackUrl: parsed.OIDC_CALLBACK_URL ?? new URL(OIDC_CALLBACK_PATH, appUrl).href,
    scopes: scopes.join(" "),
    claims: {
      email: parsed.OIDC_EMAIL_CLAIM,
      emailVerified: parsed.OIDC_EMAIL_VERIFIED_CLAIM,
      name: parsed.OIDC_NAME_CLAIM,
      avatar: parsed.OIDC_AVATAR_CLAIM,
    },
    secureCookies: appUrl.protocol === "https:",
  };

  if (environment === process.env) cachedAuthConfig = config;
  return config;
}

export function resetAuthConfigForTests(): void {
  cachedAuthConfig = undefined;
}
