import { Router } from "express";
import type { AppConfig } from "../types/config.js";
import { db } from "../db/index.js";
import { verifyConfirmToken } from "../scheduling/confirmToken.js";
import { confirmBlock } from "../scheduling/blockConfirmations.js";
import { addDays } from "../scheduling/dateMath.js";
import { logAudit } from "../audit.js";

function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title} — Party Planner</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f5f4f0; font-family: ui-sans-serif, system-ui, sans-serif; color: #1b2340; padding: 24px; box-sizing: border-box; }
  .card { max-width: 420px; background: #fff; border: 1px solid #dad6cc; border-radius: 14px; box-shadow: 0 4px 20px rgba(27,35,64,0.08); padding: 32px 28px; text-align: center; }
  .icon { font-size: 40px; line-height: 1; margin-bottom: 14px; }
  h1 { font-size: 19px; margin: 0 0 8px; }
  p { font-size: 14.5px; color: #4a5178; line-height: 1.5; margin: 0; }
  .meta { margin-top: 14px; font-family: ui-monospace, "SFMono-Regular", monospace; font-size: 12.5px; color: #6b6f85; }
</style>
</head>
<body><div class="card">${bodyHtml}</div></body>
</html>`;
}

export function confirmPageRouter(cfg: AppConfig) {
  const router = Router();

  router.get("/confirm/:token", async (req, res) => {
    const payload = verifyConfirmToken(cfg, req.params.token);
    if (!payload) {
      res.status(410).send(
        page(
          "Link expired",
          `<div class="icon">⌛</div><h1>This confirmation link is no longer valid</h1><p>It may have expired. Open Party Planner directly and confirm from the Schedule tab instead.</p>`
        )
      );
      return;
    }

    const membership = await db()("campaign_members")
      .where({ campaign_id: payload.campaignId, discord_id: payload.discordId })
      .first();
    const campaign = await db()("campaigns").where({ id: payload.campaignId }).first();
    if (!membership || !campaign) {
      res.status(404).send(
        page("Not found", `<div class="icon">🤷</div><h1>Couldn't find that campaign or membership</h1><p>It may have been removed.</p>`)
      );
      return;
    }

    // This link is personalized, but it's posted in a shared Discord
    // channel where everyone can see everyone's link — so the token alone
    // isn't proof of identity, just proof of *which* confirmation is being
    // requested. The actual identity check is against the logged-in
    // session, same as any other authenticated action in the app.
    if (!req.user) {
      res.redirect(`/auth/login?returnTo=${encodeURIComponent(`/confirm/${req.params.token}`)}`);
      return;
    }
    if (req.user.discordId !== payload.discordId) {
      res.status(403).send(
        page(
          "Not your link",
          `<div class="icon">🚫</div><h1>This confirmation isn't for you</h1><p>You're logged in as <strong>${req.user.username}</strong>, but this link is for a different member of <strong>${campaign.name}</strong>. If you think this is your link, make sure you're signed into Party Planner as the right Discord account.</p>`
        )
      );
      return;
    }

    await confirmBlock(payload.campaignId, payload.discordId, payload.blockStart);
    await logAudit("block.confirmed", {
      campaignId: payload.campaignId,
      actorDiscordId: payload.discordId,
      detail: { blockStart: payload.blockStart, via: "discord_link" },
    });

    const blockEndInclusive = addDays(payload.blockStart, campaign.interval_weeks * 7 - 1);
    res.send(
      page(
        "Confirmed",
        `<div class="icon">✅</div><h1>You're confirmed!</h1><p>Your availability for <strong>${campaign.name}</strong> is locked in for this window.</p><div class="meta">${payload.blockStart} → ${blockEndInclusive}</div>`
      )
    );
  });

  return router;
}
