import { Router } from "express";
import crypto from "node:crypto";
import type { AppConfig } from "../types/config.js";
import { requireRoot } from "../middleware/authz.js";
import { writeStoredConfig } from "../configStore.js";
import { db } from "../db/index.js";

const REVEALABLE_FIELDS = new Set(["dbPassword", "discordClientSecret"]);

/**
 * Root-only. Almost every field here requires a container restart to take
 * effect — the running process loaded its config once at boot and doesn't
 * re-read it. This just edits config.json; it doesn't hot-reload anything.
 * That's communicated to the user via the response, not silently assumed.
 */
export function coreSettingsRouter(cfg: AppConfig): Router {
  const router = Router();

  router.get("/core-settings", requireRoot, (_req, res) => {
    res.json({
      publicUrl: cfg.publicUrl,
      port: cfg.port,
      trustProxy: cfg.trustProxy,
      db: {
        host: cfg.db.host,
        port: cfg.db.port,
        user: cfg.db.user,
        database: cfg.db.database,
        passwordSet: !!cfg.db.password,
      },
      discord: {
        clientId: cfg.discord.clientId,
        clientSecretSet: !!cfg.discord.clientSecret,
        rootDiscordId: cfg.discord.rootDiscordId,
      },
      session: {
        cookieName: cfg.session.cookieName,
        maxAgeSeconds: cfg.session.maxAgeSeconds,
        signingSecretSet: true, // always resolved (auto-generated) — never null
      },
      security: {
        tokenEncryptionKeySet: true,
      },
      scheduling: {
        defaultWindowMonths: cfg.scheduling.defaultWindowMonths,
      },
      smtp: {
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        user: cfg.smtp.user,
        passwordSet: !!cfg.smtp.password,
        fromAddress: cfg.smtp.fromAddress,
        secure: cfg.smtp.secure,
      },
    });
  });

  router.get("/core-settings/reveal/:field", requireRoot, (req, res) => {
    const field = req.params.field!;
    if (!REVEALABLE_FIELDS.has(field)) {
      res.status(400).json({ error: "field_not_revealable" });
      return;
    }
    const value = field === "dbPassword" ? cfg.db.password : cfg.discord.clientSecret;
    res.json({ field, value });
  });

  router.patch("/core-settings", requireRoot, async (req, res) => {
    const b = req.body ?? {};
    const patch: Record<string, any> = {};

    if (b.publicUrl !== undefined) patch.publicUrl = b.publicUrl;
    if (b.port !== undefined) patch.port = Number(b.port);
    if (b.dbHost !== undefined || b.dbPort !== undefined || b.dbUser !== undefined || b.dbName !== undefined || b.dbPassword !== undefined) {
      patch.db = {
        ...(b.dbHost !== undefined && { host: b.dbHost }),
        ...(b.dbPort !== undefined && { port: Number(b.dbPort) }),
        ...(b.dbUser !== undefined && { user: b.dbUser }),
        ...(b.dbName !== undefined && { database: b.dbName }),
        ...(b.dbPassword !== undefined && { password: b.dbPassword }),
      };
    }
    if (b.discordClientId !== undefined || b.discordClientSecret !== undefined || b.initialRootDiscordId !== undefined) {
      patch.discord = {
        ...(b.discordClientId !== undefined && { clientId: b.discordClientId }),
        ...(b.discordClientSecret !== undefined && { clientSecret: b.discordClientSecret }),
        ...(b.initialRootDiscordId !== undefined && { rootDiscordId: b.initialRootDiscordId }),
      };
    }
    if (b.smtpHost !== undefined || b.smtpPort !== undefined || b.smtpUser !== undefined || b.smtpPassword !== undefined || b.smtpFrom !== undefined) {
      patch.smtp = {
        ...(b.smtpHost !== undefined && { host: b.smtpHost || null }),
        ...(b.smtpPort !== undefined && { port: Number(b.smtpPort) }),
        ...(b.smtpUser !== undefined && { user: b.smtpUser || null }),
        ...(b.smtpPassword !== undefined && { password: b.smtpPassword || null }),
        ...(b.smtpFrom !== undefined && { fromAddress: b.smtpFrom }),
      };
    }

    // Regenerating the session signing secret logs everyone out immediately
    // (existing cookies stop verifying). Regenerating the token encryption
    // key makes existing stored Discord refresh tokens undecryptable, so we
    // clear them — affected users just need to log in again via Discord;
    // nothing else breaks.
    if (b.regenerateSigningSecret === true) {
      patch.session = { signingSecret: crypto.randomBytes(32).toString("hex") };
    }
    if (b.regenerateTokenEncryptionKey === true) {
      patch.security = { tokenEncryptionKey: crypto.randomBytes(32).toString("hex") };
      await db()("users").update({ discord_refresh_token: null });
    }

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "no_fields_to_update" });
      return;
    }

    writeStoredConfig(patch);
    res.json({ ok: true, message: "Saved to config.json. Restart the container for changes to take effect." });
  });

  return router;
}
