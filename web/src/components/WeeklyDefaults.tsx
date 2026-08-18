import { useEffect, useState } from "react";
import { api } from "../api";
import { WeightPicker } from "./PipMeter";

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
      <h3 style={{ fontSize: 14, marginBottom: 10 }}>
        {title ?? "Your default weekly availability"}{" "}
        {saving && <span style={{ color: "var(--pp-ink-soft)", fontWeight: 400 }}>· saving…</span>}
      </h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {WEEKDAY_SHORT.map((label, i) => (
          <div key={i} style={{ display: "grid", justifyItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "var(--pp-ink-soft)", fontFamily: "var(--pp-font-mono)" }}>{label}</span>
            <WeightPicker weight={weights[i]!} onChange={(w) => setDay(i, w)} size={6} />
          </div>
        ))}
      </div>
      <p style={{ fontSize: 12, marginTop: 10 }}>
        {discordId
          ? "This is their default for that day of the week going forward. Override any specific date on the calendar."
          : "This is your default for that day of the week going forward. Override any specific date on the calendar below."}
      </p>
    </div>
  );
}
