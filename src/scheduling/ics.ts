/** Escapes TEXT property values per RFC 5545 §3.3.11. */
function escapeIcsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Converts a MySQL DATETIME string ('YYYY-MM-DD HH:MM:SS', always a true UTC instant in this app) to ICS UTC form (YYYYMMDDTHHMMSSZ). */
function toIcsUtc(mysqlDatetime: string): string {
  return mysqlDatetime.replace(/[-:]/g, "").replace(" ", "T") + "Z";
}

export interface IcsSessionInput {
  sessionId: string;
  campaignName: string;
  sessionNumber: number | null;
  scheduledStartUtc: string; // MySQL DATETIME string
  scheduledEndUtc: string;
}

export function buildSessionIcs(input: IcsSessionInput): string {
  const summary = escapeIcsText(
    `${input.campaignName}${input.sessionNumber ? ` — Session ${input.sessionNumber}` : ""}`
  );
  const dtstamp = toIcsUtc(new Date().toISOString().slice(0, 19).replace("T", " "));

  // CRLF line endings are required by RFC 5545 — plain \n is rejected by some clients.
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Party Planner//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${input.sessionId}@partyplanner`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${toIcsUtc(input.scheduledStartUtc)}`,
    `DTEND:${toIcsUtc(input.scheduledEndUtc)}`,
    `SUMMARY:${summary}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}
