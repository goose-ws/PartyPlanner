import { Router } from "express";
import crypto from "node:crypto";
import type { AppConfig } from "../types/config.js";
import { db } from "../db/index.js";
import { requireCampaignRole } from "../middleware/authz.js";
import { sendInviteEmail } from "../mail/mailer.js";
import { resolveCampaignParam } from "../middleware/resolveCampaign.js";

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
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return { ok: false, reason: "exhausted" };

  const isNewMember = await addMemberIfAbsent(invite.campaign_id, discordId, invite.role);
  await db()("campaign_invites").where({ token }).increment("uses", 1);

  const campaign = await db()("campaigns").where({ id: invite.campaign_id }).first();
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
    const email: string | null = typeof req.body?.email === "string" ? req.body.email : null;
    const maxUses: number | null = Number.isInteger(req.body?.maxUses) ? req.body.maxUses : null;
    const expiresInDays: number | null = Number.isInteger(req.body?.expiresInDays) ? req.body.expiresInDays : null;
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400 * 1000) : null;

    await db()("campaign_invites").insert({
      token,
      campaign_id: campaignId,
      created_by_discord_id: req.user!.discordId,
      role: requestedRole,
      email,
      max_uses: maxUses,
      expires_at: expiresAt,
    });

    const url = inviteUrl(cfg, token);
    let emailResult: { sent: boolean; reason?: string } | undefined;
    if (email) {
      emailResult = await sendInviteEmail(cfg, email, campaign.name, url);
    }

    res.status(201).json({ token, url, role: requestedRole, expiresAt, maxUses, email: emailResult });
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
        email: i.email,
        uses: i.uses,
        maxUses: i.max_uses,
        expiresAt: i.expires_at,
        revokedAt: i.revoked_at,
        createdAt: i.created_at,
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

    // Not logged in — hand off to the OAuth flow, which carries the invite
    // token through `state` and redeems it after Discord login succeeds.
    res.redirect(`/auth/login?invite=${encodeURIComponent(token)}`);
  });

  return router;
}
