import { api, type Session } from "../api";
import { formatDateHuman } from "../dateMath";

const STATUS_LABEL: Record<Session["status"], string> = {
  scheduled: "Locked",
  completed: "Played",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

export function SessionsList({
  sessions,
  campaignId,
  canManage,
  onChanged,
}: {
  sessions: Session[];
  campaignId: string;
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
