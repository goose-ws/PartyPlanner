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

  // Single campaign — root or any member of it.
  router.get("/campaigns/:campaignId", requireAuth, async (req, res) => {
    const campaign = await db()("campaigns").where({ id: req.params.campaignId }).first();
    if (!campaign) {
      res.status(404).json({ error: "campaign_not_found" });
      return;
    }

    if (req.user!.globalRole === "root") {
      res.json({ campaign });
      return;
    }

    const membership = await db()("campaign_members")
      .where({ campaign_id: campaign.id, discord_id: req.user!.discordId })
      .first();
    if (!membership) {
      res.status(403).json({ error: "not_a_campaign_member" });
      return;
    }

    res.json({ campaign: { ...campaign, myRole: membership.role } });
  });

  // Root-only: change an existing member's role (e.g. Player -> DM after
  // the wrong invite link was used). Not exposed to DMs — the ACL only
  // grants root the authority to (re)assign roles.
  router.patch("/campaigns/:campaignId/members/:discordId", requireRoot, async (req, res) => {
    const role = req.body?.role === "DM" ? "DM" : req.body?.role === "Player" ? "Player" : null;
    if (!role) {
      res.status(400).json({ error: "role_must_be_DM_or_Player" });
      return;
    }

    const updated = await db()("campaign_members")
      .where({ campaign_id: req.params.campaignId, discord_id: req.params.discordId })
      .update({ role });

    if (!updated) {
      res.status(404).json({ error: "membership_not_found" });
      return;
    }
    res.json({ campaignId: req.params.campaignId, discordId: req.params.discordId, role });
  });

  // Lists members of a campaign — root or any member of it. Used by the
  // frontend to let root re-assign roles.
  router.get("/campaigns/:campaignId/members", requireAuth, async (req, res) => {
    const campaign = await db()("campaigns").where({ id: req.params.campaignId }).first();
    if (!campaign) {
      res.status(404).json({ error: "campaign_not_found" });
      return;
    }
    if (req.user!.globalRole !== "root") {
      const membership = await db()("campaign_members")
        .where({ campaign_id: campaign.id, discord_id: req.user!.discordId })
        .first();
      if (!membership) {
        res.status(403).json({ error: "not_a_campaign_member" });
        return;
      }
    }

    const members = await db()("campaign_members")
      .join("users", "users.discord_id", "campaign_members.discord_id")
      .where("campaign_members.campaign_id", req.params.campaignId)
      .select("users.discord_id", "users.username", "campaign_members.role");
    res.json({ members });
  });

  return router;
}
