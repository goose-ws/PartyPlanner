import fs from "node:fs";
import path from "node:path";
import type { AppConfig, PersistedConfig } from "./types/config.js";

const CONFIG_PATH = process.env.CONFIG_PATH ?? "/app/data/config.json";

function readPersistedConfig(): Partial<PersistedConfig> {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as Partial<PersistedConfig>;
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Failed to read/parse config at ${CONFIG_PATH}: ${err.message}`);
  }
}

function writePersistedConfig(cfg: PersistedConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `Missing required configuration value: ${name}. Set it via environment variable on first boot ` +
        `(non-secret values will subsequently be persisted to ${CONFIG_PATH}).`
    );
  }
  return value;
}

/**
 * Resolves configuration using: env vars > existing config.json > defaults.
 * On first boot (no config.json present), writes the resolved *non-secret*
 * values to disk so future restarts don't need most env vars set.
 */
export function loadConfig(): AppConfig {
  const persisted = readPersistedConfig();
  const isFirstBoot = Object.keys(persisted).length === 0;

  const resolved: AppConfig = {
    port: Number(process.env.PORT ?? persisted.port ?? 3000),
    trustProxy: parseBool(process.env.TRUST_PROXY, persisted.trustProxy ?? true),
    publicUrl: process.env.PUBLIC_URL ?? persisted.publicUrl ?? required(undefined, "PUBLIC_URL"),

    db: {
      host: process.env.DB_HOST ?? persisted.db?.host ?? required(undefined, "DB_HOST"),
      port: Number(process.env.DB_PORT ?? persisted.db?.port ?? 3306),
      user: process.env.DB_USER ?? persisted.db?.user ?? required(undefined, "DB_USER"),
      database: process.env.DB_NAME ?? persisted.db?.database ?? required(undefined, "DB_NAME"),
      // Secret: env only, every single boot. Never read from / written to disk.
      password: required(process.env.DB_PASSWORD, "DB_PASSWORD"),
    },

    discord: {
      clientId:
        process.env.DISCORD_CLIENT_ID ?? persisted.discord?.clientId ?? required(undefined, "DISCORD_CLIENT_ID"),
      // Secret: env only, every single boot.
      clientSecret: required(process.env.DISCORD_CLIENT_SECRET, "DISCORD_CLIENT_SECRET"),
      // Only needed on the very first boot to seed the root user; safe to persist the *id*
      // (not a secret) so the env var can be dropped from compose afterwards.
      rootDiscordId: process.env.INITIAL_ROOT_DISCORD_ID ?? persisted.discord?.rootDiscordId ?? null,
    },

    session: {
      cookieName: process.env.SESSION_COOKIE_NAME ?? persisted.session?.cookieName ?? "pp_sid",
      maxAgeSeconds: Number(process.env.SESSION_MAX_AGE ?? persisted.session?.maxAgeSeconds ?? 31536000),
      // Secret: env only. Used to sign the session cookie so it can't be forged/guessed.
      signingSecret: required(process.env.SESSION_SIGNING_SECRET, "SESSION_SIGNING_SECRET"),
    },

    scheduling: {
      defaultWindowMonths: Number(
        process.env.DEFAULT_WINDOW_MONTHS ?? persisted.scheduling?.defaultWindowMonths ?? 6
      ),
    },

    security: {
      tokenEncryptionKey: required(process.env.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY"),
    },

    devFakeLoginEnabled: parseBool(process.env.DEV_FAKE_LOGIN, false),

    smtp: {
      host: process.env.SMTP_HOST ?? null,
      port: Number(process.env.SMTP_PORT ?? 587),
      user: process.env.SMTP_USER ?? null,
      password: process.env.SMTP_PASSWORD ?? null,
      fromAddress: process.env.SMTP_FROM ?? "Party Planner <no-reply@localhost>",
      secure: parseBool(process.env.SMTP_SECURE, false),
    },
  };

  if (isFirstBoot) {
    const toPersist: PersistedConfig = {
      port: resolved.port,
      trustProxy: resolved.trustProxy,
      publicUrl: resolved.publicUrl,
      db: { host: resolved.db.host, port: resolved.db.port, user: resolved.db.user, database: resolved.db.database },
      discord: { clientId: resolved.discord.clientId, rootDiscordId: resolved.discord.rootDiscordId },
      session: { cookieName: resolved.session.cookieName, maxAgeSeconds: resolved.session.maxAgeSeconds },
      scheduling: { defaultWindowMonths: resolved.scheduling.defaultWindowMonths },
    };
    writePersistedConfig(toPersist);
    // eslint-disable-next-line no-console
    console.log(`[config] First boot — wrote resolved config to ${CONFIG_PATH}`);
  }

  return resolved;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}
