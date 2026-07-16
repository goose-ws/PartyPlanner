import { Router } from "express";
import crypto from "node:crypto";
import { db } from "../db/index.js";
import { requireRoot, requireAuth } from "../middleware/authz.js";

export function campaignsRouter(): Router {
  const router = Router();

  // Only root creates campaigns — DMs are assigned to existing campaigns, per the ACL.
  router.post("/campaigns", requireRoot, async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const startDate = typeof req.body?.startDate === "string" ? req.body.startDate : null;
    if (!name || !startDate) {
      res.status(400).json({ error: "name_and_startDate_required" });
      return;
    }

    const id = crypto.randomUUID();
    await db()("campaigns").insert({
      id,
      name,
      start_date: startDate,
      cadence_type: req.body?.cadenceType ?? "bi-weekly",
      interval_weeks: req.body?.intervalWeeks ?? 2,
      sessions_per_interval: req.body?.sessionsPerInterval ?? 1,
      blackout_days_after_lock: req.body?.blackoutDaysAfterLock ?? 7,
      granularity: req.body?.granularity ?? "hourly",
    });

    res.status(201).json({ id, name, startDate });
  });

  // Lists campaigns the caller belongs to (root sees all).
  router.get("/campaigns", requireAuth, async (req, res) => {
    if (req.user!.globalRole === "root") {
      const campaigns = await db()("campaigns").select("*");
      res.json({ campaigns });
      return;
    }
    const campaigns = await db()("campaigns")
      .join("campaign_members", "campaign_members.campaign_id", "campaigns.id")
      .where("campaign_members.discord_id", req.user!.discordId)
      .select("campaigns.*", "campaign_members.role as myRole");
    res.json({ campaigns });
  });

  return router;
}
