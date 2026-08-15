import { useState } from "react";
import { api, type AvailabilityAll, type CandidateDate, type Session, type AuthedUser, type Campaign } from "../api";
import { weightFor, flagsFor, buildAvailabilityMaps, contributionFor } from "../scheduling";
import { PipDisplay, WeightPicker } from "./PipMeter";
import { RoleBadge } from "./RoleBadge";
import { formatDateHuman, type DateStr } from "../dateMath";

/** Small mono tag showing a member's calculated score contribution for this date — sits right next to their RoleBadge. */
function ScoreTag({ score, excluded }: { score: number; excluded?: boolean }) {
  const display = Number.isInteger(score) ? String(score) : score.toFixed(1);
  return (
    <span
      className="pp-mono"
      style={{
        fontSize: 10.5,
        letterSpacing: "0.04em",
        color: excluded ? "var(--pp-ink-faint)" : "var(--pp-ink-soft)",
        border: "1px solid var(--pp-line)",
        borderRadius: 4,
        padding: "2px 6px",
        fontStyle: excluded ? "italic" : "normal",
      }}
      title={
        excluded
          ? `Excluded from scoring — this response (${display} pt${score === 1 ? "" : "s"}) isn't counted toward the total`
          : `Score contribution: ${display}`
      }
    >
      {excluded ? "excluded" : `${display} pt${score === 1 ? "" : "s"}`}
    </span>
  );
}

