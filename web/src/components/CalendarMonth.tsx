import { useEffect, useState } from "react";
import { buildMonthGrid, monthLabel, todayUtc, WEEKDAY_SHORT, addMonthsToYearMonth, type DateStr } from "../dateMath";
import type { CandidateDate, BlockedDate, Session, AvailabilityAll, Campaign } from "../api";
import { PipDisplay } from "./PipMeter";
import { buildAvailabilityMaps, computeDayScore } from "../scheduling";

const STATUS_STYLE: Record<string, { bg: string; label: string }> = {
  scheduled: { bg: "rgba(192,138,46,0.16)", label: "Locked" },
  completed: { bg: "rgba(74,81,120,0.10)", label: "Played" },
  skipped: { bg: "rgba(74,81,120,0.06)", label: "Skipped" },
};

function ScoreBadge({
  score,
  isDmAvailable,
  isAboveMinPlayers,
}: {
  score: number;
  isDmAvailable: boolean;
  isAboveMinPlayers: boolean;
}) {
  const vetoed = !isDmAvailable || !isAboveMinPlayers;
  const reason = !isDmAvailable ? "DM unavailable" : !isAboveMinPlayers ? "below minimum players" : null;
  return (
    <span
      title={`Total availability score: ${score}${reason ? ` — ${reason}, score zeroed` : ""}`}
      aria-label={`Score ${score}`}
      className="pp-mono"
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: "white",
        background: vetoed ? "var(--pp-crimson)" : "var(--pp-brass)",
        borderRadius: 999,
        padding: "1px 7px",
        minWidth: 20,
        textAlign: "center",
        lineHeight: 1.5,
      }}
    >
      {score}
    </span>
  );
}

