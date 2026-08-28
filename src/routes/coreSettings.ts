import { Router } from "express";
import crypto from "node:crypto";
import type { AppConfig } from "../types/config.js";
import { requireRoot } from "../middleware/authz.js";
import { writeStoredConfig } from "../configStore.js";
import { db } from "../db/index.js";
import { parseUtcDatetime } from "../scheduling/dateMath.js";

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

  /**
   * Root-only. Cursor-paginated by id (via `before`) rather than offset —
   * cheap and stable even as new rows keep being inserted between page
   * loads. `campaignId`/`event` are optional filters for narrowing down
   * when tracking down something specific.
   */
  router.get("/audit-log", requireRoot, async (req, res) => {
    const limit = 100;
    let query = db()("audit_log").orderBy("id", "desc").limit(limit);
    if (typeof req.query.campaignId === "string") query = query.where({ campaign_id: req.query.campaignId });
    if (typeof req.query.event === "string") query = query.where({ event: req.query.event });
    if (typeof req.query.before === "string" && /^\d+$/.test(req.query.before)) {
      query = query.where("id", "<", Number(req.query.before));
    }
    const rows = await query;
    res.json({
      entries: rows.map((r) => ({
        id: r.id,
        campaignId: r.campaign_id,
        actorDiscordId: r.actor_discord_id,
        event: r.event,
        detail: r.detail ? JSON.parse(r.detail) : null,
        // See dateMath.ts's parseUtcDatetime() — the raw DB string has no
        // zone marker and new Date() on it is parsed as local time, not UTC.
        createdAt: parseUtcDatetime(r.created_at).toISOString(),
      })),
    });
  });

  return router;
}
