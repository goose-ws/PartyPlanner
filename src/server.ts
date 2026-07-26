import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { isSetupComplete } from "./types/config.js";
import { initDb } from "./db/index.js";
import { sessionMiddleware } from "./middleware/session.js";
import { authPageRouter, authApiRouter } from "./routes/auth.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { invitesApiRouter, invitePageRouter } from "./routes/invites.js";
import { availabilityRouter } from "./routes/availability.js";
import { schedulingRouter } from "./routes/scheduling.js";
import { setupRouter } from "./routes/setup.js";
import { coreSettingsRouter } from "./routes/coreSettings.js";
import { runReminderCheck } from "./scheduling/reminders.js";

const cfg = loadConfig();
const app = express();

// Nginx terminates TLS in front of us; trust its X-Forwarded-* headers so
// req.secure and req.ip resolve correctly, and secure cookies still get set.
if (cfg.trustProxy) app.set("trust proxy", 1);

app.use(helmet());
app.use(express.json());

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

const webDistDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web/dist");

function serveSpaFallback(apiPrefixes: string[]) {
  app.use(express.static(webDistDir));
  app.get("*", (req, res) => {
    if (apiPrefixes.some((p) => req.path.startsWith(p))) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.sendFile(path.join(webDistDir, "index.html"));
  });
}

if (!isSetupComplete(cfg)) {
  // --- Setup-only mode ---
  // No DB connection, no auth, no campaign routes at all — just enough to
  // let the frontend render the first-run wizard and submit it. Once
  // config.json has everything it needs, a container restart boots
  // normally into the branch below.
  console.warn(
    "\n[server] ⚠️  Setup incomplete — booting in SETUP-ONLY mode. " +
      "Visit the app in a browser to finish configuration, then restart the container.\n"
  );

  app.use("/api", setupRouter(cfg));
  serveSpaFallback(["/api", "/healthz"]);

  app.listen(cfg.port, () => {
    console.log(`[server] Party Planner listening on :${cfg.port} — SETUP MODE (visit the app to configure it)`);
  });
} else {
  // --- Normal mode ---
  initDb(cfg); // migrations already ran as a separate boot step — see src/db/migrate.ts / entrypoint.sh

  app.use(cookieParser(cfg.session.signingSecret));
  app.use(sessionMiddleware(cfg));

  // Browser-navigation endpoints: Discord's redirect_uri and shared invite
  // links land on these directly, so they stay at bare top-level paths that
  // intentionally don't collide with any React Router page.
  app.use("/auth", authPageRouter(cfg));
  app.use("/", invitePageRouter());

  // JSON-only endpoints, fetched by the SPA. Everything here lives under
  // /api specifically so it can never collide with a client-side route again
  // — see the /campaigns/:id incident this fixed.
  app.use("/api/auth", authApiRouter(cfg));
  app.use("/api", invitesApiRouter(cfg));
  app.use("/api", campaignsRouter());
  app.use("/api", availabilityRouter());
  app.use("/api", schedulingRouter(cfg));
  app.use("/api", coreSettingsRouter(cfg));
  app.use("/api", setupRouter(cfg)); // /setup/status still reports complete:true here, for the frontend's single status check

  serveSpaFallback(["/api", "/auth", "/invite/", "/healthz"]);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[server] Unhandled error:", err);
    res.status(500).json({ error: "internal_error" });
  });

  app.listen(cfg.port, () => {
    console.log(`[server] Party Planner listening on :${cfg.port} (public URL: ${cfg.publicUrl})`);
  });

  // In-process reminder scheduler. A single container instance is assumed
  // (see docker-compose.yml — no horizontal scaling), so a plain interval
  // timer is sufficient; no external cron or job queue needed. State that
  // prevents duplicate sends lives in the DB (campaigns.last_reminder_*),
  // so this is safe across restarts and doesn't need its own persistence.
  const REMINDER_CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
  setTimeout(() => {
    runReminderCheck().catch((err) => console.error("[reminders] Initial check failed:", err));
    setInterval(() => {
      runReminderCheck().catch((err) => console.error("[reminders] Scheduled check failed:", err));
    }, REMINDER_CHECK_INTERVAL_MS);
  }, 30_000); // wait 30s after boot so DB connections are warmed up first
}
