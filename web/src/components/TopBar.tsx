import { Link } from "react-router-dom";
import { Logo } from "./Logo";
import { RoleBadge } from "./RoleBadge";
import type { AuthedUser } from "../api";
import { api } from "../api";

export function TopBar({ user, onLoggedOut }: { user: AuthedUser | null; onLoggedOut: () => void }) {
  return (
    <header className="pp-topbar">
      <Link to="/" className="pp-wordmark">
        <Logo />
        Party Planner
      </Link>
      {user && (
        <div className="pp-topbar-right">
          {user.globalRole === "root" && <RoleBadge role="root" />}
          <span className="pp-topbar-username" style={{ fontSize: 14, color: "var(--pp-ink-soft)" }}>
            {user.username}
          </span>
          <button
            className="pp-btn pp-btn-ghost"
            onClick={async () => {
              await api.logout();
              onLoggedOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}
