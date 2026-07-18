const WEIGHT_LABELS = ["No", "Maybe", "If Needed", "Yes"] as const;
const WEIGHT_COLORS = ["var(--pp-crimson)", "var(--pp-ink-soft)", "var(--pp-brass-dark)", "var(--pp-brass)"];

export function weightLabel(weight: number): string {
  return WEIGHT_LABELS[weight] ?? "Unknown";
}

function Pips({ weight, size = 7 }: { weight: number; size?: number }) {
  const color = WEIGHT_COLORS[weight] ?? WEIGHT_COLORS[0];
  if (weight === 0) {
    return (
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: size,
          height: size,
          borderRadius: "50%",
          border: `1.5px solid ${color}`,
        }}
      />
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 2 }} aria-hidden="true">
      {Array.from({ length: 3 }, (_, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            width: size,
            height: size,
            borderRadius: "50%",
            background: i < weight ? color : "transparent",
            border: i < weight ? "none" : "1.5px solid var(--pp-line)",
          }}
        />
      ))}
    </span>
  );
}

/** Static, read-only weight indicator — used when viewing another member's response. */
export function PipDisplay({ weight, size }: { weight: number; size?: number }) {
  return (
    <span title={weightLabel(weight)} style={{ display: "inline-flex", alignItems: "center" }}>
      <Pips weight={weight} size={size} />
    </span>
  );
}

/** Interactive weight control — click cycles No -> Maybe -> If Needed -> Yes -> No. */
export function WeightPicker({
  weight,
  onChange,
  size,
  disabled,
}: {
  weight: number;
  onChange: (next: number) => void;
  size?: number;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange((weight + 1) % 4)}
      title={`${weightLabel(weight)} — click to change`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        border: "1px solid var(--pp-line)",
        borderRadius: 999,
        padding: "4px 10px",
        background: "var(--pp-surface)",
        cursor: disabled ? "default" : "pointer",
        fontSize: 12,
        fontFamily: "var(--pp-font-mono)",
        color: "var(--pp-ink)",
      }}
    >
      <Pips weight={weight} size={size} />
      {weightLabel(weight)}
    </button>
  );
}
