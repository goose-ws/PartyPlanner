import { useState } from "react";
import { api, type Member } from "../api";

export function BackfillSessionForm({ campaignId, members, onDone }: { campaignId: string; members: Member[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [sessionNumber, setSessionNumber] = useState("");
  const [date, setDate] = useState("");
  const [status, setStatus] = useState<"completed" | "cancelled" | "skipped">("completed");
  const [notes, setNotes] = useState("");
  const [absent, setAbsent] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleAbsent(discordId: string) {
    setAbsent((prev) => {
      const next = new Set(prev);
      if (next.has(discordId)) next.delete(discordId);
      else next.add(discordId);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!date) return;
    setBusy(true);
    setError(null);
    try {
      await api.backfillSession(campaignId, {
        sessionNumber: sessionNumber ? Number(sessionNumber) : null,
        date,
        status,
        notes: notes || undefined,
        absentDiscordIds: [...absent],
      });
      setSessionNumber("");
      setDate("");
      setNotes("");
      setAbsent(new Set());
      setOpen(false);
      onDone();
    } catch (err: any) {
      setError(
        err?.code === "session_number_already_used"
          ? "That session number's already in use."
          : "Couldn't save that session — check the fields and try again."
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="pp-btn pp-btn-ghost" onClick={() => setOpen(true)}>
        Backfill a past session
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="pp-card" style={{ padding: 18, display: "grid", gap: 14 }}>
      <h3 style={{ fontSize: 15 }}>Backfill a past session</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <div className="pp-field">
          <label htmlFor="bf-number">Session #{status !== "completed" && " (optional)"}</label>
          <input
            id="bf-number"
            type="number"
            min={1}
            className="pp-input"
            value={sessionNumber}
            onChange={(e) => setSessionNumber(e.target.value)}
            placeholder="e.g. 7"
          />
        </div>
        <div className="pp-field">
          <label htmlFor="bf-date">Date</label>
          <input id="bf-date" type="date" className="pp-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="pp-field">
          <label htmlFor="bf-status">Status</label>
          <select id="bf-status" className="pp-select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="skipped">Skipped</option>
          </select>
        </div>
      </div>

      <div className="pp-field">
        <label htmlFor="bf-notes">Notes (optional)</label>
        <input id="bf-notes" className="pp-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Ran at a friend's place" />
      </div>

      {status === "completed" && (
        <div>
          <label style={{ fontSize: 13, fontWeight: 600, color: "var(--pp-ink-soft)" }}>Who was there?</label>
          <p style={{ fontSize: 12, marginTop: 2, marginBottom: 8 }}>Everyone's assumed present — uncheck anyone who missed it.</p>
          <div style={{ display: "grid", gap: 6 }}>
            {members.map((m) => (
              <label key={m.discordId} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                <input type="checkbox" checked={!absent.has(m.discordId)} onChange={() => toggleAbsent(m.discordId)} />
                {m.username}
              </label>
            ))}
          </div>
        </div>
      )}

      {error && <p style={{ color: "var(--pp-crimson)", fontSize: 13 }}>{error}</p>}

      <div style={{ display: "flex", gap: 10 }}>
        <button className="pp-btn pp-btn-primary" disabled={busy || !date} type="submit">
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="pp-btn pp-btn-ghost" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