export function CalendarMonth({
  campaign,
  availability,
  candidates,
  blocked,
  sessions,
  focusDate,
  onDayClick,
}: {
  campaign: Campaign;
  availability: AvailabilityAll;
  candidates: CandidateDate[];
  blocked: BlockedDate[];
  sessions: Session[];
  focusDate?: DateStr | null;
  onDayClick: (date: DateStr) => void;
}) {
  const today = todayUtc();
  const [ym, setYm] = useState(() => {
    const [y, m] = today.split("-").map(Number);
    return { year: y!, month: m! - 1 };
  });

  // Parent (e.g. the "next session/block" banner) can request the calendar
  // jump to a specific date's month — re-runs whenever focusDate changes.
  useEffect(() => {
    if (!focusDate) return;
    const [y, m] = focusDate.split("-").map(Number);
    setYm({ year: y!, month: m! - 1 });
  }, [focusDate]);

  const maps = buildAvailabilityMaps(availability);
  const candidateByDate = new Map(candidates.map((c) => [c.date, c]));
  const blockedByDate = new Map(blocked.map((b) => [b.date, b]));
  const sessionByDate = new Map(
    sessions.filter((s) => s.status !== "cancelled").map((s) => [s.scheduled_start_utc.slice(0, 10), s])
  );

  // Heatmap denominator: the highest score a date could theoretically get if
  // every non-excluded member said an unqualified "Yes" — a fixed ceiling
  // rather than "the best day currently on screen", so a given score always
  // reads as the same shade no matter which month you're looking at.
  const maxPossibleScore = Math.max(1, availability.members.filter((m) => !m.excludedFromScoring).length * 3);

  const cells = buildMonthGrid(ym.year, ym.month);

  return (
    <div className="pp-card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
        <button className="pp-btn pp-btn-ghost" onClick={() => setYm(addMonthsToYearMonth(ym.year, ym.month, -1))}>
          ←
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3 style={{ fontSize: 15 }}>{monthLabel(ym.year, ym.month)}</h3>
          <button
            className="pp-btn pp-btn-ghost"
            style={{ fontSize: 12, padding: "4px 10px" }}
            onClick={() => {
              const [y, m] = today.split("-").map(Number);
              setYm({ year: y!, month: m! - 1 });
            }}
          >
            Today
          </button>
        </div>
        <button className="pp-btn pp-btn-ghost" onClick={() => setYm(addMonthsToYearMonth(ym.year, ym.month, 1))}>
          →
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4 }}>
        {WEEKDAY_SHORT.map((d) => (
          <div key={d} style={{ textAlign: "center", fontSize: 11, color: "var(--pp-ink-soft)", fontFamily: "var(--pp-font-mono)", padding: "2px 0" }}>
            {d}
          </div>
        ))}
        {cells.map(({ date, inMonth }) => {
          const session = sessionByDate.get(date);
          const candidate = candidateByDate.get(date);
          const blockedEntry = blockedByDate.get(date);
          const isPast = date < today;
          const isToday = date === today;
          const isFocused = date === focusDate;

          const style = session ? STATUS_STYLE[session.status] : undefined;
          // Open (unlocked) candidate days get a heat wash instead of a flat
          // white background, so the best options visibly pop out from the
          // rest without having to read every badge — locked/completed/
          // skipped days keep their existing distinct status tint instead,
          // since "what happened" matters more there than "how good was it".
          const heatIntensity = candidate ? Math.min(1, candidate.score / maxPossibleScore) : 0;
          const heatBg = candidate ? `rgba(192, 138, 46, ${(heatIntensity * 0.5).toFixed(3)})` : undefined;

          // Locked/completed sessions have a real date/time, so a score is
          // meaningful for them too — the candidates list only covers open
          // (unlocked) dates, so this is computed independently here.
          const sessionScore =
            session && (session.status === "scheduled" || session.status === "completed")
              ? computeDayScore(maps, availability.members, date, campaign.min_players_required)
              : null;

          return (
            <button
              key={date}
              onClick={() => onDayClick(date)}
              disabled={isPast && !session}
              style={{
                aspectRatio: "1",
                minHeight: 64,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "flex-start",
                gap: 3,
                padding: "6px 2px",
                border: isFocused ? "2px solid var(--pp-focus)" : isToday ? "1.5px solid var(--pp-brass)" : "1px solid var(--pp-line)",
                borderRadius: 8,
                background: style?.bg ?? heatBg ?? "var(--pp-surface)",
                opacity: inMonth ? (isPast && !session ? 0.4 : 1) : 0.3,
                cursor: isPast && !session ? "default" : "pointer",
                overflow: "hidden",
              }}
            >
              <span className="pp-mono" style={{ fontSize: 11, color: "var(--pp-ink-soft)" }}>
                {Number(date.slice(8, 10))}
              </span>

              {session ? (
                <>
                  {sessionScore && (
                    <ScoreBadge
                      score={sessionScore.score}
                      isDmAvailable={sessionScore.isDmAvailable}
                      isAboveMinPlayers={sessionScore.isAboveMinPlayers}
                    />
                  )}
                  <span style={{ fontSize: 9, fontWeight: 600, color: "var(--pp-ink-soft)", textAlign: "center", lineHeight: 1.2 }}>
                    {STATUS_STYLE[session.status]?.label}
                    {session.session_number ? ` #${session.session_number}` : ""}
                  </span>
                </>
              ) : candidate ? (
                <ScoreBadge
                  score={candidate.score}
                  isDmAvailable={candidate.isDmAvailable}
                  isAboveMinPlayers={candidate.isAboveMinPlayers}
                />
              ) : blockedEntry ? (
                <span style={{ fontSize: 8, color: "var(--pp-ink-soft)" }}>·</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 16, marginTop: 14, flexWrap: "wrap", fontSize: 11, color: "var(--pp-ink-soft)" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ display: "inline-flex", borderRadius: 4, overflow: "hidden", border: "1px solid var(--pp-line)" }}>
            {[0, 0.15, 0.3, 0.45, 0.5].map((a) => (
              <span key={a} style={{ width: 10, height: 10, background: `rgba(192, 138, 46, ${a})` }} />
            ))}
          </span>{" "}
          darker = better
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span
            className="pp-mono"
            style={{ fontSize: 10, fontWeight: 700, color: "white", background: "var(--pp-brass)", borderRadius: 999, padding: "1px 6px" }}
          >
            6
          </span>{" "}
          = total score for that date
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <PipDisplay weight={3} size={6} />
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <PipDisplay weight={2} size={6} />
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <PipDisplay weight={1} size={6} />
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <PipDisplay weight={0} size={6} />
        </span>
        <span>Tap a day for details</span>
      </div>
    </div>
  );
}
