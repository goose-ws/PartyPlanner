import { useEffect, useState } from "react";
import { buildMonthGrid, monthLabel, todayUtc, blockIndexOf, localDateOf, WEEKDAY_SHORT, addMonthsToYearMonth, type DateStr } from "../dateMath";
import type { CandidateDate, BlockedDate, Session, AvailabilityAll, Campaign } from "../api";
import { PipDisplay } from "./PipMeter";
import { buildAvailabilityMaps, computeDayScore, weightFor, flagsFor, type AvailabilityMaps } from "../scheduling";
import { api } from "../api";

const WEIGHT_DOT_COLOR = [
  "var(--pp-crimson)",   // No
  "var(--pp-ink-faint)", // Maybe
  "var(--pp-brass)",     // If
  "#2f9e5c",             // Yes
];

const WEIGHT_SHORT = ["No", "Maybe", "If", "Yes"];

const STATUS_STYLE: Record<string, { bg: string; label: string }> = {
  scheduled: { bg: "rgba(192,138,46,0.16)", label: "Locked" },
  completed: { bg: "rgba(74,81,120,0.10)", label: "Played" },
  skipped: { bg: "rgba(74,81,120,0.06)", label: "Skipped" },
};

/** Resolves base numeric weight along with any active modifier (Late/Early) */
function getResponseDetails(
  maps: AvailabilityMaps,
  discordId: string,
  date: DateStr
): { weight: number; modifier: "Late" | "Early" | null } {
  const weight = weightFor(maps, discordId, date);
  const flags = flagsFor(maps, discordId, date);

  let modifier: "Late" | "Early" | null = null;
  if (flags.joiningLate) modifier = "Late";
  else if (flags.droppingEarly) modifier = "Early";

  return { weight, modifier };
}

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

/** Small breakdown line under the total score badge: "P" (player sum) and "DM" (DM's own score). */
function ScoreBreakdown({ playerScore, dmScore }: { playerScore: number; dmScore: number }) {
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return (
    <span
      title={`Player sum: ${fmt(playerScore)} · DM score: ${fmt(dmScore)}`}
      className="pp-mono"
      style={{
        fontSize: 8,
        fontWeight: 600,
        color: "var(--pp-ink-soft)",
        lineHeight: 1.2,
        whiteSpace: "nowrap",
      }}
    >
      P {fmt(playerScore)} · DM {fmt(dmScore)}
    </span>
  );
}

/** Small text badge showing the CURRENT user's base response (Yes/If/Mb/No) + modifier (Late/Early) */
function ResponseDot({ weight, modifier, label }: { weight: number; modifier: "Late" | "Early" | null; label: string }) {
  const baseLabel = WEIGHT_SHORT[weight];
  const color = WEIGHT_DOT_COLOR[weight];

  if (!baseLabel) return null;

  const displayText = modifier ? `${baseLabel} (${modifier})` : baseLabel;

  return (
    <span
      title={`${label}: ${displayText}`}
      style={{
        position: "absolute",
        top: 3,
        left: 4,
        fontSize: 8.5,
        fontWeight: 700,
        color: color,
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      {displayText}
    </span>
  );
}

// Alternating colors so consecutive blocks (session-scheduling intervals) are
// visually distinguishable as you scan down the calendar.
const BLOCK_STRIPE_COLORS = ["#6f7bd6", "#4a9d8f"];

/** Thin colored bar flush against a cell's left edge. Adjacent days in the same
 * block share a color, so the bars read as one continuous line down the block
 * and visibly change color where one block ends and the next begins. */
function BlockEdge({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        bottom: 0,
        width: 3,
        background: color,
      }}
    />
  );
}

