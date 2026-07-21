import { DateTime } from "luxon";
import { sendDiscordMessage } from "./webhook.js";
import { buildGoogleCalendarUrl, buildOutlookUrl, buildIcsUrl } from "../scheduling/calendarLinksServer.js";

interface AnnounceCampaign {
  id: string;
  name: string;
  timezone: string;
  discord_webhook_url: string | null;
}

function formatLocal(utcDate: Date, timezone: string): string {
  return DateTime.fromJSDate(utcDate, { zone: "utc" }).setZone(timezone).toFormat("cccc, LLLL d 'at' h:mm a ZZZZ");
}

function calendarLinksLine(campaign: AnnounceCampaign, sessionId: string, sessionNumber: number, start: Date, end: Date, publicUrl: string): string {
  const title = `${campaign.name} — Session ${sessionNumber}`;
  const google = buildGoogleCalendarUrl(title, start, end);
  const outlook = buildOutlookUrl(title, start, end);
  const ics = buildIcsUrl(publicUrl, campaign.id, sessionId);
  return `[Google](${google}) · [Outlook](${outlook}) · [.ics](${ics})`;
}

export async function announceSessionLocked(
  campaign: AnnounceCampaign,
  sessionId: string,
  sessionNumber: number,
  startUtc: Date,
  endUtc: Date,
  publicUrl: string
): Promise<void> {
  if (!campaign.discord_webhook_url) return;
  const when = formatLocal(startUtc, campaign.timezone);
  const links = calendarLinksLine(campaign, sessionId, sessionNumber, startUtc, endUtc, publicUrl);
  await sendDiscordMessage(
    campaign.discord_webhook_url,
    `🎲 **${campaign.name}** — Session ${sessionNumber} is locked in for **${when}**.\n${links}`
  );
}

export async function announceSessionCancelled(campaign: AnnounceCampaign, sessionNumber: number): Promise<void> {
  if (!campaign.discord_webhook_url) return;
  await sendDiscordMessage(
    campaign.discord_webhook_url,
    `⚠️ **${campaign.name}** — Session ${sessionNumber} has been cancelled. The date is back up for grabs.`
  );
}

export async function announceSessionRescheduled(
  campaign: AnnounceCampaign,
  sessionId: string,
  sessionNumber: number,
  newStartUtc: Date,
  newEndUtc: Date,
  publicUrl: string
): Promise<void> {
  if (!campaign.discord_webhook_url) return;
  const when = formatLocal(newStartUtc, campaign.timezone);
  const links = calendarLinksLine(campaign, sessionId, sessionNumber, newStartUtc, newEndUtc, publicUrl);
  await sendDiscordMessage(
    campaign.discord_webhook_url,
    `🔁 **${campaign.name}** — Session ${sessionNumber} has been moved to **${when}**.\n${links}`
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
