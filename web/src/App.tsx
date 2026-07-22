import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { TopBar } from "./components/TopBar";
import { Home } from "./pages/Home";
import { CampaignDetail } from "./pages/CampaignDetail";
import { CampaignWelcome } from "./pages/CampaignWelcome";

function LoginPrompt() {
  return (
    <div className="pp-empty" style={{ paddingTop: 96 }}>
      <h1 style={{ fontSize: 26, marginBottom: 10 }}>Find a night that works.</h1>
      <p style={{ maxWidth: 380, margin: "0 auto 28px" }}>
        Sign in with Discord to see your campaigns and put in your availability.
      </p>
      <a href="/auth/login" className="pp-btn pp-btn-brass">
        Sign in with Discord
      </a>
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

          {auth.status === "anonymous" && <LoginPrompt />}

          {auth.status === "authenticated" && (
            <Routes>
              <Route path="/" element={<Home user={auth.user} />} />
              <Route path="/campaigns/:campaignId/welcome" element={<CampaignWelcome />} />
              <Route path="/campaigns/:campaignId" element={<CampaignDetail user={auth.user} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </main>
      </div>
    </BrowserRouter>
  );
}