export function CalendarMonth({
  campaign,
  availability,
  candidates,
  blocked,
  sessions,
  focusDate,
  currentUserId,
  canManage,
  onDayClick,
  onChanged,
}: {
  campaign: Campaign;
  availability: AvailabilityAll;
  candidates: CandidateDate[];
  blocked: BlockedDate[];
  sessions: Session[];
  focusDate?: DateStr | null;
  currentUserId: string;
  /** DM/root only: lets them pick another member to view the "your response" dot for, at-a-glance across the month. */
  canManage?: boolean;
  onDayClick: (date: DateStr) => void;
  onChanged: () => void;
}) {
  const today = todayUtc();
  const [ym, setYm] = useState(() => {
    const [y, m] = today.split("-").map(Number);
    return { year: y!, month: m! - 1 };
  });
  const [selectMode, setSelectMode] = useState(false);
  const [selectedDates, setSelectedDates] = useState<Set<DateStr>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [viewAsDiscordId, setViewAsDiscordId] = useState<string>(currentUserId);

  useEffect(() => {
    if (!focusDate) return;
    const [y, m] = focusDate.split("-").map(Number);
    setYm({ year: y!, month: m! - 1 });
  }, [focusDate]);

  const maps = buildAvailabilityMaps(availability);
  const candidateByDate = new Map(candidates.map((c) => [c.date, c]));
  const blockedByDate = new Map(blocked.map((b) => [b.date, b]));
  const sessionByDate = new Map(
    sessions.filter((s) => s.status !== "cancelled").map((s) => [localDateOf(s.scheduled_start_utc, campaign.timezone), s])
  );

  const maxPossibleScore = Math.max(1, availability.members.filter((m) => !m.excludedFromScoring).length * 3);
  const cells = buildMonthGrid(ym.year, ym.month);
  const viewAsMemberLabel = availability.members.find((m) => m.discordId === viewAsDiscordId)?.username ?? "Member";

  function toggleSelect(date: DateStr, disabled: boolean) {
    if (disabled) return;
    setSelectedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }

  async function bulkApply(weight: number) {
    setBulkBusy(true);
    try {
      await Promise.all(
        [...selectedDates].map((date) => api.setSpecificAvailability(campaign.id, date, weight))
      );
      setSelectedDates(new Set());
      setSelectMode(false);
      onChanged();
    } finally {
      setBulkBusy(false);
    }
  }

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
        <button
          className="pp-btn pp-btn-ghost"
          style={{ fontSize: 12, padding: "4px 10px" }}
          onClick={() => {
            setSelectMode((v) => !v);
            setSelectedDates(new Set());
          }}
        >
          {selectMode ? "Cancel" : "Select days"}
        </button>
      </div>

      {canManage && availability.members.length > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <label htmlFor="cal-view-as" style={{ fontSize: 12, color: "var(--pp-ink-soft)" }}>
            View as
          </label>
          <select
            id="cal-view-as"
            className="pp-input"
            style={{ fontSize: 12, padding: "4px 8px", width: "auto" }}
            value={viewAsDiscordId}
            onChange={(e) => setViewAsDiscordId(e.target.value)}
          >
            <option value={currentUserId}>Me</option>
            {availability.members
              .filter((m) => m.discordId !== currentUserId)
              .sort((a, b) => a.username.localeCompare(b.username))
              .map((m) => (
                <option key={m.discordId} value={m.discordId}>
                  {m.username} ({m.role})
                </option>
              ))}
          </select>
          {viewAsDiscordId !== currentUserId && (
            <span
              className="pp-mono"
              style={{ fontSize: 11, color: "var(--pp-brass)", fontWeight: 600 }}
              title="The dot in each day cell now shows this member's response, not yours"
            >
              viewing another member's availability
            </span>
          )}
        </div>
      )}

      {selectMode && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 12,
            padding: "8px 10px",
            background: "var(--pp-bg)",
            borderRadius: 8,
          }}
        >
          <span style={{ fontSize: 12.5, color: "var(--pp-ink-soft)" }}>
            {selectedDates.size === 0 ? "Tap days to select them" : `${selectedDates.size} day${selectedDates.size === 1 ? "" : "s"} selected`}
          </span>
          {selectedDates.size > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginLeft: "auto" }}>
              {WEIGHT_SHORT.map((label, weight) => (
                <button
                  key={weight}
                  className="pp-btn pp-btn-ghost"
                  disabled={bulkBusy}
                  style={{ fontSize: 12, padding: "4px 10px" }}
                  onClick={() => bulkApply(weight)}
                >
                  Set {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

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
          const heatIntensity = candidate ? Math.min(1, candidate.score / maxPossibleScore) : 0;
          const heatBg = candidate ? `rgba(192, 138, 46, ${(heatIntensity * 0.5).toFixed(3)})` : undefined;

          const dayScore =
            session ? (session.status === "scheduled" || session.status === "completed" ? computeDayScore(maps, availability.members, date, campaign) : null)
            : candidate ? computeDayScore(maps, availability.members, date, campaign)
            : null;

          const isDisabledForEdit = isPast && !session;
          const isSelected = selectedDates.has(date);
          const { weight, modifier } = getResponseDetails(maps, viewAsDiscordId, date);
          const responseDotLabel = viewAsDiscordId === currentUserId ? "Your response" : `${viewAsMemberLabel}'s response`;
          const blockIdx = blockIndexOf(campaign.start_date, campaign.interval_weeks, date);
          const blockColor = BLOCK_STRIPE_COLORS[((blockIdx % 2) + 2) % 2];

          return (
            <button
              key={date}
              onClick={() => (selectMode ? toggleSelect(date, isDisabledForEdit) : onDayClick(date))}
              disabled={isDisabledForEdit && !selectMode}
              style={{
                position: "relative",
                aspectRatio: "1",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "flex-start",
                gap: 3,
                padding: "6px 2px",
                border: isSelected
                  ? "2px solid var(--pp-focus)"
                  : isFocused
                    ? "2px solid var(--pp-focus)"
                    : isToday
                      ? "1.5px solid var(--pp-brass)"
                      : "1px solid var(--pp-line)",
                borderRadius: 8,
                background: isSelected ? "rgba(47,111,237,0.10)" : style?.bg ?? heatBg ?? "var(--pp-surface)",
                opacity: inMonth ? (isDisabledForEdit && !selectMode ? 0.4 : 1) : 0.3,
                cursor: isDisabledForEdit && !selectMode ? "default" : "pointer",
                overflow: "hidden",
              }}
            >
              {inMonth && <BlockEdge color={blockColor} />}
              {inMonth && <ResponseDot weight={weight} modifier={modifier} label={responseDotLabel} />}
              <span className="pp-mono" style={{ fontSize: 11, color: "var(--pp-ink-soft)" }}>
                {Number(date.slice(8, 10))}
              </span>

              {session ? (
                <>
                  {dayScore && (
                    <>
                      <ScoreBadge
                        score={dayScore.score}
                        isDmAvailable={dayScore.isDmAvailable}
                        isAboveMinPlayers={dayScore.isAboveMinPlayers}
                      />
                      <ScoreBreakdown playerScore={dayScore.playerScore} dmScore={dayScore.dmScore} />
                    </>
                  )}
                  <span style={{ fontSize: 9, fontWeight: 600, color: "var(--pp-ink-soft)", textAlign: "center", lineHeight: 1.2 }}>
                    {STATUS_STYLE[session.status]?.label}
                    {session.session_number ? ` #${session.session_number}` : ""}
                  </span>
                </>
              ) : candidate && dayScore ? (
                <>
                  <ScoreBadge
                    score={dayScore.score}
                    isDmAvailable={dayScore.isDmAvailable}
                    isAboveMinPlayers={dayScore.isAboveMinPlayers}
                  />
                  <ScoreBreakdown playerScore={dayScore.playerScore} dmScore={dayScore.dmScore} />
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
          <span className="pp-mono" style={{ fontSize: 9, color: "var(--pp-ink-soft)" }}>
            P 4 · DM 2
          </span>{" "}
          = player sum / DM's own score, under the total
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
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: "var(--pp-brass)" }}>Yes (Late)</span>
          badge in corner = your response
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ display: "inline-flex", gap: 2 }}>
            {BLOCK_STRIPE_COLORS.map((c) => (
              <span key={c} style={{ width: 3, height: 12, background: c, borderRadius: 1 }} />
            ))}
          </span>
          left edge = block boundary
        </span>
        <span>Tap a day for details</span>
      </div>
    </div>
  );
}