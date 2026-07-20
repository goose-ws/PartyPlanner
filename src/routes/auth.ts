import { Router } from "express";
import crypto from "node:crypto";
import type { AppConfig } from "../types/config.js";
import { db } from "../db/index.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchDiscordUser,
} from "../auth/discord.js";
import { encryptToken } from "../auth/tokenCrypto.js";
import { createSession, destroySession } from "../auth/sessionStore.js";
import { setSessionCookie, clearSessionCookie } from "../middleware/session.js";
import { redeemInvite } from "./invites.js";

const OAUTH_STATE_COOKIE = "pp_oauth_state";
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes — just long enough to complete the Discord redirect dance

interface OAuthStatePayload {
  state: string;
  invite: string | null;
}

/**
 * Full-page-navigation routes: Discord redirects the browser here directly,
 * so these MUST stay at bare top-level paths (/auth/login, /auth/callback)
 * matching what's registered in the Discord developer portal. Mounted at
 * /auth in server.ts — never move under /api, and never reuse these path
 * segments for a client-side (React Router) route.
 */
export function authPageRouter(cfg: AppConfig): Router {
  const router = Router();

  router.get("/login", (req, res) => {
    const state = crypto.randomBytes(16).toString("hex");
    const invite = typeof req.query.invite === "string" ? req.query.invite : null;

    const payload: OAuthStatePayload = { state, invite };
    res.cookie(OAUTH_STATE_COOKIE, JSON.stringify(payload), {
      signed: true,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: OAUTH_STATE_MAX_AGE_MS,
      path: "/auth",
    });

    res.redirect(buildAuthorizeUrl(cfg, state));
  });

  router.get("/callback", async (req, res) => {
    const code = req.query.code;
    const returnedState = req.query.state;
    const raw = req.signedCookies?.[OAUTH_STATE_COOKIE];
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/auth" });

    if (typeof code !== "string" || typeof returnedState !== "string" || !raw) {
      res.status(400).send("Invalid OAuth callback — missing code/state, or the login attempt expired. Please try logging in again.");
      return;
    }

    let statePayload: OAuthStatePayload;
    try {
      statePayload = JSON.parse(raw);
    } catch {
      res.status(400).send("Invalid OAuth state cookie.");
      return;
    }

    if (statePayload.state !== returnedState) {
      res.status(400).send("OAuth state mismatch — possible CSRF attempt or expired login link.");
      return;
    }

    try {
      const tokens = await exchangeCodeForToken(cfg, code);
      const discordUser = await fetchDiscordUser(tokens.access_token);
      const encryptedRefresh = encryptToken(tokens.refresh_token, cfg.security.tokenEncryptionKey);

      const isConfiguredRoot =
        cfg.discord.rootDiscordId !== null && cfg.discord.rootDiscordId === discordUser.id;

      const existing = await db()("users").where({ discord_id: discordUser.id }).first();

      if (existing) {
        await db()("users")
          .where({ discord_id: discordUser.id })
          .update({
            username: discordUser.username,
            avatar_hash: discordUser.avatar,
            discord_refresh_token: encryptedRefresh,
            ...(isConfiguredRoot && existing.global_role !== "root" ? { global_role: "root" } : {}),
          });
      } else {
        await db()("users").insert({
          discord_id: discordUser.id,
          username: discordUser.username,
          avatar_hash: discordUser.avatar,
          discord_refresh_token: encryptedRefresh,
          global_role: isConfiguredRoot ? "root" : "user",
        });
      }

      // Redirects to a bare /campaigns/<id> path, which is a REACT ROUTER
      // page, not an API route — this only works correctly because /api/*
      // is where all JSON campaign endpoints live now. Do not reuse
      // /campaigns/:id for anything JSON-returning.
      let redirectPath = "/";
      if (statePayload.invite) {
        const result = await redeemInvite(statePayload.invite, discordUser.id);
        if (result.ok) {
          redirectPath = `/campaigns/${result.campaignSlug}`;
        }
        // Invalid/expired/exhausted invite tokens are silently ignored here —
        // the user still gets logged in, just without campaign membership.
      }

      const sid = await createSession(discordUser.id, cfg.session.maxAgeSeconds);
      setSessionCookie(res, cfg, sid);
      res.redirect(redirectPath);
    } catch (err) {
      console.error("[auth] OAuth callback failed:", err);
      res.status(502).send("Login failed while communicating with Discord. Please try again.");
    }
  });

  return router;
}

/**
 * JSON-only routes, fetched by the SPA — mounted under /api/auth in
 * server.ts so they never collide with a client-side route.
 */
export function authApiRouter(cfg: AppConfig): Router {
  const router = Router();

  router.post("/logout", async (req, res) => {
    const sid = req.signedCookies?.[cfg.session.cookieName];
    if (sid) {
      await destroySession(sid);
    }
    clearSessionCookie(res, cfg);
    res.status(204).end();
  });

  router.get("/me", (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    res.json({ user: req.user });
  });

  /**
   * Dev-only: logs in as a fake user without any Discord round-trip, for
   * testing multiple roles without real accounts. Returns 404 (not 403) when
   * disabled, so its existence isn't advertised in a real deployment.
   * discordId is restricted to a "test-" prefix — this can never create or
   * touch a real Discord snowflake, and never modifies global_role, so it
   * cannot be used to mint a fake root account even if left enabled by mistake.
   */
  router.post("/dev-login", async (req, res) => {
    if (!cfg.devFakeLoginEnabled) {
      res.status(404).end();
      return;
    }

    const discordId = typeof req.body?.discordId === "string" ? req.body.discordId : "";
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    if (!/^test-[a-z0-9_-]+$/.test(discordId) || !username) {
      res.status(400).json({ error: "invalid_dev_login_payload" });
      return;
    }

    const existing = await db()("users").where({ discord_id: discordId }).first();
    if (existing) {
      await db()("users").where({ discord_id: discordId }).update({ username });
    } else {
      await db()("users").insert({ discord_id: discordId, username, global_role: "user" });
    }

    const sid = await createSession(discordId, cfg.session.maxAgeSeconds);
    setSessionCookie(res, cfg, sid);
    res.status(204).end();
  });

  return router;
}
