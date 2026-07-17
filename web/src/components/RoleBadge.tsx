export type Role = "root" | "DM" | "Player";

const LABELS: Record<Role, string> = {
  root: "Root",
  DM: "DM",
  Player: "Player",
};

const CLASS_BY_ROLE: Record<Role, string> = {
  root: "pp-badge-root",
  DM: "pp-badge-dm",
  Player: "pp-badge-player",
};

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={`pp-badge ${CLASS_BY_ROLE[role]}`}>
      <span className="pp-badge-dot" />
      {LABELS[role]}
    </span>
  );
}
