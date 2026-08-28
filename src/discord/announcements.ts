import { DateTime } from "luxon";
import { sendDiscordMessage } from "./webhook.js";
import { buildGoogleCalendarUrl, buildOutlookUrl, buildIcsUrl } from "../scheduling/calendarLinksServer.js";
import { getResponsesForDate, rosterLines } from "../scheduling/reminders.js";
import type { DateStr } from "../scheduling/dateMath.js";

interface AnnounceCampaign {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  discord_webhook_url: string | null;
  late_early_penalty: number;
  dm_maybe_modifier: number;
  dm_if_needed_modifier: number;
}

/** Party Planner's brand gold, used as the embed's left accent bar. */
const EMBED_COLOR = 0xc08a2e;
const CANCEL_COLOR = 0xa23b3b;
const NEUTRAL_COLOR = 0x4a5178;

function formatLocal(utcDate: Date, timezone: string): string {
  return DateTime.fromJSDate(utcDate, { zone: "utc" }).setZone(timezone).toFormat("cccc, LLLL d 'at' h:mm a ZZZZ");
}

/**
 * Calendar days from "now" until `target`, both measured in the campaign's
 * own timezone. DateTime.now() and DateTime.fromJSDate() default to the
 * HOST's local zone when no zone is given — exactly the same latent bug
 * class as dateMath.ts's old todayUtc() (see its comment): "how many days
 * until this session" depends on which zone you're counting calendar-day
 * boundaries in, and the host's zone isn't necessarily the campaign's.
 */
function daysUntil(target: Date, timezone: string): number {
  const now = DateTime.now().setZone(timezone);
  const then = DateTime.fromJSDate(target, { zone: timezone });
  return Math.max(0, Math.ceil(then.diff(now, "days").days));
}

function campaignUrl(campaign: AnnounceCampaign, publicUrl: string): string {
  return `${publicUrl}/campaigns/${campaign.slug}`;
}

/**
 * Bulleted, emoji-led list of calendar links — same links as before, just
 * laid out as a proper list instead of a `·`-joined run-on line.
 */
function calendarLinksSection(campaign: AnnounceCampaign, sessionId: string, sessionNumber: number, start: Date, end: Date, publicUrl: string): string {
  const title = `${campaign.name} — Session ${sessionNumber}`;
  const google = buildGoogleCalendarUrl(title, start, end);
  const outlook = buildOutlookUrl(title, start, end);
  const ics = buildIcsUrl(publicUrl, campaign.id, sessionId);
  return (
    `**Add to Calendar:**\n` +
    `📅 [Google Calendar](${google})\n` +
    `📅 [Outlook](${outlook})\n` +
    `📄 [Download ICS](${ics})`
  );
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
  const days = daysUntil(startUtc, campaign.timezone);
  const links = calendarLinksSection(campaign, sessionId, sessionNumber, startUtc, endUtc, publicUrl);

  const localDate = DateTime.fromJSDate(startUtc, { zone: "utc" }).setZone(campaign.timezone).toFormat("yyyy-LL-dd") as DateStr;
  const responses = await getResponsesForDate(campaign.id, localDate);
  const roster = rosterLines(responses, campaign);

  const description =
    `📅 **${campaign.name}** will meet on ${when}\n` +
    `⏳ ${days} day${days === 1 ? "" : "s"} until Session ${sessionNumber}\n\n` +
    `**Roster:**\n${roster}\n\n` +
    links;

  await sendDiscordMessage(campaign.discord_webhook_url, {
    embeds: [
      {
        title: `Scheduled: ${campaign.name} — Session ${sessionNumber}`,
        url: campaignUrl(campaign, publicUrl),
        color: EMBED_COLOR,
        description,
      },
    ],
  });
}

export async function announceSessionCancelled(campaign: AnnounceCampaign, sessionNumber: number): Promise<void> {
  if (!campaign.discord_webhook_url) return;
  await sendDiscordMessage(campaign.discord_webhook_url, {
    embeds: [
      {
        title: `Cancelled: ${campaign.name} — Session ${sessionNumber}`,
        color: CANCEL_COLOR,
        description: `⚠️ Session ${sessionNumber} has been cancelled. The date is back up for grabs.`,
      },
    ],
  });
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
  const days = daysUntil(newStartUtc, campaign.timezone);
  const links = calendarLinksSection(campaign, sessionId, sessionNumber, newStartUtc, newEndUtc, publicUrl);
  const description =
    `🔁 **${campaign.name}** has moved to ${when}\n` +
    `⏳ ${days} day${days === 1 ? "" : "s"} until Session ${sessionNumber}\n\n` +
    links;

  await sendDiscordMessage(campaign.discord_webhook_url, {
    embeds: [
      {
        title: `Rescheduled: ${campaign.name} — Session ${sessionNumber}`,
        url: campaignUrl(campaign, publicUrl),
        color: EMBED_COLOR,
        description,
      },
    ],
  });
}

export async function announceBlockSkipped(
  campaign: AnnounceCampaign,
  blockStart: string,
  blockEndInclusive: string,
  notes: string | null
): Promise<void> {
  if (!campaign.discord_webhook_url) return;
  const description = `📅 The window **${blockStart} to ${blockEndInclusive}** is being skipped.${notes ? `\n\n_${notes}_` : ""}`;
  await sendDiscordMessage(campaign.discord_webhook_url, {
    embeds: [
      {
        title: `Window Skipped: ${campaign.name}`,
        color: NEUTRAL_COLOR,
        description,
      },
    ],
  });
}