import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { loadConfig } from "./config.js";
import { initDb } from "./db/index.js";
import { sessionMiddleware } from "./middleware/session.js";
import { authRouter } from "./routes/auth.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { invitesRouter } from "./routes/invites.js";

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

app.use("/auth", authRouter(cfg));
app.use("/", invitesRouter(cfg)); // mounts both /campaigns/:id/invites and the public /invite/:token
app.use("/", campaignsRouter());

// Static SPA build (added once the frontend exists) will be served from here,
// with a catch-all falling through to index.html for client-side routing.

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server] Unhandled error:", err);
  res.status(500).json({ error: "internal_error" });
});

app.listen(cfg.port, () => {
  console.log(`[server] Party Planner listening on :${cfg.port} (public URL: ${cfg.publicUrl})`);
});
