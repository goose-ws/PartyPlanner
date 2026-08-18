import type { Request, Response, NextFunction } from "express";
import { db } from "../db/index.js";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }
  next();
}

export function requireRoot(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }
  if (req.user.globalRole !== "root") {
    res.status(403).json({ error: "root_required" });
    return;
  }
  next();
}

/**
 * Requires the caller to be either global root, OR hold one of `roles`
 * within the campaign identified by req.params[campaignIdParam].
 * Root always passes — root can act as DM or Player anywhere.
 */
export function requireCampaignRole(roles: Array<"DM" | "Player">, campaignIdParam = "campaignId") {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    if (req.user.globalRole === "root") {
      next();
      return;
    }

    const campaignId = req.params[campaignIdParam];
    const membership = await db()("campaign_members")
      .where({ campaign_id: campaignId, discord_id: req.user.discordId })
      .first();

    if (!membership || !roles.includes(membership.role)) {
      res.status(403).json({ error: "insufficient_campaign_role", required: roles });
      return;
    }
    next();
  };
}
