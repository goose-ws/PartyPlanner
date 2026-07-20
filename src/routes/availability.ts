import { Router } from "express";
import { db } from "../db/index.js";
import { requireCampaignRole } from "../middleware/authz.js";
import { resolveCampaignParam } from "../middleware/resolveCampaign.js";

const VALID_WEIGHTS = new Set([0, 1, 2, 3]);

/** Resolves who the caller is allowed to write availability for, per the ACL: everyone can edit their own; only DM/root can edit someone else's. */
async function resolveWritableTarget(
  campaignId: string,
  requesterId: string,
  requesterIsRoot: boolean,
  bodyDiscordId: unknown
): Promise<{ ok: true; targetId: string } | { ok: false; status: number; error: string }> {
  const targetId = typeof bodyDiscordId === "string" && bodyDiscordId ? bodyDiscordId : requesterId;
  if (targetId === requesterId) return { ok: true, targetId };

  if (requesterIsRoot) return { ok: true, targetId };

  const requesterMembership = await db()("campaign_members")
    .where({ campaign_id: campaignId, discord_id: requesterId })
    .first();
  if (requesterMembership?.role === "DM") return { ok: true, targetId };

  return { ok: false, status: 403, error: "only_dm_or_root_can_edit_others_availability" };
}

export function availabilityRouter(): Router {
  const router = Router();
  router.param("campaignId", resolveCampaignParam);

  router.get("/campaigns/:campaignId/availability/me", requireCampaignRole(["DM", "Player"]), async (req, res) => {
    const campaignId = req.params.campaignId!;
    const discordId = req.user!.discordId;
    const [defaults, specific] = await Promise.all([
      db()("default_availability").where({ campaign_id: campaignId, discord_id: discordId }),
      db()("specific_availability").where({ campaign_id: campaignId, discord_id: discordId }).orderBy("date_utc"),
    ]);
    res.json({
      defaults: defaults.map((d) => ({ dayOfWeek: d.day_of_week, weight: d.weight })),
      specific: specific.map((s) => ({ date: s.date_utc, weight: s.weight })),
    });
  });

  router.put("/campaigns/:campaignId/availability/default", requireCampaignRole(["DM", "Player"]), async (req, res) => {
    const campaignId = req.params.campaignId!;
    const target = await resolveWritableTarget(
      campaignId,
      req.user!.discordId,
      req.user!.globalRole === "root",
      req.body?.discordId
    );
    if (!target.ok) {
      res.status(target.status).json({ error: target.error });
      return;
    }

    const days = Array.isArray(req.body?.days) ? req.body.days : null;
    if (!days || !days.every((d: any) => Number.isInteger(d.dayOfWeek) && d.dayOfWeek >= 0 && d.dayOfWeek <= 6 && VALID_WEIGHTS.has(d.weight))) {
      res.status(400).json({ error: "invalid_days_payload" });
      return;
    }

    await db().transaction(async (trx) => {
      for (const d of days) {
        await trx("default_availability")
          .insert({ campaign_id: campaignId, discord_id: target.targetId, day_of_week: d.dayOfWeek, weight: d.weight })
          .onConflict(["campaign_id", "discord_id", "day_of_week"])
          .merge({ weight: d.weight });
      }
    });

    res.status(204).end();
  });

  router.put("/campaigns/:campaignId/availability/specific", requireCampaignRole(["DM", "Player"]), async (req, res) => {
    const campaignId = req.params.campaignId!;
    const target = await resolveWritableTarget(
      campaignId,
      req.user!.discordId,
      req.user!.globalRole === "root",
      req.body?.discordId
    );
    if (!target.ok) {
      res.status(target.status).json({ error: target.error });
      return;
    }

    const date = typeof req.body?.date === "string" ? req.body.date : null;
    const weight = req.body?.weight;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "invalid_date" });
      return;
    }

    if (weight === null) {
      // Explicit null clears the override, reverting to the weekly default for that date.
      await db()("specific_availability").where({ campaign_id: campaignId, discord_id: target.targetId, date_utc: date }).delete();
      res.status(204).end();
      return;
    }

    if (!VALID_WEIGHTS.has(weight)) {
      res.status(400).json({ error: "invalid_weight" });
      return;
    }

    await db()("specific_availability")
      .insert({ campaign_id: campaignId, discord_id: target.targetId, date_utc: date, weight })
      .onConflict(["campaign_id", "discord_id", "date_utc"])
      .merge({ weight });

    res.status(204).end();
  });

  // Everyone's availability — any member can VIEW this (per the ACL: you
  // can see the whole table's responses), but writes still go through the
  // /default and /specific endpoints above with their own-vs-others check.
  router.get("/campaigns/:campaignId/availability/all", requireCampaignRole(["DM", "Player"]), async (req, res) => {
    const campaignId = req.params.campaignId!;
    const [members, defaults, specific] = await Promise.all([
      db()("campaign_members")
        .join("users", "users.discord_id", "campaign_members.discord_id")
        .where("campaign_members.campaign_id", campaignId)
        .select("users.discord_id", "users.username", "campaign_members.role"),
      db()("default_availability").where({ campaign_id: campaignId }),
      db()("specific_availability").where({ campaign_id: campaignId }),
    ]);

    res.json({
      members: members.map((m) => ({ discordId: m.discord_id, username: m.username, role: m.role })),
      defaults: defaults.map((d) => ({ discordId: d.discord_id, dayOfWeek: d.day_of_week, weight: d.weight })),
      specific: specific.map((s) => ({ discordId: s.discord_id, date: s.date_utc, weight: s.weight })),
    });
  });

  return router;
}
