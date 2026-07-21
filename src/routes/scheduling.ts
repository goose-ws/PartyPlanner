import { Router } from "express";
import { db } from "../db/index.js";
import { requireCampaignRole } from "../middleware/authz.js";
import { getCandidateDates } from "../scheduling/candidateEngine.js";
import {
  lockSessionDate,
  cancelSession,
  rescheduleSession,
  skipBlock,
  listSessions,
  markAbsent,
  clearAbsence,
} from "../scheduling/sessionLifecycle.js";
import type { AppConfig } from "../types/config.js";
import { buildSessionIcs } from "../scheduling/ics.js";
import { resolveCampaignParam } from "../middleware/resolveCampaign.js";

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

  router.post("/campaigns/:campaignId/sessions/lock", requireCampaignRole(["DM"]), async (req, res) => {
    const date = typeof req.body?.date === "string" ? req.body.date : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "invalid_date" });
      return;
    }
    try {
      const session = await lockSessionDate(req.params.campaignId!, date, cfg.publicUrl);
      res.status(201).json(session);
    } catch (err) {
      console.error("[scheduling] lock failed:", err);
      res.status(500).json({ error: "lock_failed" });
    }
  });

  router.post("/campaigns/:campaignId/sessions/:sessionId/cancel", requireCampaignRole(["DM"]), async (req, res) => {
    try {
      await cancelSession(req.params.campaignId!, req.params.sessionId!);
      res.status(204).end();
    } catch (err: any) {
      const msg = err?.message ?? "cancel_failed";
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
      await rescheduleSession(req.params.campaignId!, req.params.sessionId!, date, cfg.publicUrl);
      res.status(204).end();
    } catch (err: any) {
      const msg = err?.message ?? "reschedule_failed";
      const status = msg === "session_not_found" ? 404 : msg === "target_block_already_full" ? 409 : 400;
      res.status(status).json({ error: msg });
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
      const block = await skipBlock(req.params.campaignId!, date, notes);
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
      await markAbsent(req.params.sessionId!, discordId, excused);
      res.status(204).end();
    }
  );

  router.delete(
    "/campaigns/:campaignId/sessions/:sessionId/absences/:discordId",
    requireCampaignRole(["DM"]),
    async (req, res) => {
      await clearAbsence(req.params.sessionId!, req.params.discordId!);
      res.status(204).end();
    }
  );

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
      .groupBy("cm.discord_id", "u.username")
      .select(
        "cm.discord_id",
        "u.username",
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
