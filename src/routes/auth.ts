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
import { createSession } from "../auth/sessionStore.js";
import { setSessionCookie, clearSessionCookie } from "../middleware/session.js";
import { redeemInvite } from "./invites.js";

const OAUTH_STATE_COOKIE = "pp_oauth_state";
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes — just long enough to complete the Discord redirect dance

interface OAuthStatePayload {
  state: string;
  invite: string | null;
}

export function authRouter(cfg: AppConfig): Router {
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

      let redirectPath = "/";
      if (statePayload.invite) {
        const result = await redeemInvite(statePayload.invite, discordUser.id);
        if (result.ok) {
          redirectPath = `/campaigns/${result.campaignId}`;
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

  router.post("/logout", async (req, res) => {
    const sid = req.signedCookies?.[cfg.session.cookieName];
    if (sid) {
      const { destroySession } = await import("../auth/sessionStore.js");
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

  return router;
}
