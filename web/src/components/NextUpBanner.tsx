import type { Session, CandidateDate, Campaign } from "../api";
import { formatInTimezone, formatDateHuman } from "../dateMath";

export function NextUpBanner({
  campaign,
  sessions,
  candidates,
  onViewOnCalendar,
}: {
  campaign: Campaign;
  sessions: Session[];
  candidates: CandidateDate[];
  onViewOnCalendar: (date: string) => void;
}) {
  const nextSession = sessions
    .filter((s) => s.status === "scheduled")
    .sort((a, b) => a.scheduled_start_utc.localeCompare(b.scheduled_start_utc))[0];

  const bestCandidate = candidates[0];

  if (!nextSession && !bestCandidate) return null;

  return (
    <div
      className="pp-card"
      style={{
        padding: "14px 18px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        borderLeft: "3px solid var(--pp-brass)",
      }}
    >
      {nextSession ? (
        <div>
          <span className="pp-mono" style={{ fontSize: 11, color: "var(--pp-ink-soft)", letterSpacing: "0.04em" }}>
            NEXT SESSION
          </span>
          <p style={{ fontSize: 14.5, marginTop: 2 }}>
            Session {nextSession.session_number} — {formatInTimezone(nextSession.scheduled_start_utc, campaign.timezone)}
          </p>
        </div>
      ) : (
        <div>
          <span className="pp-mono" style={{ fontSize: 11, color: "var(--pp-ink-soft)", letterSpacing: "0.04em" }}>
            BEST OPEN DATE SO FAR
          </span>
          <p style={{ fontSize: 14.5, marginTop: 2 }}>
            {formatDateHuman(bestCandidate!.date)} — score {bestCandidate!.score}
            {!bestCandidate!.isDmAvailable && " (DM unavailable)"}
          </p>
        </div>
      )}
      <button
        className="pp-btn pp-btn-ghost"
        onClick={() => onViewOnCalendar(nextSession ? nextSession.scheduled_start_utc.slice(0, 10) : bestCandidate!.date)}
      >
        View on calendar
      </button>
    </div>
  );
}
