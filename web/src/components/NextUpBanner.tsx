import type { Session, CandidateDate, Campaign } from "../api";
import { formatInTimezone, formatDateHuman, blockIndexOf } from "../dateMath";

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

  // `candidates` already excludes full/skipped blocks (see getCandidateDates), but it still
  // spans the whole generated window (months out) — so first narrow to the *nearest* open
  // block (the next interval_weeks-long window that actually has room), then within just
  // that block collect every date tied for the top score, in case there's a tie.
  const nearestBlockIndex =
    candidates.length === 0
      ? null
      : Math.min(...candidates.map((c) => blockIndexOf(campaign.start_date, campaign.interval_weeks, c.date)));
  const candidatesInNearestBlock =
    nearestBlockIndex === null
      ? []
      : candidates.filter((c) => blockIndexOf(campaign.start_date, campaign.interval_weeks, c.date) === nearestBlockIndex);
  const bestScore = candidatesInNearestBlock[0]?.score;
  const bestCandidates = bestScore === undefined ? [] : candidatesInNearestBlock.filter((c) => c.score === bestScore);
  const bestCandidate = bestCandidates[0];
  const nextSessionNumber = campaign.last_session_number + 1;

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
            BEST OPEN DATE{bestCandidates.length > 1 ? "S" : ""} FOR SESSION {nextSessionNumber}
          </span>
          <p style={{ fontSize: 14.5, marginTop: 2 }}>
            Score {bestCandidate!.score}
            {!bestCandidate!.isDmAvailable && " (DM unavailable)"}
            {bestCandidate!.isDmAvailable && !bestCandidate!.isAboveMinPlayers && " (below minimum players)"}
          </p>
          {bestCandidates.map((c) => (
            <p key={c.date} style={{ fontSize: 14.5, marginTop: 2 }}>
              {formatDateHuman(c.date)}
            </p>
          ))}
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
