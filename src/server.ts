import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { initDb } from "./db/index.js";
import { sessionMiddleware } from "./middleware/session.js";
import { authPageRouter, authApiRouter } from "./routes/auth.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { invitesApiRouter, invitePageRouter } from "./routes/invites.js";
import { availabilityRouter } from "./routes/availability.js";
import { schedulingRouter } from "./routes/scheduling.js";

const cfg = loadConfig();
initDb(cfg); // migrations already ran as a separate boot step — see src/db/migrate.ts / entrypoint.sh

const app = express();

// Nginx terminates TLS in front of us; trust its X-Forwarded-* headers so
// req.secure and req.ip resolve correctly, and secure cookies still get set.
if (cfg.trustProxy) app.set("trust proxy", 1);

app.use(helmet());
app.use(express.json());
app.use(cookieParser(cfg.session.signingSecret));
app.use(sessionMiddleware(cfg));

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

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

// --- Static SPA ---
// Resolved relative to this compiled file's own location (dist/server.js ->
// ../web/dist), not process.cwd() — see the knexfile.ts migration-path bug
// for why that distinction matters in this container.
const webDistDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web/dist");
const API_PREFIXES = ["/api", "/auth", "/invite/", "/healthz"];

app.use(express.static(webDistDir));
app.get("*", (req, res) => {
  if (API_PREFIXES.some((p) => req.path.startsWith(p))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.sendFile(path.join(webDistDir, "index.html"));
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server] Unhandled error:", err);
  res.status(500).json({ error: "internal_error" });
});

app.listen(cfg.port, () => {
  console.log(`[server] Party Planner listening on :${cfg.port} (public URL: ${cfg.publicUrl})`);
});
