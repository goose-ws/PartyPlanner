/**
 * Resolved runtime configuration.
 *
 * Precedence: environment variables > /app/data/config.json > generated
 * default (secrets only) > null.
 *
 * Nothing here is "env-only" anymore — everything can live in config.json,
 * including secrets (DB password, Discord client secret, session signing
 * secret, token encryption key). That's a deliberate tradeoff: config.json
 * is a plaintext file on the host either way, same as the .env file it
 * replaces, so this doesn't meaningfully change who can read these values —
 * see the setup/first-run docs for the full reasoning. Env vars still take
 * precedence when set, so nothing here forces you to stop using env vars if
 * you'd rather manage secrets externally.
 *
 * Fields that are still `null` mean "not configured yet" — the app boots in
 * a minimal setup-only mode until publicUrl, the db.* fields, discord.*
 * fields, and discord.rootDiscordId are all present.
 */
export interface AppConfig {
  port: number;
  trustProxy: boolean;
  publicUrl: string | null; // e.g. https://partyplanner.example.com  (used to build the OAuth redirect_uri)

  db: {
    host: string | null;
    port: number;
    user: string | null;
    database: string | null;
    password: string | null;
  };

  discord: {
    clientId: string | null;
    clientSecret: string | null;
    rootDiscordId: string | null; // seeds the first 'root' user on boot
  };

  session: {
    cookieName: string;
    maxAgeSeconds: number; // default 1 year
    signingSecret: string; // always resolved — auto-generated if not set anywhere
  };

  security: {
    // 32-byte hex key used to encrypt Discord refresh tokens at rest (AES-256-GCM).
    // Always resolved — auto-generated if not set anywhere.
    tokenEncryptionKey: string;
  };

  scheduling: {
    defaultWindowMonths: number; // how far out the calendar auto-generates (default 6)
  };

  /**
   * Entirely optional. If host/user/pass aren't all set, invite creation
   * simply skips emailing and returns the link for the DM to share manually.
   */
  smtp: {
    host: string | null;
    port: number;
    user: string | null;
    password: string | null;
    fromAddress: string;
    secure: boolean;
  };
}

/** True once every field required for the app to actually function is present. */
export function isSetupComplete(cfg: AppConfig): boolean {
  return !!(
    cfg.publicUrl &&
    cfg.db.host &&
    cfg.db.user &&
    cfg.db.database &&
    cfg.db.password &&
    cfg.discord.clientId &&
    cfg.discord.clientSecret &&
    cfg.discord.rootDiscordId
  );
}

/** True once the DB connection itself is configured — enough to run migrations, even if Discord/root setup isn't done yet. */
export function isDbConfigured(cfg: AppConfig): boolean {
  return !!(cfg.db.host && cfg.db.user && cfg.db.database && cfg.db.password);
}

/**
 * Everything in AppConfig is potentially persistable to config.json now —
 * this is just AppConfig's shape again, kept as a distinct alias so the
 * intent (this is specifically "what's stored on disk") stays legible at
 * call sites even though the shape is identical.
 */
export type StoredConfig = AppConfig;
