import { useEffect, useState } from "react";
import { api } from "../api";
import { WeightPicker, PipDisplay } from "./PipMeter";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function WeeklyDefaultsEditor({
  campaignId,
  onSaved,
  discordId,
  title,
}: {
  campaignId: string;
  onSaved: () => void;
  /** When omitted, edits the caller's own defaults via /availability/me (the common case). When set (DM/root managing another member), reads and writes that member's defaults instead. */
  discordId?: string;
  title?: string;
}) {
  const [weights, setWeights] = useState<number[] | null>(null);
  const [saving, setSaving] = useState(false);
  // For someone ELSE's defaults, start read-only — WeightPicker writes and
  // clears their block confirmation on a single click, with no undo, so a
  // stray/misdirected click while just browsing another member's schedule
  // (the whole point of this view when opened from "view another player's
  // availability") would silently mutate real data and unconfirm them.
  // Editing your own is always live: there's no "who clicked by accident"
  // ambiguity there, and it's the low-stakes, expected-to-be-quick case.
  const [editing, setEditing] = useState(!discordId);

  useEffect(() => {
    setEditing(!discordId);
  }, [discordId]);

  useEffect(() => {
    setWeights(null);
    (async () => {
      try {
        const arr = Array(7).fill(0);
        if (discordId) {
          const data = await api.getAllAvailability(campaignId);
          for (const d of data.defaults) {
            if (d.discordId === discordId) arr[d.dayOfWeek] = d.weight;
          }
        } else {
          const res = await fetch(`/api/campaigns/${campaignId}/availability/me`);
          const data = await res.json();
          for (const d of data.defaults ?? []) arr[d.dayOfWeek] = d.weight;
        }
        setWeights(arr);
      } catch {
        setWeights(Array(7).fill(0));
      }
    })();
  }, [campaignId, discordId]);

  async function setDay(dayOfWeek: number, weight: number) {
    if (!weights) return;
    const next = [...weights];
    next[dayOfWeek] = weight;
    setWeights(next);
    setSaving(true);
    try {
      await api.setDefaultAvailability(campaignId, [{ dayOfWeek, weight }], discordId);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  if (!weights) return null;

  return (
    <div className="pp-card" style={{ padding: 16 }}>
      <h3 style={{ fontSize: 14, marginBottom: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span>{title ?? "Your default weekly availability"}</span>
        {saving && <span style={{ color: "var(--pp-ink-soft)", fontWeight: 400, fontSize: 12 }}>· saving…</span>}
        {discordId && !editing && (
          <button
            type="button"
            className="pp-btn pp-btn-ghost"
            style={{ fontSize: 11, padding: "2px 8px", marginLeft: "auto" }}
            onClick={() => setEditing(true)}
            title="Changing this writes real availability data for them and clears their confirmation for any affected block"
          >
            Enable editing
          </button>
        )}
        {discordId && editing && (
          <button
            type="button"
            className="pp-btn pp-btn-ghost"
            style={{ fontSize: 11, padding: "2px 8px", marginLeft: "auto" }}
            onClick={() => setEditing(false)}
          >
            Done editing
          </button>
        )}
      </h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {WEEKDAY_SHORT.map((label, i) => (
          <div key={i} style={{ display: "grid", justifyItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "var(--pp-ink-soft)", fontFamily: "var(--pp-font-mono)" }}>{label}</span>
            {editing ? (
              <WeightPicker weight={weights[i]!} onChange={(w) => setDay(i, w)} size={6} />
            ) : (
              <PipDisplay weight={weights[i]!} size={6} />
            )}
          </div>
        ))}
      </div>
      <p style={{ fontSize: 12, marginTop: 10 }}>
        {discordId
          ? editing
            ? "This is their default for that day of the week going forward. Override any specific date on the calendar. Changing a day here clears their confirmation for any block it affects."
            : "This is their default for that day of the week going forward, shown read-only. Click \"Enable editing\" to change it."
          : "This is your default for that day of the week going forward. Override any specific date on the calendar below."}
      </p>
    </div>
  );
}