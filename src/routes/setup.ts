import { Router } from "express";
import type { AppConfig } from "../types/config.js";
import { isSetupComplete } from "../types/config.js";
import { writeStoredConfig } from "../configStore.js";

function missingFields(cfg: AppConfig): string[] {
  const missing: string[] = [];
  if (!cfg.publicUrl) missing.push("publicUrl");
  if (!cfg.db.host) missing.push("dbHost");
  if (!cfg.db.user) missing.push("dbUser");
  if (!cfg.db.database) missing.push("dbName");
  if (!cfg.db.password) missing.push("dbPassword");
  if (!cfg.discord.clientId) missing.push("discordClientId");
  if (!cfg.discord.clientSecret) missing.push("discordClientSecret");
  if (!cfg.discord.rootDiscordId) missing.push("initialRootDiscordId");
  return missing;
}

/** Public — used by the frontend to decide whether to render the setup wizard instead of the normal app. */
export function setupRouter(cfg: AppConfig): Router {
  const router = Router();

  router.get("/setup/status", (_req, res) => {
    res.json({ complete: isSetupComplete(cfg), missing: missingFields(cfg) });
  });

  router.post("/setup/complete", (req, res) => {
    if (isSetupComplete(cfg)) {
      res.status(403).json({ error: "already_configured", message: "Setup is already complete — use Core Settings instead." });
      return;
    }

    const b = req.body ?? {};
    const required: Record<string, unknown> = {
      publicUrl: b.publicUrl,
      dbHost: b.dbHost,
      dbUser: b.dbUser,
      dbName: b.dbName,
      dbPassword: b.dbPassword,
      discordClientId: b.discordClientId,
      discordClientSecret: b.discordClientSecret,
      initialRootDiscordId: b.initialRootDiscordId,
    };
    const emptyField = Object.entries(required).find(([, v]) => typeof v !== "string" || !v.trim());
    if (emptyField) {
      res.status(400).json({ error: "missing_field", field: emptyField[0] });
      return;
    }
    if (!/^https?:\/\//.test(b.publicUrl)) {
      res.status(400).json({ error: "publicUrl_must_be_a_full_url" });
      return;
    }
    if (!/^\d+$/.test(b.initialRootDiscordId)) {
      res.status(400).json({ error: "initialRootDiscordId_must_be_numeric" });
      return;
    }

    writeStoredConfig({
      publicUrl: b.publicUrl,
      db: {
        host: b.dbHost,
        port: b.dbPort ? Number(b.dbPort) : 3306,
        user: b.dbUser,
        database: b.dbName,
        password: b.dbPassword,
      },
      discord: {
        clientId: b.discordClientId,
        clientSecret: b.discordClientSecret,
        rootDiscordId: b.initialRootDiscordId,
      },
    } as Partial<AppConfig>);

    res.json({ ok: true, message: "Saved. Restart the container to apply — e.g. `docker compose restart partyplanner`." });
  });

  return router;
}
