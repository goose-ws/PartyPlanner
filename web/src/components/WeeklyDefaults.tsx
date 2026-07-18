import { useEffect, useState } from "react";
import { api } from "../api";
import { WeightPicker } from "./PipMeter";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function WeeklyDefaultsEditor({ campaignId, onSaved }: { campaignId: string; onSaved: () => void }) {
  const [weights, setWeights] = useState<number[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/availability/me`);
        const data = await res.json();
        const arr = Array(7).fill(0);
        for (const d of data.defaults ?? []) arr[d.dayOfWeek] = d.weight;
        setWeights(arr);
      } catch {
        setWeights(Array(7).fill(0));
      }
    })();
  }, [campaignId]);

  async function setDay(dayOfWeek: number, weight: number) {
    if (!weights) return;
    const next = [...weights];
    next[dayOfWeek] = weight;
    setWeights(next);
    setSaving(true);
    try {
      await api.setDefaultAvailability(campaignId, [{ dayOfWeek, weight }]);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  if (!weights) return null;

  return (
    <div className="pp-card" style={{ padding: 16 }}>
      <h3 style={{ fontSize: 14, marginBottom: 10 }}>
        Your weekly pattern {saving && <span style={{ color: "var(--pp-ink-soft)", fontWeight: 400 }}>· saving…</span>}
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
        This is your default for that day of the week going forward. Override any specific date on the calendar below.
      </p>
    </div>
  );
}
