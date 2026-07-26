import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { TopBar } from "./components/TopBar";
import { Home } from "./pages/Home";
import { CampaignDetail } from "./pages/CampaignDetail";
import { CampaignWelcome } from "./pages/CampaignWelcome";
import { SetupWizard } from "./pages/SetupWizard";
import { CoreSettingsPage } from "./pages/CoreSettingsPage";
import { api } from "./api";

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

/** Checked once before anything else renders — if the backend reports setup isn't complete, the wizard is the ONLY thing shown, no auth/login flow at all. */
function useSetupStatus() {
  const [status, setStatus] = useState<"checking" | "incomplete" | "complete">("checking");
  useEffect(() => {
    api
      .getSetupStatus()
      .then((s) => setStatus(s.complete ? "complete" : "incomplete"))
      .catch(() => setStatus("complete")); // fail open to the normal app rather than getting stuck
  }, []);
  return status;
}

export default function App() {
  const setupStatus = useSetupStatus();
  const auth = useAuth();

  if (setupStatus === "checking") return null;

  if (setupStatus === "incomplete") {
    return (
      <div className="pp-shell">
        <main className="pp-main">
          <SetupWizard />
        </main>
      </div>
    );
  }

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
              {auth.user.globalRole === "root" && <Route path="/core-settings" element={<CoreSettingsPage />} />}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </main>
      </div>
    </BrowserRouter>
  );
}
