import type { Request, Response, NextFunction } from "express";
import { db } from "../db/index.js";

/**
 * Registered via router.param("campaignId", ...) on EACH router that has
 * :campaignId routes (not once at the app level) — Express 4 param
 * callbacks are local to the router they're registered on and don't
 * propagate into separately-mounted sub-routers. An app-level app.use(path,
 * fn) middleware doesn't work for this either: it re-derives req.params
 * fresh at each independently-matched router layer, so a mutation made
 * there doesn't survive into the next router's own route matching (both
 * failure modes verified directly before landing on this approach).
 *
 * Accepts either the campaign's real UUID or its slug, resolves it once,
 * and rewrites req.params.campaignId to the real ID — every route handler
 * and authz check downstream needs zero changes either way.
 */
export function resolveCampaignParam(req: Request, res: Response, next: NextFunction, value: string) {
  db()("campaigns")
    .where({ id: value })
    .orWhere({ slug: value })
    .first()
    .then((campaign) => {
      if (!campaign) {
        res.status(404).json({ error: "campaign_not_found" });
        return;
      }
      req.params.campaignId = campaign.id;
      next();
    })
    .catch(next);
}
