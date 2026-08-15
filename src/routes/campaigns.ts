import { Router } from "express";
import crypto from "node:crypto";
import { db } from "../db/index.js";
import { requireRoot, requireAuth } from "../middleware/authz.js";
import { requireCampaignRole } from "../middleware/authz.js";
import { generateUniqueSlug } from "../scheduling/slug.js";
import { resolveCampaignParam } from "../middleware/resolveCampaign.js";
import { logAudit } from "../audit.js";

/** The webhook URL is a bearer credential — anyone holding it can post into that Discord channel — so it's never sent to non-root callers. */
function redactWebhook<T extends Record<string, any>>(campaign: T, isRoot: boolean): T {
  if (isRoot) return campaign;
  const { discord_webhook_url, ...rest } = campaign;
  return rest as T;
}

export function campaignsRouter(): Router {
  const router = Router();
  router.param("campaignId", resolveCampaignParam);

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
    const slug = await generateUniqueSlug(name);
    await db()("campaigns").insert({
      id,
      slug,
      name,
      start_date: startDate,
      cadence_type: req.body?.cadenceType ?? "bi-weekly",
      interval_weeks: req.body?.intervalWeeks ?? 2,
      sessions_per_interval: req.body?.sessionsPerInterval ?? 1,
      blackout_days_after_lock: req.body?.blackoutDaysAfterLock ?? 7,
      min_players_required: req.body?.minPlayersRequired ?? 0,
      confirm_ahead_sessions: req.body?.confirmAheadSessions ?? 1,
      granularity: req.body?.granularity ?? "hourly",
      session_time_start: `${sessionTimeStart}:00`,
      session_time_end: `${sessionTimeEnd}:00`,
      timezone,
    });

    const campaign = await db()("campaigns").where({ id }).first();
    await logAudit("campaign.created", { campaignId: id, actorDiscordId: req.user!.discordId, detail: { name, startDate } });
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
    if (req.body?.minPlayersRequired !== undefined) {
      if (!Number.isInteger(req.body.minPlayersRequired) || req.body.minPlayersRequired < 0) {
        res.status(400).json({ error: "invalid_minPlayersRequired" });
        return;
      }
      updates.min_players_required = req.body.minPlayersRequired;
    }
    // Extra weight (+/-) applied only to the DM's own contribution for a
    // raw "Maybe"/"If Needed" response — any finite number is valid,
    // since a table might reasonably want to boost or discount it either way.
    if (req.body?.dmMaybeModifier !== undefined) {
      if (typeof req.body.dmMaybeModifier !== "number" || !Number.isFinite(req.body.dmMaybeModifier)) {
        res.status(400).json({ error: "invalid_dmMaybeModifier" });
        return;
      }
      updates.dm_maybe_modifier = req.body.dmMaybeModifier;
    }
    if (req.body?.dmIfNeededModifier !== undefined) {
      if (typeof req.body.dmIfNeededModifier !== "number" || !Number.isFinite(req.body.dmIfNeededModifier)) {
        res.status(400).json({ error: "invalid_dmIfNeededModifier" });
        return;
      }
      updates.dm_if_needed_modifier = req.body.dmIfNeededModifier;
    }
    // Deducted per active joining-late/dropping-early flag (score floored
    // at 0 overall) — kept non-negative since it's framed as a penalty.
    if (req.body?.lateEarlyPenalty !== undefined) {
      if (typeof req.body.lateEarlyPenalty !== "number" || !Number.isFinite(req.body.lateEarlyPenalty) || req.body.lateEarlyPenalty < 0) {
        res.status(400).json({ error: "invalid_lateEarlyPenalty" });
        return;
      }
      updates.late_early_penalty = req.body.lateEarlyPenalty;
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
    if (req.body?.reminderTimeOfDay !== undefined) {
      if (!/^\d{2}:\d{2}$/.test(req.body.reminderTimeOfDay)) {
        res.status(400).json({ error: "reminderTimeOfDay_must_be_HH_MM" });
        return;
      }
      updates.reminder_time_of_day = `${req.body.reminderTimeOfDay}:00`;
    }
    if (req.body?.reminderAdvanceEnabled !== undefined) updates.reminder_advance_enabled = !!req.body.reminderAdvanceEnabled;
    if (req.body?.reminderFinalEnabled !== undefined) updates.reminder_final_enabled = !!req.body.reminderFinalEnabled;
    if (req.body?.reminderDayofEnabled !== undefined) updates.reminder_dayof_enabled = !!req.body.reminderDayofEnabled;
    if (req.body?.reminderLockWarningDays !== undefined) {
      if (!Number.isInteger(req.body.reminderLockWarningDays) || req.body.reminderLockWarningDays < 0) {
        res.status(400).json({ error: "invalid_reminderLockWarningDays" });
        return;
      }
      updates.reminder_lock_warning_days = req.body.reminderLockWarningDays;
    }
    if (req.body?.reminderLockWarningEnabled !== undefined)
      updates.reminder_lock_warning_enabled = !!req.body.reminderLockWarningEnabled;
    if (req.body?.confirmAheadSessions !== undefined) {
      if (!Number.isInteger(req.body.confirmAheadSessions) || req.body.confirmAheadSessions < 1) {
        res.status(400).json({ error: "invalid_confirmAheadSessions" });
        return;
      }
      updates.confirm_ahead_sessions = req.body.confirmAheadSessions;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "no_updatable_fields_provided" });
      return;
    }

    await db()("campaigns").where({ id: req.params.campaignId }).update(updates);
    const updated = await db()("campaigns").where({ id: req.params.campaignId }).first();
    await logAudit("campaign.settings_updated", { campaignId: req.params.campaignId, actorDiscordId: req.user!.discordId, detail: updates });
    res.json(updated);
  });

  // Lists campaigns the caller belongs to (root sees all, plus their own
  // myRole for any campaign they've actually joined via /join).
  router.get("/campaigns", requireAuth, async (req, res) => {
    const isRoot = req.user!.globalRole === "root";
    if (isRoot) {
      const campaigns = await db()("campaigns")
        .leftJoin("campaign_members", function () {
          this.on("campaign_members.campaign_id", "=", "campaigns.id").andOnVal(
            "campaign_members.discord_id",
            "=",
            req.user!.discordId
          );
        })
        .select("campaigns.*", "campaign_members.role as myRole");
      res.json({ campaigns });
      return;
    }
    const campaigns = await db()("campaigns")
      .join("campaign_members", "campaign_members.campaign_id", "campaigns.id")
      .where("campaign_members.discord_id", req.user!.discordId)
      .select("campaigns.*", "campaign_members.role as myRole");
    res.json({ campaigns: campaigns.map((c) => redactWebhook(c, isRoot)) });
  });

  // Single campaign — root or any member of it. Root always has access
  // regardless of membership, but myRole still reflects real membership
  // (if any) rather than always being blank.
  router.get("/campaigns/:campaignId", requireAuth, async (req, res) => {
    const campaign = await db()("campaigns").where({ id: req.params.campaignId }).first();
    if (!campaign) {
      res.status(404).json({ error: "campaign_not_found" });
      return;
    }

    const membership = await db()("campaign_members")
      .where({ campaign_id: campaign.id, discord_id: req.user!.discordId })
      .first();

    if (req.user!.globalRole === "root") {
      res.json({ campaign: membership ? { ...campaign, myRole: membership.role } : campaign });
      return;
    }

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

    const result = await db().transaction(async (trx) => {
      const updated = await trx("campaign_members")
        .where({ campaign_id: req.params.campaignId, discord_id: req.params.discordId })
        .update({ role });
      if (!updated) return null;

      // Only one DM per campaign — promoting a new one demotes whoever
      // currently holds it (if anyone) to Player, in the same transaction.
      let demoted: string | null = null;
      if (role === "DM") {
        const priorDm = await trx("campaign_members")
          .where({ campaign_id: req.params.campaignId, role: "DM" })
          .whereNot({ discord_id: req.params.discordId })
          .first();
        if (priorDm) {
          await trx("campaign_members")
            .where({ campaign_id: req.params.campaignId, discord_id: priorDm.discord_id })
            .update({ role: "Player" });
          demoted = priorDm.discord_id;
        }
      }
      return { demoted };
    });

    if (!result) {
      res.status(404).json({ error: "membership_not_found" });
      return;
    }
    await logAudit("member.role_changed", {
      campaignId: req.params.campaignId,
      actorDiscordId: req.user!.discordId,
      detail: { targetDiscordId: req.params.discordId, role, demotedDiscordId: result.demoted },
    });
    res.json({ campaignId: req.params.campaignId, discordId: req.params.discordId, role, demotedDiscordId: result.demoted });
  });

  // DM or root: toggle whether a member's availability is ignored by the
  // scoring engine entirely (score sum, DM veto, and the min-players
  // headcount). Unlike role changes, this is a DM-level action, not
  // root-only — it's meant for a DM to manage a flaky player on their own
  // table without needing root involved every time.
  router.patch(
    "/campaigns/:campaignId/members/:discordId/exclusion",
    requireCampaignRole(["DM"]),
    async (req, res) => {
      const excluded = !!req.body?.excludedFromScoring;
      const updated = await db()("campaign_members")
        .where({ campaign_id: req.params.campaignId, discord_id: req.params.discordId })
        .update({ excluded_from_scoring: excluded });
      if (!updated) {
        res.status(404).json({ error: "membership_not_found" });
        return;
      }
      await logAudit("member.exclusion_toggled", {
        campaignId: req.params.campaignId,
        actorDiscordId: req.user!.discordId,
        detail: { targetDiscordId: req.params.discordId, excludedFromScoring: excluded },
      });
      res.json({ campaignId: req.params.campaignId, discordId: req.params.discordId, excludedFromScoring: excluded });
    }
  );

  // Remove a member from the campaign. Root can remove anyone; a DM can
  // only remove Players (not another DM) — same trust boundary as invites,
  // where a DM can hand out Player invites but only root mints a DM one.
  router.delete("/campaigns/:campaignId/members/:discordId", requireCampaignRole(["DM"]), async (req, res) => {
    const target = await db()("campaign_members")
      .where({ campaign_id: req.params.campaignId, discord_id: req.params.discordId })
      .first();
    if (!target) {
      res.status(404).json({ error: "membership_not_found" });
      return;
    }

    if (target.role === "DM" && req.user!.globalRole !== "root") {
      res.status(403).json({ error: "only_root_can_remove_a_dm" });
      return;
    }

    await db()("campaign_members")
      .where({ campaign_id: req.params.campaignId, discord_id: req.params.discordId })
      .delete();
    await logAudit("member.removed", {
      campaignId: req.params.campaignId,
      actorDiscordId: req.user!.discordId,
      detail: { targetDiscordId: req.params.discordId, targetRole: target.role },
    });
    res.status(204).end();
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

    const rows = await db()("campaign_members")
      .join("users", "users.discord_id", "campaign_members.discord_id")
      .where("campaign_members.campaign_id", req.params.campaignId)
      .select(
        "users.discord_id",
        db().raw("COALESCE(users.global_name, users.username) as username"),
        "campaign_members.role",
        "campaign_members.excluded_from_scoring"
      );
    res.json({
      members: rows.map((m) => ({
        discord_id: m.discord_id,
        username: m.username,
        role: m.role,
        excluded_from_scoring: !!m.excluded_from_scoring,
      })),
    });
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
