/**
 * Resolved runtime configuration.
 *
 * Precedence: environment variables > /app/config.json > hardcoded defaults.
 *
 * Secrets (DB password, Discord client secret, session signing secret) are
 * ALWAYS sourced from env and are never written to config.json, so the file
 * remains safe to keep around / commit to a backup after first boot.
 */
export interface AppConfig {
  port: number;
  trustProxy: boolean;
  publicUrl: string; // e.g. https://partyplanner.example.com  (used to build the OAuth redirect_uri)

  db: {
    host: string;
    port: number;
    user: string;
    database: string;
    password: string; // env-only, never persisted
  };

  discord: {
    clientId: string;
    clientSecret: string; // env-only, never persisted
    rootDiscordId: string | null; // seeds the first 'root' user on boot, then can be dropped from env
  };

  session: {
    cookieName: string;
    maxAgeSeconds: number; // default 1 year
    signingSecret: string; // env-only, never persisted
  };

  security: {
    // 32-byte hex key used to encrypt Discord refresh tokens at rest (AES-256-GCM).
    // env-only, never persisted. Generate with: openssl rand -hex 32
    tokenEncryptionKey: string;
  };


  scheduling: {
    defaultWindowMonths: number; // how far out the calendar auto-generates (default 6)
  };

  /**
   * Dev-only auth bypass for testing without real Discord accounts. Must be
   * explicitly enabled via env — defaults to false, never persisted to
   * config.json, and should never be set on a production deployment.
   */
  devFakeLoginEnabled: boolean;

  /**
   * Entirely optional. If host/user/pass aren't all set, invite creation
   * simply skips emailing and returns the link for the DM to share manually.
   */
  smtp: {
    host: string | null;
    port: number;
    user: string | null;
    password: string | null; // env-only, obviously never persisted
    fromAddress: string;
    secure: boolean;
  };
}

/** The subset of AppConfig that is safe to persist to /app/config.json (no secrets). */
export interface PersistedConfig {
  port: number;
  trustProxy: boolean;
  publicUrl: string;
  db: {
    host: string;
    port: number;
    user: string;
    database: string;
  };
  discord: {
    clientId: string;
    rootDiscordId: string | null;
  };
  session: {
    cookieName: string;
    maxAgeSeconds: number;
  };
  scheduling: {
    defaultWindowMonths: number;
  };
}
