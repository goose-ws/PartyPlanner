import { Link } from "react-router-dom";
import { Logo } from "./Logo";
import { RoleBadge } from "./RoleBadge";
import { ThemeToggle } from "./ThemeToggle";
import type { AuthedUser } from "../api";
import { api } from "../api";

export function TopBar({ user, onLoggedOut }: { user: AuthedUser | null; onLoggedOut: () => void }) {
  return (
    <header className="pp-topbar">
      <Link to="/" className="pp-wordmark">
        <Logo />
        Party Planner
      </Link>
      <div className="pp-topbar-right">
        {user?.globalRole === "root" && <RoleBadge role="root" />}
        {user?.globalRole === "root" && (
          <Link to="/core-settings" className="pp-btn pp-btn-ghost" style={{ textDecoration: "none" }}>
            Core Settings
          </Link>
        )}
        {user && (
          <span className="pp-topbar-username" style={{ fontSize: 14, color: "var(--pp-ink-soft)" }}>
            {user.username}
          </span>
        )}
        <ThemeToggle />
        {user && (
          <button
            className="pp-btn pp-btn-ghost"
            onClick={async () => {
              await api.logout();
              onLoggedOut();
            }}
          >
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}
