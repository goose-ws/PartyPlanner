import { Router } from "express";
import crypto from "node:crypto";
import type { AppConfig } from "../types/config.js";
import { db } from "../db/index.js";
import { requireCampaignRole } from "../middleware/authz.js";
import { resolveCampaignParam } from "../middleware/resolveCampaign.js";
import { logAudit } from "../audit.js";
import { parseUtcDatetime } from "../scheduling/dateMath.js";

function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function inviteUrl(cfg: AppConfig, token: string): string {
  return `${cfg.publicUrl}/invite/${token}`;
}

/** Adds `discordId` to `campaignId` with `role`, unless already a member. Idempotent. */
async function addMemberIfAbsent(campaignId: string, discordId: string, role: "DM" | "Player"): Promise<boolean> {
  const existing = await db()("campaign_members").where({ campaign_id: campaignId, discord_id: discordId }).first();
  if (!existing) {
    await db()("campaign_members").insert({ campaign_id: campaignId, discord_id: discordId, role });
    return true;
  }
  return false;
}

/**
 * Redeems an invite token for an already-authenticated user: validates
 * expiry/revocation/use-limits, adds membership, and increments the use
 * counter. Shared by both the logged-in-already path (routes below) and the
 * post-OAuth-callback path (routes/auth.ts).
 */
/**
 * Read-only validity check — same rules as redeemInvite (exists, not
 * revoked, not expired, not exhausted) but never increments uses or touches
 * membership. Used to reject a dead invite link before sending the browser
 * through a whole Discord OAuth round-trip for nothing.
 */
