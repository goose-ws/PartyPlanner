import { useState } from "react";
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

function RescheduleControl({ session, campaignId, onChanged }: { session: Session; campaignId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(session.scheduled_start_utc.slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function move() {
    setBusy(true);
    setError(null);
    try {
      await api.rescheduleSession(campaignId, session.id, date);
      setOpen(false);
      onChanged();
    } catch (err: any) {
      setError(err?.code === "target_block_already_full" ? "That block's already full." : "Couldn't reschedule.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="pp-btn pp-btn-ghost" onClick={() => setOpen(true)}>
        Reschedule
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input type="date" className="pp-input" value={date} onChange={(e) => setDate(e.target.value)} style={{ padding: "6px 8px" }} />
        <button className="pp-btn pp-btn-ghost" disabled={busy} onClick={move}>
          {busy ? "Moving…" : "Confirm"}
        </button>
        <button className="pp-btn pp-btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
          ✕
        </button>
      </div>
      {error && <p style={{ color: "var(--pp-crimson)", fontSize: 12 }}>{error}</p>}
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
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <RescheduleControl session={s} campaignId={campaignId} onChanged={onChanged} />
              <button
                className="pp-btn pp-btn-ghost"
                title="Reopens this block for a fresh lock"
                onClick={async () => {
                  await api.cancelSession(campaignId, s.id);
                  onChanged();
                }}
              >
                Unlock
              </button>
              <button
                className="pp-btn pp-btn-danger"
                title="Calls off the whole block — won't be offered again"
                onClick={async () => {
                  if (!confirm("This cancels the whole block, not just this date — it won't be offered again as a candidate. Continue?")) return;
                  await api.cancelBlock(campaignId, s.id, "Cancelled from Sessions list");
                  onChanged();
                }}
              >
                Cancel block
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
