import { api, type Session } from "../api";
import { formatDateHuman } from "../dateMath";
import { buildGoogleCalendarUrl, buildOutlookUrl, icsDownloadUrl } from "../calendarLinks";

const STATUS_LABEL: Record<Session["status"], string> = {
  scheduled: "Locked",
  completed: "Played",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

function CalendarLinks({ session, campaignId, campaignName }: { session: Session; campaignId: string; campaignName: string }) {
  const title = `${campaignName}${session.session_number ? ` — Session ${session.session_number}` : ""}`;
  const google = buildGoogleCalendarUrl(title, session.scheduled_start_utc, session.scheduled_end_utc);
  const outlook = buildOutlookUrl(title, session.scheduled_start_utc, session.scheduled_end_utc);
  const ics = icsDownloadUrl(campaignId, session.id);

  const linkStyle: React.CSSProperties = {
    fontSize: 11.5,
    color: "var(--pp-ink-soft)",
    textDecoration: "none",
    border: "1px solid var(--pp-line)",
    borderRadius: 999,
    padding: "3px 9px",
  };

  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
      <a href={google} target="_blank" rel="noreferrer" style={linkStyle}>
        Google
      </a>
      <a href={outlook} target="_blank" rel="noreferrer" style={linkStyle}>
        Outlook
      </a>
      <a href={ics} style={linkStyle}>
        .ics
      </a>
    </div>
  );
}

export function SessionsList({
  sessions,
  campaignId,
  campaignName,
  canManage,
  onChanged,
}: {
  sessions: Session[];
  campaignId: string;
  campaignName: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  if (sessions.length === 0) {
    return (
      <div className="pp-empty">
        <p>No sessions locked yet — pick a date on the calendar above.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {sessions.map((s) => (
        <div
          key={s.id}
          className="pp-card"
          style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
        >
          <div>
            <span style={{ fontSize: 14 }}>
              {s.session_number ? `Session ${s.session_number}` : "Block"} · {formatDateHuman(s.scheduled_start_utc.slice(0, 10))}
            </span>
            <div className="pp-mono" style={{ fontSize: 11.5, color: "var(--pp-ink-soft)", marginTop: 3 }}>
              {STATUS_LABEL[s.status]}
              {s.notes ? ` · ${s.notes}` : ""}
            </div>
            {(s.status === "scheduled" || s.status === "completed") && (
              <CalendarLinks session={s} campaignId={campaignId} campaignName={campaignName} />
            )}
          </div>
          {canManage && s.status === "scheduled" && (
            <button
              className="pp-btn pp-btn-danger"
              onClick={async () => {
                await api.cancelSession(campaignId, s.id);
                onChanged();
              }}
            >
              Cancel
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
