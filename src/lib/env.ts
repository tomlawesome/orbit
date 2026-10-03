import { z } from "zod";
import {
  OIDC_CALLBACK_PATH,
  SESSION_SECRET_RUNTIME_MESSAGE,
  SESSION_TTL_SECONDS_MAX,
  SESSION_TTL_SECONDS_MIN,
  isValidSessionSecret,
} from "@/lib/config-contract";
import { readRuntimeSecret } from "@/lib/runtime-secret";

const baseEnvironmentSchema = z.object({
  APP_URL: z.url(),
  // The same rule scripts/configure.sh and the .env-orbit field schema apply
  // (issue #578): the runtime used to accept any 32-character string, so an
  // instance could start on a secret its own configure step refused.
  SESSION_SECRET: z.string().refine(isValidSessionSecret, { message: SESSION_SECRET_RUNTIME_MESSAGE }),
  // Bounds shared with config-contract.ts's isValidSessionTtlSeconds
  // (SF2-F6), so the readiness contract and this loader can never disagree
  // about what's in range.
  SESSION_TTL_SECONDS: z.coerce.number().int().min(SESSION_TTL_SECONDS_MIN).max(SESSION_TTL_SECONDS_MAX).default(604_800),
  // Explicit mode key (ADR-0023 §1): local sign-in is always available; OIDC
  // is enabled only when this is exactly "true" (default "false"). The OIDC
  // fields below are parsed and validated only when it is.
  //
  // The .env-orbit contract (config-contract.ts's envOrbitSchema) accepts ""
  // as well as "true"/"false" for this key — "" is how a key that is
  // present but unset in the file round-trips — so this loader must treat
  // it as "unset" too (SF2-F4): without the preprocess step, an empty
  // ORBIT_AUTH_OIDC="" is contract-legal but z.enum(["true","false"]) still
  // throws on it, because zod's own .default() only ever applies to a
  // genuinely `undefined` field, never to a present-but-empty string.
  ORBIT_AUTH_OIDC: z.preprocess(
    (value) => (value === "" ? "false" : value),
    z.enum(["true", "false"]).default("false"),
  ),
});

const oidcEnvironmentSchema = z.object({
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

export interface OidcAuthConfig {
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
}

export interface AuthConfig {
  appUrl: URL;
  sessionSecret: string;
  sessionTtlSeconds: number;
  secureCookies: boolean;
  // null when ORBIT_AUTH_OIDC is not "true" (ADR-0023 §1): every OIDC route
  // answers auth_not_configured rather than reading provider fields that may
  // still be present but are deliberately ignored.
  oidc: OidcAuthConfig | null;
}

let cachedAuthConfig: AuthConfig | undefined;

/** Loads authentication configuration lazily so builds do not require runtime secrets. */
export function getAuthConfig(environment: NodeJS.ProcessEnv = process.env): AuthConfig {
  if (environment === process.env && cachedAuthConfig) return cachedAuthConfig;

  const base = baseEnvironmentSchema.parse({
    ...environment,
    SESSION_SECRET: readRuntimeSecret(environment, "SESSION_SECRET"),
  });
  const appUrl = new URL(base.APP_URL);
  const localApp = ["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname);

  if (appUrl.protocol !== "https:" && !(appUrl.protocol === "http:" && localApp)) {
    throw new Error("APP_URL must use HTTPS except for a loopback development address");
  }

  let oidc: OidcAuthConfig | null = null;
  if (base.ORBIT_AUTH_OIDC === "true") {
    const parsedOidc = oidcEnvironmentSchema.parse({
      ...environment,
      OIDC_CLIENT_SECRET: readRuntimeSecret(environment, "OIDC_CLIENT_SECRET"),
    });
    const issuerUrl = new URL(parsedOidc.OIDC_ISSUER);
    if (issuerUrl.protocol !== "https:") {
      throw new Error("OIDC_ISSUER must use HTTPS");
    }

    const scopes = parsedOidc.OIDC_SCOPES.split(/\s+/).filter(Boolean);
    if (!scopes.includes("openid")) throw new Error("OIDC_SCOPES must include openid");

    oidc = {
      issuer: issuerUrl.href,
      clientId: parsedOidc.OIDC_CLIENT_ID,
      clientSecret: parsedOidc.OIDC_CLIENT_SECRET,
      callbackUrl: parsedOidc.OIDC_CALLBACK_URL ?? new URL(OIDC_CALLBACK_PATH, appUrl).href,
      scopes: scopes.join(" "),
      claims: {
        email: parsedOidc.OIDC_EMAIL_CLAIM,
        emailVerified: parsedOidc.OIDC_EMAIL_VERIFIED_CLAIM,
        name: parsedOidc.OIDC_NAME_CLAIM,
        avatar: parsedOidc.OIDC_AVATAR_CLAIM,
      },
    };
  }

  const config: AuthConfig = {
    appUrl,
    sessionSecret: base.SESSION_SECRET,
    sessionTtlSeconds: base.SESSION_TTL_SECONDS,
    secureCookies: appUrl.protocol === "https:",
    oidc,
  };

  if (environment === process.env) cachedAuthConfig = config;
  return config;
}

export function resetAuthConfigForTests(): void {
  cachedAuthConfig = undefined;
}
