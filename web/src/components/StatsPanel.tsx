import type { Stats } from "../api";

export function StatsPanel({ stats }: { stats: Stats }) {
  return (
    <div className="pp-card" style={{ padding: 18, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ fontSize: 15 }}>Attendance</h3>
        <span className="pp-mono" style={{ fontSize: 12, color: "var(--pp-ink-soft)" }}>
          {stats.campaignAgeDays} days running · {stats.sessionCounts.completed ?? 0} played ·{" "}
          {stats.sessionCounts.cancelled ?? 0} cancelled
        </span>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {stats.attendance.map((row) => (
          <div key={row.discordId} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
            <span>{row.username}</span>
            <span className="pp-mono" style={{ color: "var(--pp-ink-soft)" }}>
              {row.attendanceRate === null ? "—" : `${row.attendanceRate}%`}
              {row.totalSessions > 0 && ` (${row.totalSessions - row.totalAbsences}/${row.totalSessions})`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
