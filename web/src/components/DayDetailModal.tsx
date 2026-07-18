import { useState } from "react";
import { api, type AvailabilityAll, type CandidateDate, type Session, type AuthedUser } from "../api";
import { weightFor, buildAvailabilityMaps } from "../scheduling";
import { PipDisplay, WeightPicker } from "./PipMeter";
import { RoleBadge } from "./RoleBadge";
import { formatDateHuman, type DateStr } from "../dateMath";

export function DayDetailModal({
  date,
  campaignId,
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
  const isRoot = user.globalRole === "root";
  const isDm = campaignMyRole === "DM";
  const canManage = isRoot || isDm;
  const maps = buildAvailabilityMaps(availability);

  async function setWeight(discordId: string, weight: number) {
    setBusy(true);
    setError(null);
    try {
      await api.setSpecificAvailability(campaignId, date, weight, discordId === user.discordId ? undefined : discordId);
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

  async function cancel() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancelSession(campaignId, session.id);
      onChanged();
      onClose();
    } catch {
      setError("Couldn't cancel this session.");
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
        background: "rgba(27,35,64,0.35)",
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
                Score {candidate.score} {!candidate.isDmAvailable && "· DM unavailable"}
              </p>
            )}
          </div>
          <button className="pp-btn pp-btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {availability.members.map((m) => {
            const w = weightFor(maps, m.discordId, date);
            const editable = m.discordId === user.discordId || canManage;
            return (
              <div key={m.discordId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.username}</span>
                  <RoleBadge role={m.role} />
                </div>
                {editable ? (
                  <WeightPicker weight={w} onChange={(next) => setWeight(m.discordId, next)} disabled={busy} />
                ) : (
                  <PipDisplay weight={w} />
                )}
              </div>
            );
          })}
        </div>

        {error && <p style={{ color: "var(--pp-crimson)", fontSize: 13 }}>{error}</p>}

        {canManage && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", borderTop: "1px solid var(--pp-line)", paddingTop: 14 }}>
            {!session && candidate && (
              <button className="pp-btn pp-btn-brass" disabled={busy} onClick={lock}>
                Lock this date
              </button>
            )}
            {session?.status === "scheduled" && (
              <button className="pp-btn pp-btn-danger" disabled={busy} onClick={cancel}>
                Cancel session
              </button>
            )}
            {!session && (
              <button className="pp-btn pp-btn-ghost" disabled={busy} onClick={skip}>
                Skip this block
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