function FlagChip({ label, active, onToggle, disabled }: { label: string; active: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      title={active ? `${label} — click to clear` : `Mark as ${label.toLowerCase()}`}
      style={{
        fontSize: 10.5,
        fontFamily: "var(--pp-font-mono)",
        padding: "2px 8px",
        borderRadius: 999,
        border: `1px solid ${active ? "var(--pp-crimson)" : "var(--pp-line)"}`,
        background: active ? "rgba(162,59,59,0.1)" : "transparent",
        color: active ? "var(--pp-crimson)" : "var(--pp-ink-soft)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

export function DayDetailModal({
  date,
  campaignId,
  campaign,
  campaignMyRole,
  user,
  availability,
  candidate,
  session,
  onClose,
  onChanged,
}: {
  date: DateStr;
  campaignId: string;
  campaign: Campaign;
  campaignMyRole: "DM" | "Player" | undefined;
  user: AuthedUser;
  availability: AvailabilityAll;
  candidate: CandidateDate | undefined;
  session: Session | undefined;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const isRoot = user.globalRole === "root";
  const isDm = campaignMyRole === "DM";
  const canManage = isRoot || isDm;
  const maps = buildAvailabilityMaps(availability);

  async function toggleExclusion(discordId: string, currentlyExcluded: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.setMemberExclusion(campaignId, discordId, !currentlyExcluded);
      onChanged();
    } catch {
      setError("Couldn't update that member's scoring exclusion.");
    } finally {
      setBusy(false);
    }
  }

  async function saveResponse(discordId: string, weight: number, joiningLate: boolean, droppingEarly: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.setSpecificAvailability(campaignId, date, weight, discordId === user.discordId ? undefined : discordId, {
        joiningLate,
        droppingEarly,
      });
      onChanged();
    } catch {
      setError("Couldn't save that response.");
    } finally {
      setBusy(false);
    }
  }

  async function lock() {
    setBusy(true);
    setError(null);
    try {
      await api.lockSession(campaignId, date);
      onChanged();
      onClose();
    } catch {
      setError("Couldn't lock this date.");
    } finally {
      setBusy(false);
    }
  }

  /** "Unlock" — reopens this date's block for a fresh lock, without ruling out playing sometime in this same window. */
  async function unlock() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancelSession(campaignId, session.id);
      onChanged();
      onClose();
    } catch {
      setError("Couldn't unlock this session.");
    } finally {
      setBusy(false);
    }
  }

  /** "Cancel this block" — calls off the whole window, not just this date; the block won't be offered again. */
  async function cancelWholeBlock() {
    if (!session) return;
    if (!confirm("This cancels the whole block, not just this date — it won't be offered again as a candidate. Continue?")) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancelBlock(campaignId, session.id, "Cancelled from calendar");
      onChanged();
      onClose();
    } catch {
      setError("Couldn't cancel this block.");
    } finally {
      setBusy(false);
    }
  }

  async function reschedule() {
    if (!session || !rescheduleDate) return;
    setBusy(true);
    setError(null);
    try {
      await api.rescheduleSession(campaignId, session.id, rescheduleDate);
      onChanged();
      onClose();
    } catch (err: any) {
      setError(
        err?.code === "target_block_already_full"
          ? "That date's block already has a session locked."
          : "Couldn't reschedule — check the date and try again."
      );
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    setBusy(true);
    setError(null);
    try {
      await api.skipBlock(campaignId, date, "Skipped from calendar");
      onChanged();
      onClose();
    } catch {
      setError("Couldn't skip this block.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--pp-scrim)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="pp-card"
        style={{ width: "100%", maxWidth: 440, padding: 22, display: "grid", gap: 16, maxHeight: "85vh", overflowY: "auto" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
          <div>
            <h2 style={{ fontSize: 17 }}>{formatDateHuman(date)}</h2>
            {session && (
              <p style={{ fontSize: 12.5, marginTop: 4 }}>
                {session.status === "scheduled" && `Locked as Session ${session.session_number}`}
                {session.status === "completed" && `Session ${session.session_number} · played`}
                {session.status === "skipped" && "This block was skipped"}
              </p>
            )}
            {!session && candidate && (
              <p style={{ fontSize: 12.5, marginTop: 4 }}>
                Score {candidate.score}
                {!candidate.isDmAvailable && " · DM unavailable"}
                {candidate.isDmAvailable && !candidate.isAboveMinPlayers && " · below minimum players"}
              </p>
            )}
          </div>
          <button className="pp-btn pp-btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          {availability.members.map((m) => {
            const w = weightFor(maps, m.discordId, date);
            const flags = flagsFor(maps, m.discordId, date);
            const editable = m.discordId === user.discordId || canManage;
            return (
              <div key={m.discordId} style={{ display: "grid", gap: 4, opacity: m.excludedFromScoring ? 0.6 : 1 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.username}</span>
                    <RoleBadge role={m.role} />
                    <ScoreTag
                      score={contributionFor(maps, m.discordId, date, m.role === "DM", campaign)}
                      excluded={m.excludedFromScoring}
                    />
                  </div>
                  {editable ? (
                    <WeightPicker weight={w} onChange={(next) => saveResponse(m.discordId, next, flags.joiningLate, flags.droppingEarly)} disabled={busy} />
                  ) : (
                    <PipDisplay weight={w} />
                  )}
                </div>
                {canManage && (
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => toggleExclusion(m.discordId, m.excludedFromScoring)}
                      title="DM/root-only: excludes this member's responses from all scoring calculations campaign-wide"
                      style={{
                        fontSize: 10,
                        color: "var(--pp-ink-soft)",
                        background: "none",
                        border: "none",
                        textDecoration: "underline",
                        cursor: busy ? "default" : "pointer",
                        padding: 0,
                      }}
                    >
                      {m.excludedFromScoring ? "Include in scoring" : "Exclude from scoring"}
                    </button>
                  </div>
                )}
                {editable && (
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <FlagChip
                      label="Joining late"
                      active={flags.joiningLate}
                      disabled={busy}
                      onToggle={() => saveResponse(m.discordId, w, !flags.joiningLate, flags.droppingEarly)}
                    />
                    <FlagChip
                      label="Dropping early"
                      active={flags.droppingEarly}
                      disabled={busy}
                      onToggle={() => saveResponse(m.discordId, w, flags.joiningLate, !flags.droppingEarly)}
                    />
                  </div>
                )}
                {(flags.joiningLate || flags.droppingEarly) && !editable && (
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", fontSize: 10.5, color: "var(--pp-crimson)" }}>
                    {flags.joiningLate && "Joining late"}
                    {flags.joiningLate && flags.droppingEarly && " · "}
                    {flags.droppingEarly && "Dropping early"}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {error && <p style={{ color: "var(--pp-crimson)", fontSize: 13 }}>{error}</p>}

        {/* Always available, regardless of role — closing without locking/skipping/anything else is the normal path. */}
        <div style={{ borderTop: "1px solid var(--pp-line)", paddingTop: 14, display: "flex" }}>
          <button className="pp-btn pp-btn-primary" onClick={onClose}>
            Close
          </button>
        </div>

        {canManage && (
          <div style={{ display: "grid", gap: 10, borderTop: "1px solid var(--pp-line)", paddingTop: 14 }}>
            {!session && candidate && (
              <button className="pp-btn pp-btn-brass" disabled={busy} onClick={lock} style={{ justifySelf: "start" }}>
                Lock this date
              </button>
            )}

            {session?.status === "scheduled" && (
              <>
                <div className="pp-field" style={{ maxWidth: 260 }}>
                  <label htmlFor="reschedule-date">Reschedule to a different date</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      id="reschedule-date"
                      type="date"
                      className="pp-input"
                      value={rescheduleDate}
                      onChange={(e) => setRescheduleDate(e.target.value)}
                    />
                    <button className="pp-btn pp-btn-ghost" disabled={busy || !rescheduleDate} onClick={reschedule}>
                      Reschedule
                    </button>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button className="pp-btn pp-btn-ghost" disabled={busy} onClick={unlock} title="Reopens this block for a fresh lock">
                    Unlock session
                  </button>
                  <button
                    className="pp-btn pp-btn-danger"
                    disabled={busy}
                    onClick={cancelWholeBlock}
                    title="Calls off the whole block — won't be offered again"
                  >
                    Cancel this block
                  </button>
                </div>
              </>
            )}

            {!session && (
              <button className="pp-btn pp-btn-ghost" disabled={busy} onClick={skip} style={{ justifySelf: "start" }}>
                Skip this block
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