async function checkInviteValidity(token: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const invite = await db()("campaign_invites").where({ token }).first();
  if (!invite) return { ok: false, reason: "not_found" };
  if (invite.revoked_at) return { ok: false, reason: "revoked" };
  if (invite.expires_at && parseUtcDatetime(invite.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return { ok: false, reason: "exhausted" };
  return { ok: true };
}

export async function redeemInvite(
  token: string,
  discordId: string
): Promise<
  | { ok: true; campaignId: string; campaignSlug: string; isNewMember: boolean }
  | { ok: false; reason: string }
> {
  const invite = await db()("campaign_invites").where({ token }).first();
  if (!invite) return { ok: false, reason: "not_found" };
  if (invite.revoked_at) return { ok: false, reason: "revoked" };
  if (invite.expires_at && parseUtcDatetime(invite.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return { ok: false, reason: "exhausted" };

  const isNewMember = await addMemberIfAbsent(invite.campaign_id, discordId, invite.role);
  await db()("campaign_invites").where({ token }).increment("uses", 1);

  const campaign = await db()("campaigns").where({ id: invite.campaign_id }).first();
  await logAudit("invite.redeemed", {
    campaignId: invite.campaign_id,
    actorDiscordId: discordId,
    detail: { token, role: invite.role, isNewMember },
  });
  return { ok: true, campaignId: invite.campaign_id, campaignSlug: campaign.slug, isNewMember };
}

/**
 * JSON management endpoints (create/list/revoke), fetched by the SPA —
 * mounted under /api in server.ts.
 */
export function invitesApiRouter(cfg: AppConfig): Router {
  const router = Router();
  router.param("campaignId", resolveCampaignParam);

  router.post("/campaigns/:campaignId/invites", requireCampaignRole(["DM"]), async (req, res) => {
    const { campaignId } = req.params;
    const requestedRole = req.body?.role === "DM" ? "DM" : "Player";

    // Only root may mint a DM-granting invite; a campaign DM can only invite Players.
    if (requestedRole === "DM" && req.user!.globalRole !== "root") {
      res.status(403).json({ error: "only_root_can_invite_as_dm" });
      return;
    }

    const campaign = await db()("campaigns").where({ id: campaignId }).first();
    if (!campaign) {
      res.status(404).json({ error: "campaign_not_found" });
      return;
    }

    const token = generateToken();
    const maxUses: number | null = Number.isInteger(req.body?.maxUses) ? req.body.maxUses : null;
    const expiresInDays: number | null = Number.isInteger(req.body?.expiresInDays) ? req.body.expiresInDays : null;
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400 * 1000) : null;

    await db()("campaign_invites").insert({
      token,
      campaign_id: campaignId,
      created_by_discord_id: req.user!.discordId,
      role: requestedRole,
      max_uses: maxUses,
      expires_at: expiresAt,
    });

    const url = inviteUrl(cfg, token);
    await logAudit("invite.created", {
      campaignId,
      actorDiscordId: req.user!.discordId,
      detail: { token, role: requestedRole, maxUses, expiresAt },
    });
    res.status(201).json({ token, url, role: requestedRole, expiresAt, maxUses });
  });

  router.get("/campaigns/:campaignId/invites", requireCampaignRole(["DM"]), async (req, res) => {
    const invites = await db()("campaign_invites")
      .where({ campaign_id: req.params.campaignId })
      .orderBy("created_at", "desc");
    res.json({
      invites: invites.map((i) => ({
        token: i.token,
        url: inviteUrl(cfg, i.token),
        role: i.role,
        uses: i.uses,
        maxUses: i.max_uses,
        // .toISOString() so the wire format is unambiguous UTC — the raw
        // value read back from the DB is a bare "YYYY-MM-DD HH:MM:SS"
        // string with no zone marker, and `new Date(...)` on that specific
        // shape is parsed as LOCAL time by JS engines, not UTC. See
        // dateMath.ts's parseUtcDatetime() for the full explanation.
        expiresAt: i.expires_at ? parseUtcDatetime(i.expires_at).toISOString() : null,
        revokedAt: i.revoked_at ? parseUtcDatetime(i.revoked_at).toISOString() : null,
        createdAt: parseUtcDatetime(i.created_at).toISOString(),
      })),
    });
  });

  router.post("/campaigns/:campaignId/invites/:token/revoke", requireCampaignRole(["DM"]), async (req, res) => {
    const updated = await db()("campaign_invites")
      .where({ campaign_id: req.params.campaignId, token: req.params.token })
      .andWhere({ revoked_at: null })
      .update({ revoked_at: new Date() });
    if (!updated) {
      res.status(404).json({ error: "invite_not_found_or_already_revoked" });
      return;
    }
    await logAudit("invite.revoked", { campaignId: req.params.campaignId, actorDiscordId: req.user!.discordId, detail: { token: req.params.token } });
    res.status(204).end();
  });

  return router;
}

/**
 * Public redemption — a real browser-navigation target (shared in Discord,
 * clicked directly), so it MUST stay a bare top-level path, not under /api
 * and not reusing any React Router path. Mounted at / in server.ts.
 */
export function invitePageRouter(): Router {
  const router = Router();

  router.get("/invite/:token", async (req, res) => {
    const { token } = req.params;

    if (req.user) {
      // Already logged in — redeem immediately, no Discord round-trip needed.
      const result = await redeemInvite(token, req.user.discordId);
      if (!result.ok) {
        res.status(410).send(`This invite link is no longer valid (${result.reason}).`);
        return;
      }
      res.redirect(result.isNewMember ? `/campaigns/${result.campaignSlug}/welcome` : `/campaigns/${result.campaignSlug}`);
      return;
    }

    // Not logged in — check the invite is actually alive BEFORE sending the
    // browser through a whole Discord OAuth round-trip for a dead link.
    // (This is a dry-run check only; the real redemption — and its own
    // fresh validity check, in case something changed in the interim —
    // still happens in the OAuth callback.)
    const validity = await checkInviteValidity(token);
    if (!validity.ok) {
      res.status(410).send(`This invite link is no longer valid (${validity.reason}).`);
      return;
    }

    res.redirect(`/auth/login?invite=${encodeURIComponent(token)}`);
  });

  return router;
}
