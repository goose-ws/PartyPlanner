import { Router } from "express";
import { db } from "../db/index.js";
import { requireCampaignRole } from "../middleware/authz.js";
import { getCandidateDates } from "../scheduling/candidateEngine.js";
import {
  lockSessionDate,
  cancelSession,
  cancelBlock,
  rescheduleSession,
  skipBlock,
  backfillSession,
  listSessions,
  markAbsent,
  clearAbsence,
  updateSessionNotes,
} from "../scheduling/sessionLifecycle.js";
import type { AppConfig } from "../types/config.js";
import { buildSessionIcs } from "../scheduling/ics.js";
import { resolveCampaignParam } from "../middleware/resolveCampaign.js";
import { composeStageReminder, composeDayOfReminder, getOpenBlocks } from "../scheduling/reminders.js";
import { getBlockConfirmationStatus, confirmBlock, unconfirmBlock } from "../scheduling/blockConfirmations.js";
import { sendDiscordMessage } from "../discord/webhook.js";
import { logAudit } from "../audit.js";

export function schedulingRouter(cfg: AppConfig): Router {
  const router = Router();
  router.param("campaignId", resolveCampaignParam);

  router.get("/campaigns/:campaignId/sessions/:sessionId/calendar.ics", requireCampaignRole(["DM", "Player"]), async (req, res) => {
    const session = await db()("sessions")
      .where({ id: req.params.sessionId, campaign_id: req.params.campaignId })
      .first();
    if (!session || (session.status !== "scheduled" && session.status !== "completed")) {
      res.status(404).json({ error: "session_not_found_or_not_locked" });
      return;
    }
    const campaign = await db()("campaigns").where({ id: req.params.campaignId }).first();

    const ics = buildSessionIcs({
      sessionId: session.id,
      campaignName: campaign.name,
      sessionNumber: session.session_number,
      scheduledStartUtc: session.scheduled_start_utc,
      scheduledEndUtc: session.scheduled_end_utc,
    });

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="session-${session.session_number ?? session.id}.ics"`);
    res.send(ics);
  });

  router.get("/campaigns/:campaignId/candidates", requireCampaignRole(["DM", "Player"]), async (req, res) => {
    const months = Number(req.query.months) || cfg.scheduling.defaultWindowMonths;
    try {
      const result = await getCandidateDates(req.params.campaignId!, months);
      res.json(result);
    } catch (err) {
      console.error("[scheduling] candidate generation failed:", err);
      res.status(500).json({ error: "candidate_generation_failed" });
    }
  });

  router.get("/campaigns/:campaignId/sessions", requireCampaignRole(["DM", "Player"]), async (req, res) => {
    const sessions = await listSessions(req.params.campaignId!);
    res.json({ sessions });
  });

  router.post("/campaigns/:campaignId/sessions/backfill", requireCampaignRole(["DM"]), async (req, res) => {
    const date = typeof req.body?.date === "string" ? req.body.date : null;
    const status = ["completed", "cancelled", "skipped"].includes(req.body?.status) ? req.body.status : "completed";
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "invalid_date" });
      return;
    }
    const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 255) : null;
    const absentDiscordIds = Array.isArray(req.body?.absentDiscordIds)
      ? req.body.absentDiscordIds.filter((x: unknown) => typeof x === "string")
      : [];

    try {
      const result = await backfillSession(req.params.campaignId!, { date, status, notes, absentDiscordIds }, req.user!.discordId);
      res.status(201).json(result);
    } catch (err: any) {
      console.error("[scheduling] backfill failed:", err);
      res.status(500).json({ error: "backfill_failed" });
    }
  });

  router.post("/campaigns/:campaignId/sessions/lock", requireCampaignRole(["DM"]), async (req, res) => {
    const date = typeof req.body?.date === "string" ? req.body.date : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "invalid_date" });
      return;
    }
    try {
      const session = await lockSessionDate(req.params.campaignId!, date, cfg.publicUrl!, req.user!.discordId);
      res.status(201).json(session);
    } catch (err) {
      console.error("[scheduling] lock failed:", err);
      res.status(500).json({ error: "lock_failed" });
    }
  });

  router.post("/campaigns/:campaignId/sessions/:sessionId/cancel", requireCampaignRole(["DM"]), async (req, res) => {
    try {
      await cancelSession(req.params.campaignId!, req.params.sessionId!, req.user!.discordId);
      res.status(204).end();
    } catch (err: any) {
      const msg = err?.message ?? "cancel_failed";
      res.status(msg === "session_not_found" ? 404 : 400).json({ error: msg });
    }
  });

  router.post("/campaigns/:campaignId/sessions/:sessionId/cancel-block", requireCampaignRole(["DM"]), async (req, res) => {
    const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 255) : null;
    try {
      await cancelBlock(req.params.campaignId!, req.params.sessionId!, notes, req.user!.discordId);
      res.status(204).end();
    } catch (err: any) {
      const msg = err?.message ?? "cancel_block_failed";
      res.status(msg === "session_not_found" ? 404 : 400).json({ error: msg });
    }
  });

  router.patch("/campaigns/:campaignId/sessions/:sessionId/reschedule", requireCampaignRole(["DM"]), async (req, res) => {
    const date = typeof req.body?.date === "string" ? req.body.date : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "invalid_date" });
      return;
    }
    try {
      await rescheduleSession(req.params.campaignId!, req.params.sessionId!, date, cfg.publicUrl!, req.user!.discordId);
      res.status(204).end();
    } catch (err: any) {
      const msg = err?.message ?? "reschedule_failed";
      const status = msg === "session_not_found" ? 404 : msg === "target_block_already_full" ? 409 : 400;
      res.status(status).json({ error: msg });
    }
  });

  // Edit notes on any already-locked/completed/skipped session — e.g. adding a
  // recap after the fact. Deliberately separate from reschedule/cancel so a DM
  // can amend notes without touching status or timing.
  router.patch("/campaigns/:campaignId/sessions/:sessionId/notes", requireCampaignRole(["DM"]), async (req, res) => {
    const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 255) : null;
    try {
      await updateSessionNotes(req.params.campaignId!, req.params.sessionId!, notes);
      res.status(204).end();
    } catch (err: any) {
      const msg = err?.message ?? "notes_update_failed";
      res.status(msg === "session_not_found" ? 404 : 400).json({ error: msg });
    }
  });

  router.post("/campaigns/:campaignId/blocks/skip", requireCampaignRole(["DM"]), async (req, res) => {
    const date = typeof req.body?.date === "string" ? req.body.date : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "invalid_date" });
      return;
    }
    const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 255) : null;
    try {
      const block = await skipBlock(req.params.campaignId!, date, notes, req.user!.discordId);
      res.status(201).json(block);
    } catch (err) {
      console.error("[scheduling] skip failed:", err);
      res.status(500).json({ error: "skip_failed" });
    }
  });

  router.post(
    "/campaigns/:campaignId/sessions/:sessionId/absences",
    requireCampaignRole(["DM"]),
    async (req, res) => {
      const discordId = typeof req.body?.discordId === "string" ? req.body.discordId : null;
      if (!discordId) {
        res.status(400).json({ error: "discordId_required" });
        return;
      }
      const excused = req.body?.excused !== false;
      try {
        await markAbsent(req.params.campaignId!, req.params.sessionId!, discordId, excused);
        res.status(204).end();
      } catch (err: any) {
        res.status(err?.message === "session_not_found" ? 404 : 500).json({ error: err?.message ?? "mark_absent_failed" });
      }
    }
  );

  router.delete(
    "/campaigns/:campaignId/sessions/:sessionId/absences/:discordId",
    requireCampaignRole(["DM"]),
    async (req, res) => {
      try {
        await clearAbsence(req.params.campaignId!, req.params.sessionId!, req.params.discordId!);
        res.status(204).end();
      } catch (err: any) {
        res.status(err?.message === "session_not_found" ? 404 : 500).json({ error: err?.message ?? "clear_absence_failed" });
      }
    }
  );

  /**
   * The open blocks players can currently confirm — up to
   * campaign.confirm_ahead_sessions of them, not just the immediate next
   * one — plus per-member confirmation status for each. Powers the
   * Schedule tab's check-in card(s) and the DM's "3/5 confirmed" indicator.
   */
  router.get("/campaigns/:campaignId/block-status", requireCampaignRole(["DM", "Player"]), async (req, res) => {
    const campaign = await db()("campaigns").where({ id: req.params.campaignId }).first();
    const blocks = await getOpenBlocks(req.params.campaignId!, campaign?.confirm_ahead_sessions ?? 1);
    const results = await Promise.all(
      blocks.map(async (block) => {
        const confirmations = await getBlockConfirmationStatus(req.params.campaignId!, block);
        return { block, confirmations, youConfirmed: !!confirmations[req.user!.discordId] };
      })
    );
    res.json({ blocks: results });
  });

  /** Self-service confirm/unconfirm — anyone in the campaign confirms for themselves, no DM gate needed. `blockStart` must be one of the currently-open confirmable blocks. */
  router.put("/campaigns/:campaignId/block-status/me", requireCampaignRole(["DM", "Player"]), async (req, res) => {
    const campaign = await db()("campaigns").where({ id: req.params.campaignId }).first();
    const blocks = await getOpenBlocks(req.params.campaignId!, campaign?.confirm_ahead_sessions ?? 1);
    const block = blocks.find((b) => b.start === req.body?.blockStart);
    if (!block) {
      res.status(409).json({ error: "block_not_open_for_confirmation" });
      return;
    }
    if (req.body?.confirmed === false) {
      await unconfirmBlock(req.params.campaignId!, req.user!.discordId, block.start);
      await logAudit("block.unconfirmed", { campaignId: req.params.campaignId, actorDiscordId: req.user!.discordId, detail: { blockStart: block.start } });
    } else {
      await confirmBlock(req.params.campaignId!, req.user!.discordId, block.start);
      await logAudit("block.confirmed", { campaignId: req.params.campaignId, actorDiscordId: req.user!.discordId, detail: { blockStart: block.start } });
    }
    res.status(204).end();
  });

  /**
   * DM/root override — confirms or unconfirms someone ELSE's block, e.g.
   * for a player who confirmed out-of-band (in person, over voice) but
   * hasn't touched the app, or to force a re-confirm from someone the DM
   * doesn't trust to have actually checked. Bypasses the normal
   * self-service-only rule; unlike the auto-invalidation on availability
   * edits, this is a deliberate manual action and is never triggered
   * silently.
   */
  router.put(
    "/campaigns/:campaignId/block-status/:discordId",
    requireCampaignRole(["DM"]),
    async (req, res) => {
      const membership = await db()("campaign_members")
        .where({ campaign_id: req.params.campaignId, discord_id: req.params.discordId })
        .first();
      if (!membership) {
        res.status(404).json({ error: "membership_not_found" });
        return;
      }
      const campaign = await db()("campaigns").where({ id: req.params.campaignId }).first();
      const blocks = await getOpenBlocks(req.params.campaignId!, campaign?.confirm_ahead_sessions ?? 1);
      const block = blocks.find((b) => b.start === req.body?.blockStart);
      if (!block) {
        res.status(409).json({ error: "block_not_open_for_confirmation" });
        return;
      }
      if (req.body?.confirmed === false) {
        await unconfirmBlock(req.params.campaignId!, req.params.discordId!, block.start);
        await logAudit("block.unconfirmed_by_manager", {
          campaignId: req.params.campaignId,
          actorDiscordId: req.user!.discordId,
          detail: { targetDiscordId: req.params.discordId, blockStart: block.start },
        });
      } else {
        await confirmBlock(req.params.campaignId!, req.params.discordId!, block.start);
        await logAudit("block.confirmed_by_manager", {
          campaignId: req.params.campaignId,
          actorDiscordId: req.user!.discordId,
          detail: { targetDiscordId: req.params.discordId, blockStart: block.start },
        });
      }
      res.status(204).end();
    }
  );

  router.post("/campaigns/:campaignId/reminders/test", requireCampaignRole(["DM"]), async (req, res) => {
    const campaignId = req.params.campaignId!;
    const stage = req.body?.stage;
    if (!["advance", "final", "dayof"].includes(stage)) {
      res.status(400).json({ error: "stage_must_be_advance_final_or_dayof" });
      return;
    }

    const campaign = await db()("campaigns").where({ id: campaignId }).first();
    if (!campaign) {
      res.status(404).json({ error: "campaign_not_found" });
      return;
    }
    if (!campaign.discord_webhook_url) {
      res.status(400).json({ error: "no_webhook_configured" });
      return;
    }

    if (stage === "dayof") {
      const composed = await composeDayOfReminder(campaignId);
      if (!composed.ok) {
        res.status(422).json({ error: composed.reason });
        return;
      }
      if (!composed.content) {
        // Valid state, but nothing to say (e.g. everyone's already responded) — still useful info, not an error.
        res.json({ sent: false, content: null, reason: "nothing_to_report" });
        return;
      }
      // Day-of reminders are meant to only highlight (not ping) via an embed —
      // sending the test as plain `content` instead would turn every @mention
      // in the roster into a real notification, which isn't what "test" should do.
      const result = await sendDiscordMessage(campaign.discord_webhook_url, {
        embeds: [{ title: "🧪 TEST — not a real reminder", description: composed.content, color: 0xc08a2e }],
      });
      await logAudit("webhook.test_sent", { campaignId, actorDiscordId: req.user!.discordId, detail: { stage } });
      res.json({ sent: result.ok, content: composed.content });
      return;
    }

    const composed = await composeStageReminder(cfg, campaignId, stage === "final" ? 2 : 1);
    if (!composed.ok) {
      res.status(422).json({ error: composed.reason });
      return;
    }
    // One real message per unconfirmed member. Sending every one of those
    // as a "test" would spam the channel and ping everyone for real, so
    // only post one representative sample — but show all of them in the
    // preview text so the DM can review exactly what each person would
    // receive before it goes out for real.
    if (composed.messages.length === 0) {
      res.json({ sent: false, content: null, reason: "nothing_to_report" });
      return;
    }
    const preview = composed.messages.map((m) => `— for ${m.username} —\n${m.content}`).join("\n\n");
    const sample = composed.messages[0]!;
    const result = await sendDiscordMessage(campaign.discord_webhook_url, {
      content:
        `🧪 **TEST** (not a real reminder) — sample for ${sample.username}, ${composed.messages.length} total would go out individually:\n${sample.content}`,
    });
    await logAudit("webhook.test_sent", { campaignId, actorDiscordId: req.user!.discordId, detail: { stage } });
    res.json({ sent: result.ok, content: preview });
  });

  router.get("/campaigns/:campaignId/stats", requireCampaignRole(["DM", "Player"]), async (req, res) => {
    const campaignId = req.params.campaignId!;

    const attendance = await db()("campaign_members as cm")
      .join("users as u", "u.discord_id", "cm.discord_id")
      .leftJoin("sessions as s", function () {
        this.on("s.campaign_id", "=", "cm.campaign_id").andOnVal("s.status", "=", "completed");
      })
      .leftJoin("session_absences as sa", function () {
        this.on("sa.session_id", "=", "s.id").andOn("sa.discord_id", "=", "cm.discord_id");
      })
      .where("cm.campaign_id", campaignId)
      .groupBy("cm.discord_id", "u.username", "u.global_name")
      .select(
        "cm.discord_id",
        db().raw("COALESCE(u.global_name, u.username) as username"),
        db().raw("COUNT(DISTINCT s.id) AS total_sessions"),
        db().raw("COUNT(DISTINCT sa.session_id) AS total_absences")
      );

    const campaign = await db()("campaigns").where({ id: campaignId }).first();
    const counts = await db()("sessions")
      .where({ campaign_id: campaignId })
      .select("status")
      .count("* as count")
      .groupBy("status");

    res.json({
      attendance: attendance.map((row: any) => {
        const total = Number(row.total_sessions);
        const absences = Number(row.total_absences);
        return {
          discordId: row.discord_id,
          username: row.username,
          totalSessions: total,
          totalAbsences: absences,
          attendanceRate: total > 0 ? Math.round(((total - absences) / total) * 1000) / 10 : null,
        };
      }),
      sessionCounts: Object.fromEntries(counts.map((c: any) => [c.status, Number(c.count)])),
      campaignAgeDays: Math.floor((Date.now() - new Date(campaign.created_at).getTime()) / 86_400_000),
    });
  });

  return router;
}
