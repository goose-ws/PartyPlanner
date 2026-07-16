import type { Request, Response, NextFunction } from "express";
import { resolveSession } from "../auth/sessionStore.js";
import type { AppConfig } from "../types/config.js";

/**
 * Populates req.user from the signed session cookie, if present and valid.
 * Does NOT reject unauthenticated requests — that's the job of requireAuth
 * (see middleware/authz.ts) so public routes can still run this middleware
 * globally without side effects.
 */
export function sessionMiddleware(cfg: AppConfig) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const sid = req.signedCookies?.[cfg.session.cookieName];
    if (!sid) return next();

    try {
      const user = await resolveSession(sid, cfg.session.maxAgeSeconds);
      if (user) req.user = user;
    } catch (err) {
      console.error("[session] Failed to resolve session:", err);
    }
    next();
  };
}

export function setSessionCookie(res: Response, cfg: AppConfig, sid: string): void {
  res.cookie(cfg.session.cookieName, sid, {
    signed: true,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: cfg.session.maxAgeSeconds * 1000,
    path: "/",
  });
}

export function clearSessionCookie(res: Response, cfg: AppConfig): void {
  res.clearCookie(cfg.session.cookieName, { path: "/" });
}
