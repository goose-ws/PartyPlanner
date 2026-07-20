import { useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { TopBar } from "./components/TopBar";
import { Home } from "./pages/Home";
import { CampaignDetail } from "./pages/CampaignDetail";
import { api, ApiError } from "./api";

const DEV_IDENTITIES = [
  { discordId: "test-dm", username: "Test DM" },
  { discordId: "test-player-1", username: "Test Player 1" },
  { discordId: "test-player-2", username: "Test Player 2" },
  { discordId: "test-player-3", username: "Test Player 3" },
];

function DevLoginPanel({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function login(discordId: string, username: string) {
    setError(null);
    try {
      await api.devLogin(discordId, username);
      onLoggedIn();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? "Dev login is disabled on this deployment (set DEV_FAKE_LOGIN=true to enable it)."
          : "Dev login failed."
      );
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ marginTop: 40, background: "none", border: "none", color: "var(--pp-ink-soft)", fontSize: 12, cursor: "pointer" }}
      >
        Dev tools
      </button>
    );
  }

  return (
    <div className="pp-card" style={{ marginTop: 24, padding: 16, display: "inline-grid", gap: 10, textAlign: "left" }}>
      <p style={{ fontSize: 12, color: "var(--pp-ink-soft)" }}>
        Test accounts — no real Discord login. Only works if the server has DEV_FAKE_LOGIN enabled.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {DEV_IDENTITIES.map((id) => (
          <button key={id.discordId} className="pp-btn pp-btn-ghost" onClick={() => login(id.discordId, id.username)}>
            {id.username}
          </button>
        ))}
      </div>
      {error && <p style={{ color: "var(--pp-crimson)", fontSize: 12.5 }}>{error}</p>}
    </div>
  );
}

function LoginPrompt({ onDevLoggedIn }: { onDevLoggedIn: () => void }) {
  return (
    <div className="pp-empty" style={{ paddingTop: 96 }}>
      <h1 style={{ fontSize: 26, marginBottom: 10 }}>Find a night that works.</h1>
      <p style={{ maxWidth: 380, margin: "0 auto 28px" }}>
        Sign in with Discord to see your campaigns and put in your availability.
      </p>
      <a href="/auth/login" className="pp-btn pp-btn-brass">
        Sign in with Discord
      </a>
      <div>
        <DevLoginPanel onLoggedIn={onDevLoggedIn} />
      </div>
    </div>
  );
}

export default function App() {
  const auth = useAuth();

  return (
    <BrowserRouter>
      <div className="pp-shell">
        <TopBar user={auth.status === "authenticated" ? auth.user : null} onLoggedOut={auth.refresh} />
        <main className="pp-main">
          {auth.status === "loading" && <p>Loading…</p>}

          {auth.status === "anonymous" && <LoginPrompt onDevLoggedIn={auth.refresh} />}

          {auth.status === "authenticated" && (
            <Routes>
              <Route path="/" element={<Home user={auth.user} />} />
              <Route path="/campaigns/:campaignId" element={<CampaignDetail user={auth.user} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </main>
      </div>
    </BrowserRouter>
  );
}
