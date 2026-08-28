import { useState } from "react";
import { api, type Session, type Member } from "../api";
import { formatDateHuman, localDateOf } from "../dateMath";
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

function RescheduleControl({
  session,
  campaignId,
  timezone,
  onChanged,
}: {
  session: Session;
  campaignId: string;
  timezone: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(localDateOf(session.scheduled_start_utc, timezone));
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

function AttendanceNotesEditor({
  session,
  campaignId,
  members,
  onChanged,
}: {
  session: Session;
  campaignId: string;
  members: Member[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(session.notes ?? "");
  const [busyDiscordId, setBusyDiscordId] = useState<string | null>(null);
  const [savingNotes, setSavingNotes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const absent = new Set(session.absent_discord_ids);

  async function toggleAttended(discordId: string) {
    setBusyDiscordId(discordId);
    setError(null);
    try {
      if (absent.has(discordId)) {
        await api.clearAbsence(campaignId, session.id, discordId);
      } else {
        await api.markAbsent(campaignId, session.id, discordId, true);
      }
      onChanged();
    } catch {
      setError("Couldn't update attendance.");
    } finally {
      setBusyDiscordId(null);
    }
  }

  async function saveNotes() {
    setSavingNotes(true);
    setError(null);
    try {
      await api.updateSessionNotes(campaignId, session.id, notes.trim() || null);
      onChanged();
    } catch {
      setError("Couldn't save notes.");
    } finally {
      setSavingNotes(false);
    }
  }

  if (!open) {
    return (
      <button className="pp-btn pp-btn-ghost" onClick={() => setOpen(true)}>
        Edit attendance/notes
      </button>
    );
  }

  return (
    <div style={{ display: "grid", gap: 10, minWidth: 220 }}>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: "var(--pp-ink-soft)" }}>Who was there?</label>
        <div style={{ display: "grid", gap: 5, marginTop: 4 }}>
          {members.map((m) => (
            <label key={m.discordId} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
              <input
                type="checkbox"
                checked={!absent.has(m.discordId)}
                disabled={busyDiscordId === m.discordId}
                onChange={() => toggleAttended(m.discordId)}
              />
              {m.username}
            </label>
          ))}
        </div>
      </div>
      <div className="pp-field">
        <label htmlFor={`notes-${session.id}`} style={{ fontSize: 12 }}>
          Notes
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            id={`notes-${session.id}`}
            className="pp-input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={{ padding: "6px 8px" }}
          />
          <button className="pp-btn pp-btn-ghost" disabled={savingNotes} onClick={saveNotes}>
            {savingNotes ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {error && <p style={{ color: "var(--pp-crimson)", fontSize: 12 }}>{error}</p>}
      <button className="pp-btn pp-btn-ghost" onClick={() => setOpen(false)}>
        Done
      </button>
    </div>
  );
}

export function SessionsList({
  sessions,
  campaignId,
  campaignName,
  timezone,
  canManage,
  members,
  onChanged,
  onViewOnCalendar,
}: {
  sessions: Session[];
  campaignId: string;
  campaignName: string;
  timezone: string;
  canManage: boolean;
  members: Member[];
  onChanged: () => void;
  onViewOnCalendar: (date: string) => void;
}) {
  const visible = sessions.filter((s) => s.status === "scheduled" || s.status === "completed");

  if (visible.length === 0) {
    return (
      <div className="pp-empty">
        <p>No sessions locked yet — pick a date on the calendar above.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {visible.map((s) => (
        <div
          key={s.id}
          className="pp-card"
          style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
        >
          <div>
            <span style={{ fontSize: 14 }}>
              {s.session_number ? `Session ${s.session_number}` : "Block"} · {formatDateHuman(localDateOf(s.scheduled_start_utc, timezone))}
            </span>
            <div className="pp-mono" style={{ fontSize: 11.5, color: "var(--pp-ink-soft)", marginTop: 3 }}>
              {STATUS_LABEL[s.status]}
              {s.notes ? ` · ${s.notes}` : ""}
            </div>
            {s.status === "completed" && !s.attendance_confirmed_at && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                <span
                  className="pp-mono"
                  style={{ fontSize: 10.5, color: "var(--pp-brass)", fontWeight: 600 }}
                  title="This session auto-completed once its end time passed — nobody's confirmed the roster below is actually correct yet"
                >
                  attendance not reviewed — assuming everyone attended
                </span>
                {canManage && (
                  <button
                    className="pp-btn pp-btn-ghost"
                    style={{ fontSize: 11, padding: "2px 8px" }}
                    onClick={async () => {
                      await api.confirmAttendanceAsIs(campaignId, s.id);
                      onChanged();
                    }}
                    title="Confirms the default roster (everyone attended) is correct — use 'Edit attendance/notes' instead if it isn't"
                  >
                    Confirm as shown
                  </button>
                )}
              </div>
            )}
            {(s.status === "scheduled" || s.status === "completed") && (
              <>
                <CalendarLinks session={s} campaignId={campaignId} campaignName={campaignName} />
                <button
                  className="pp-btn pp-btn-ghost"
                  style={{ marginTop: 6, fontSize: 11.5, padding: "3px 9px" }}
                  onClick={() => onViewOnCalendar(localDateOf(s.scheduled_start_utc, timezone))}
                >
                  View on calendar
                </button>
              </>
            )}
          </div>
          {canManage && s.status === "scheduled" && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <RescheduleControl session={s} campaignId={campaignId} timezone={timezone} onChanged={onChanged} />
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
          {canManage && s.status === "completed" && (
            <AttendanceNotesEditor session={s} campaignId={campaignId} members={members} onChanged={onChanged} />
          )}
        </div>
      ))}
    </div>
  );
}
