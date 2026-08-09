import { useEffect, useState } from "react";
import { api } from "../api";
import { formatDateHuman } from "../dateMath";
import type { Member } from "../api";

interface BlockStatusEntry {
  block: { index: number; start: string; end: string };
  confirmations: Record<string, boolean>;
  youConfirmed: boolean;
}

function blockEndDisplay(end: string): string {
  const d = new Date(end + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1); // end is exclusive
  return d.toISOString().slice(0, 10);
}

function OneBlockCard({
  entry,
  members,
  canManage,
  campaignId,
  onChanged,
}: {
  entry: BlockStatusEntry;
  members: Member[];
  canManage: boolean;
  campaignId: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await api.setBlockConfirmation(campaignId, entry.block.start, !entry.youConfirmed);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function toggleMember(discordId: string, currentlyConfirmed: boolean) {
    setPendingId(discordId);
    try {
      await api.setMemberBlockConfirmation(campaignId, discordId, entry.block.start, !currentlyConfirmed);
      onChanged();
    } finally {
      setPendingId(null);
    }
  }

  const confirmedCount = members.filter((m) => entry.confirmations[m.discordId]).length;
  const unconfirmedMembers = members.filter((m) => !entry.confirmations[m.discordId]);

  return (
    <div className="pp-card" style={{ padding: "14px 18px", display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <span className="pp-mono" style={{ fontSize: 11, color: "var(--pp-ink-soft)", letterSpacing: "0.04em" }}>
            AVAILABILITY CHECK-IN
          </span>
          <p style={{ fontSize: 14.5, marginTop: 2 }}>
            {formatDateHuman(entry.block.start)} – {formatDateHuman(blockEndDisplay(entry.block.end))}
          </p>
        </div>
        <button className="pp-btn pp-btn-primary" disabled={busy} onClick={toggle}>
          {entry.youConfirmed ? "✓ You're confirmed" : "Confirm my availability"}
        </button>
      </div>
      {canManage && (
        <div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{ fontSize: 12, color: "var(--pp-ink-soft)", background: "none", border: "none", padding: 0, cursor: "pointer" }}
          >
            {confirmedCount}/{members.length} confirmed
            {unconfirmedMembers.length > 0 && <> — waiting on {unconfirmedMembers.map((m) => m.username).join(", ")}</>}{" "}
            <span style={{ textDecoration: "underline" }}>{expanded ? "hide" : "manage"}</span>
          </button>
          {expanded && (
            <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
              {members.map((m) => {
                const confirmed = !!entry.confirmations[m.discordId];
                return (
                  <div
                    key={m.discordId}
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 13, flexWrap: "wrap" }}
                  >
                    <span>
                      {confirmed ? "✅" : "⬜"} {m.username}
                    </span>
                    <button
                      className="pp-btn pp-btn-ghost"
                      disabled={pendingId === m.discordId}
                      onClick={() => toggleMember(m.discordId, confirmed)}
                      title="DM/root override — confirms or unconfirms on this member's behalf"
                      style={{ fontSize: 12, padding: "3px 9px" }}
                    >
                      {pendingId === m.discordId ? "Updating…" : confirmed ? "Unconfirm" : "Confirm"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One check-in card per currently-open, confirmable block — usually just
 * one (the immediate next block), but campaign.confirm_ahead_sessions can
 * open this up to several blocks ahead for a table that plans further out.
 */
export function BlockConfirmation({
  campaignId,
  members,
  canManage,
}: {
  campaignId: string;
  members: Member[];
  canManage: boolean;
}) {
  const [entries, setEntries] = useState<BlockStatusEntry[] | null>(null);

  function load() {
    api
      .getBlockStatus(campaignId)
      .then((res) => setEntries(res.blocks))
      .catch(() => {});
  }

  useEffect(load, [campaignId]);

  if (!entries || entries.length === 0) return null;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {entries.map((entry) => (
        <OneBlockCard
          key={entry.block.start}
          entry={entry}
          members={members}
          canManage={canManage}
          campaignId={campaignId}
          onChanged={load}
        />
      ))}
    </div>
  );
}
