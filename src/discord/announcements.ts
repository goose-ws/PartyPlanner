import { DateTime } from "luxon";
import { sendDiscordMessage } from "./webhook.js";

interface AnnounceCampaign {
  name: string;
  timezone: string;
  discord_webhook_url: string | null;
}

function formatLocal(utcDate: Date, timezone: string): string {
  return DateTime.fromJSDate(utcDate, { zone: "utc" }).setZone(timezone).toFormat("cccc, LLLL d 'at' h:mm a ZZZZ");
}

export async function announceSessionLocked(
  campaign: AnnounceCampaign,
  sessionNumber: number,
  startUtc: Date
): Promise<void> {
  if (!campaign.discord_webhook_url) return;
  const when = formatLocal(startUtc, campaign.timezone);
  await sendDiscordMessage(
    campaign.discord_webhook_url,
    `🎲 **${campaign.name}** — Session ${sessionNumber} is locked in for **${when}**.`
  );
}

export async function announceSessionCancelled(campaign: AnnounceCampaign, sessionNumber: number): Promise<void> {
  if (!campaign.discord_webhook_url) return;
  await sendDiscordMessage(
    campaign.discord_webhook_url,
    `⚠️ **${campaign.name}** — Session ${sessionNumber} has been cancelled. The date is back up for grabs.`
  );
}

export async function announceBlockSkipped(
  campaign: AnnounceCampaign,
  blockStart: string,
  blockEndInclusive: string,
  notes: string | null
): Promise<void> {
  if (!campaign.discord_webhook_url) return;
  await sendDiscordMessage(
    campaign.discord_webhook_url,
    `📅 **${campaign.name}** — the window ${blockStart} to ${blockEndInclusive} is being skipped.${notes ? ` (${notes})` : ""}`
  );
}
