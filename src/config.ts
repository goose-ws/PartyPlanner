import crypto from "node:crypto";
import { readStoredConfig, writeStoredConfig, getConfigPath } from "./configStore.js";
import type { AppConfig } from "./types/config.js";

/** env > persisted config.json > null. Never throws. */
function resolve(envVal: string | undefined, persistedVal: string | null | undefined): string | null {
  if (envVal) return envVal;
  if (persistedVal) return persistedVal;
  return null;
}

/** Same as resolve(), but generates a random 32-byte hex value if neither source has one — for secrets that the app itself owns (session signing key, token encryption key), never for external credentials like a DB password. */
function resolveOrGenerate(envVal: string | undefined, persistedVal: string | null | undefined): string {
  const found = resolve(envVal, persistedVal);
  if (found) return found;
  return crypto.randomBytes(32).toString("hex");
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

/**
 * Resolves configuration (env > config.json > generated-default-or-null)
 * and persists anything newly resolved back to config.json — so a value
 * provided via env on first boot no longer needs to stay in the
 * environment afterward, and a freshly-generated secret is remembered
 * rather than regenerated (and thus changed) on every restart.
 */
export function loadConfig(): AppConfig {
  const stored = readStoredConfig();

  const publicUrl = resolve(process.env.PUBLIC_URL, stored.publicUrl);
  const dbHost = resolve(process.env.DB_HOST, stored.db?.host);
  const dbUser = resolve(process.env.DB_USER, stored.db?.user);
  const dbName = resolve(process.env.DB_NAME, stored.db?.database);
  const dbPassword = resolve(process.env.DB_PASSWORD, stored.db?.password);
  const discordClientId = resolve(process.env.DISCORD_CLIENT_ID, stored.discord?.clientId);
  const discordClientSecret = resolve(process.env.DISCORD_CLIENT_SECRET, stored.discord?.clientSecret);
  const rootDiscordId = resolve(process.env.INITIAL_ROOT_DISCORD_ID, stored.discord?.rootDiscordId);
  const signingSecret = resolveOrGenerate(process.env.SESSION_SIGNING_SECRET, stored.session?.signingSecret);
  const tokenEncryptionKey = resolveOrGenerate(process.env.TOKEN_ENCRYPTION_KEY, stored.security?.tokenEncryptionKey);

  const resolved: AppConfig = {
    port: Number(process.env.PORT ?? stored.port ?? 3000),
    trustProxy: parseBool(process.env.TRUST_PROXY, stored.trustProxy ?? true),
    publicUrl,

    db: {
      host: dbHost,
      port: Number(process.env.DB_PORT ?? stored.db?.port ?? 3306),
      user: dbUser,
      database: dbName,
      password: dbPassword,
    },

    discord: {
      clientId: discordClientId,
      clientSecret: discordClientSecret,
      rootDiscordId,
    },

    session: {
      cookieName: process.env.SESSION_COOKIE_NAME ?? stored.session?.cookieName ?? "pp_sid",
      maxAgeSeconds: Number(process.env.SESSION_MAX_AGE ?? stored.session?.maxAgeSeconds ?? 31536000),
      signingSecret,
    },

    security: {
      tokenEncryptionKey,
    },

    scheduling: {
      defaultWindowMonths: Number(process.env.DEFAULT_WINDOW_MONTHS ?? stored.scheduling?.defaultWindowMonths ?? 6),
    },
  };

  // Persist anything newly resolved (from env, or freshly generated) back to
  // config.json, so subsequent boots don't need the env vars anymore and
  // generated secrets don't silently change on restart.
  writeStoredConfig(resolved);

  console.log(`[config] Resolved configuration from env + ${getConfigPath()} (env values, where set, take precedence).`);

  return resolved;
}
