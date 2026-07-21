function toGoogleDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
}

function toIsoNoMillis(d: Date): string {
  return d.toISOString().slice(0, 19) + "Z";
}

export function buildGoogleCalendarUrl(title: string, start: Date, end: Date): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${toGoogleDate(start)}/${toGoogleDate(end)}`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function buildOutlookUrl(title: string, start: Date, end: Date): string {
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: title,
    startdt: toIsoNoMillis(start),
    enddt: toIsoNoMillis(end),
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

export function buildIcsUrl(publicUrl: string, campaignId: string, sessionId: string): string {
  return `${publicUrl}/api/campaigns/${campaignId}/sessions/${sessionId}/calendar.ics`;
}
