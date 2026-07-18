import { Router } from "express";
import crypto from "node:crypto";
import { db } from "../db/index.js";
import { requireRoot, requireAuth } from "../middleware/authz.js";

/** The webhook URL is a bearer credential — anyone holding it can post into that Discord channel — so it's never sent to non-root callers. */
function redactWebhook<T extends Record<string, any>>(campaign: T, isRoot: boolean): T {
  if (isRoot) return campaign;
  const { discord_webhook_url, ...rest } = campaign;
  return rest as T;
}

export function campaignsRouter(): Router {
  const router = Router();

  // Only root creates campaigns — DMs are assigned to existing campaigns, per the ACL.
  router.post("/campaigns", requireRoot, async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const startDate = typeof req.body?.startDate === "string" ? req.body.startDate : null;
    const sessionTimeStart = typeof req.body?.sessionTimeStart === "string" ? req.body.sessionTimeStart : "19:00";
    const sessionTimeEnd = typeof req.body?.sessionTimeEnd === "string" ? req.body.sessionTimeEnd : "23:00";
    const timezone = typeof req.body?.timezone === "string" ? req.body.timezone : "America/New_York";

    if (!name || !startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      res.status(400).json({ error: "name_and_startDate_required" });
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(sessionTimeStart) || !/^\d{2}:\d{2}$/.test(sessionTimeEnd)) {
      res.status(400).json({ error: "session_times_must_be_HH_MM" });
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
      session_time_start: `${sessionTimeStart}:00`,
      session_time_end: `${sessionTimeEnd}:00`,
      timezone,
    });

    const campaign = await db()("campaigns").where({ id }).first();
    res.status(201).json(campaign);
  });

  // Root-only: update campaign settings. `start_date` (the cadence anchor)
  // is deliberately NOT editable here — once sessions exist, moving the
  // anchor would silently reshuffle which block every past/future date
  // belongs to. If that's ever really needed, it warrants a dedicated,
  // carefully-considered operation, not a quick field edit.
  router.patch("/campaigns/:campaignId", requireRoot, async (req, res) => {
    const campaign = await db()("campaigns").where({ id: req.params.campaignId }).first();
    if (!campaign) {
      res.status(404).json({ error: "campaign_not_found" });
      return;
    }

    const updates: Record<string, unknown> = {};

    if (req.body?.name !== undefined) {
      const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
      if (!name) {
        res.status(400).json({ error: "name_cannot_be_empty" });
        return;
      }
      updates.name = name;
    }

    if (req.body?.sessionTimeStart !== undefined || req.body?.sessionTimeEnd !== undefined) {
      const start = req.body?.sessionTimeStart;
      const end = req.body?.sessionTimeEnd;
      if (
        (start !== undefined && !/^\d{2}:\d{2}$/.test(start)) ||
        (end !== undefined && !/^\d{2}:\d{2}$/.test(end))
      ) {
        res.status(400).json({ error: "session_times_must_be_HH_MM" });
        return;
      }
      if (start !== undefined) updates.session_time_start = `${start}:00`;
      if (end !== undefined) updates.session_time_end = `${end}:00`;
    }

    if (req.body?.timezone !== undefined) {
      if (typeof req.body.timezone !== "string" || !req.body.timezone) {
        res.status(400).json({ error: "invalid_timezone" });
        return;
      }
      updates.timezone = req.body.timezone;
    }

    if (req.body?.cadenceType !== undefined) {
      if (!["bi-weekly", "custom_interval", "weekly_static"].includes(req.body.cadenceType)) {
        res.status(400).json({ error: "invalid_cadenceType" });
        return;
      }
      updates.cadence_type = req.body.cadenceType;
    }
    if (req.body?.intervalWeeks !== undefined) {
      if (!Number.isInteger(req.body.intervalWeeks) || req.body.intervalWeeks < 1) {
        res.status(400).json({ error: "invalid_intervalWeeks" });
        return;
      }
      updates.interval_weeks = req.body.intervalWeeks;
    }
    if (req.body?.sessionsPerInterval !== undefined) {
      if (!Number.isInteger(req.body.sessionsPerInterval) || req.body.sessionsPerInterval < 1) {
        res.status(400).json({ error: "invalid_sessionsPerInterval" });
        return;
      }
      updates.sessions_per_interval = req.body.sessionsPerInterval;
    }
    if (req.body?.blackoutDaysAfterLock !== undefined) {
      if (!Number.isInteger(req.body.blackoutDaysAfterLock) || req.body.blackoutDaysAfterLock < 0) {
        res.status(400).json({ error: "invalid_blackoutDaysAfterLock" });
        return;
      }
      updates.blackout_days_after_lock = req.body.blackoutDaysAfterLock;
    }

    if (req.body?.discordWebhookUrl !== undefined) {
      const url = req.body.discordWebhookUrl;
      if (url !== null && (typeof url !== "string" || !/^https:\/\/discord\.com\/api\/webhooks\//.test(url))) {
        res.status(400).json({ error: "invalid_discord_webhook_url" });
        return;
      }
      updates.discord_webhook_url = url;
    }
    if (req.body?.reminderAdvanceDays !== undefined) {
      if (!Number.isInteger(req.body.reminderAdvanceDays) || req.body.reminderAdvanceDays < 0) {
        res.status(400).json({ error: "invalid_reminderAdvanceDays" });
        return;
      }
      updates.reminder_advance_days = req.body.reminderAdvanceDays;
    }
    if (req.body?.reminderFinalDays !== undefined) {
      if (!Number.isInteger(req.body.reminderFinalDays) || req.body.reminderFinalDays < 0) {
        res.status(400).json({ error: "invalid_reminderFinalDays" });
        return;
      }
      updates.reminder_final_days = req.body.reminderFinalDays;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "no_updatable_fields_provided" });
      return;
    }

    await db()("campaigns").where({ id: req.params.campaignId }).update(updates);
    const updated = await db()("campaigns").where({ id: req.params.campaignId }).first();
    res.json(updated);
  });

  // Lists campaigns the caller belongs to (root sees all).
  router.get("/campaigns", requireAuth, async (req, res) => {
    const isRoot = req.user!.globalRole === "root";
    if (isRoot) {
      const campaigns = await db()("campaigns").select("*");
      res.json({ campaigns });
      return;
    }
    const campaigns = await db()("campaigns")
      .join("campaign_members", "campaign_members.campaign_id", "campaigns.id")
      .where("campaign_members.discord_id", req.user!.discordId)
      .select("campaigns.*", "campaign_members.role as myRole");
    res.json({ campaigns: campaigns.map((c) => redactWebhook(c, isRoot)) });
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

    res.json({ campaign: redactWebhook({ ...campaign, myRole: membership.role }, false) });
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

  // Root-only: formally join a campaign as a member. Root can already view
  // and manage everything without this, but the scoring engine only counts
  // actual campaign_members — if root is also playing at this table, they
  // need a real membership row for their availability to factor into scores.
  router.post("/campaigns/:campaignId/join", requireRoot, async (req, res) => {
    const role = req.body?.role === "DM" ? "DM" : "Player";
    const campaign = await db()("campaigns").where({ id: req.params.campaignId }).first();
    if (!campaign) {
      res.status(404).json({ error: "campaign_not_found" });
      return;
    }
    await db()("campaign_members")
      .insert({ campaign_id: req.params.campaignId, discord_id: req.user!.discordId, role })
      .onConflict(["campaign_id", "discord_id"])
      .ignore();
    res.status(204).end();
  });

  return router;
}
