/** MySQL DATETIME string ('YYYY-MM-DD HH:MM:SS', always UTC in this app) -> Google's dates param format (YYYYMMDDTHHMMSSZ). */
function toGoogleDate(mysqlDatetime: string): string {
  return mysqlDatetime.replace(/[-:]/g, "").replace(" ", "T") + "Z";
}

/** -> ISO 8601 with Z, which is what Outlook's web deeplink expects. */
function toIso(mysqlDatetime: string): string {
  return mysqlDatetime.replace(" ", "T") + "Z";
}

export function buildGoogleCalendarUrl(title: string, startUtc: string, endUtc: string): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${toGoogleDate(startUtc)}/${toGoogleDate(endUtc)}`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function buildOutlookUrl(title: string, startUtc: string, endUtc: string): string {
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: title,
    startdt: toIso(startUtc),
    enddt: toIso(endUtc),
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

export function icsDownloadUrl(campaignId: string, sessionId: string): string {
  return `/api/campaigns/${campaignId}/sessions/${sessionId}/calendar.ics`;
}
