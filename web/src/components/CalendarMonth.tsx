import { useState } from "react";
import { buildMonthGrid, monthLabel, todayUtc, WEEKDAY_SHORT, addMonthsToYearMonth, type DateStr } from "../dateMath";
import type { CandidateDate, BlockedDate, Session } from "../api";
import { PipDisplay } from "./PipMeter";

const STATUS_STYLE: Record<string, { bg: string; label: string }> = {
  scheduled: { bg: "rgba(192,138,46,0.16)", label: "Locked" },
  completed: { bg: "rgba(74,81,120,0.10)", label: "Played" },
  skipped: { bg: "rgba(74,81,120,0.06)", label: "Skipped" },
};

export function CalendarMonth({
  candidates,
  blocked,
  sessions,
  onDayClick,
}: {
  candidates: CandidateDate[];
  blocked: BlockedDate[];
  sessions: Session[];
  onDayClick: (date: DateStr) => void;
}) {
  const today = todayUtc();
  const [ym, setYm] = useState(() => {
    const [y, m] = today.split("-").map(Number);
    return { year: y!, month: m! - 1 };
  });

  const candidateByDate = new Map(candidates.map((c) => [c.date, c]));
  const blockedByDate = new Map(blocked.map((b) => [b.date, b]));
  const sessionByDate = new Map(
    sessions.filter((s) => s.status !== "cancelled").map((s) => [s.scheduled_start_utc.slice(0, 10), s])
  );

  const cells = buildMonthGrid(ym.year, ym.month);
  const maxScore = Math.max(1, ...candidates.map((c) => c.score));

  return (
    <div className="pp-card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <button className="pp-btn pp-btn-ghost" onClick={() => setYm(addMonthsToYearMonth(ym.year, ym.month, -1))}>
          ←
        </button>
        <h3 style={{ fontSize: 15 }}>{monthLabel(ym.year, ym.month)}</h3>
        <button className="pp-btn pp-btn-ghost" onClick={() => setYm(addMonthsToYearMonth(ym.year, ym.month, 1))}>
          →
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
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

          const style = session ? STATUS_STYLE[session.status] : undefined;

          return (
            <button
              key={date}
              onClick={() => onDayClick(date)}
              disabled={isPast && !session}
              style={{
                aspectRatio: "1",
                minHeight: 58,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "flex-start",
                gap: 3,
                padding: "6px 2px",
                border: isToday ? "1.5px solid var(--pp-brass)" : "1px solid var(--pp-line)",
                borderRadius: 8,
                background: style?.bg ?? "var(--pp-surface)",
                opacity: inMonth ? (isPast && !session ? 0.4 : 1) : 0.3,
                cursor: isPast && !session ? "default" : "pointer",
              }}
            >
              <span className="pp-mono" style={{ fontSize: 11, color: "var(--pp-ink-soft)" }}>
                {Number(date.slice(8, 10))}
              </span>

              {session ? (
                <span style={{ fontSize: 9, fontWeight: 600, color: "var(--pp-ink-soft)", textAlign: "center", lineHeight: 1.2 }}>
                  {STATUS_STYLE[session.status]?.label}
                  {session.session_number ? ` #${session.session_number}` : ""}
                </span>
              ) : candidate ? (
                <>
                  <div
                    style={{
                      width: "70%",
                      height: 3,
                      borderRadius: 2,
                      background: candidate.isDmAvailable ? "var(--pp-brass)" : "var(--pp-crimson)",
                      opacity: 0.3 + 0.7 * (candidate.score / maxScore),
                    }}
                  />
                  <span style={{ fontSize: 9, color: "var(--pp-ink-soft)" }}>{candidate.score}</span>
                </>
              ) : blockedEntry ? (
                <span style={{ fontSize: 8, color: "var(--pp-ink-soft)" }}>·</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 16, marginTop: 14, flexWrap: "wrap", fontSize: 11, color: "var(--pp-ink-soft)" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <PipDisplay weight={3} size={6} /> Yes
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <PipDisplay weight={2} size={6} /> If needed
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <PipDisplay weight={1} size={6} /> Maybe
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <PipDisplay weight={0} size={6} /> No
        </span>
        <span>Tap a day for details</span>
      </div>
    </div>
  );
}
