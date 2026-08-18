import { useEffect, useState } from "react";
import { api, ApiError, type Campaign } from "../api";
import { CampaignCard } from "../components/CampaignCard";
import type { AuthedUser } from "../api";

function NewCampaignForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !startDate) return;
    setBusy(true);
    setError(null);
    try {
      await api.createCampaign({ name: name.trim(), startDate });
      setName("");
      setStartDate("");
      onCreated();
    } catch {
      setError("Couldn't create the campaign — check the fields and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="pp-card" style={{ padding: 20, display: "grid", gap: 14 }}>
      <h3 style={{ fontSize: 15 }}>New campaign</h3>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr) auto", gap: 12, alignItems: "end" }}>
        <div className="pp-field">
          <label htmlFor="campaign-name">Name</label>
          <input
            id="campaign-name"
            className="pp-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Curse of Strahd"
          />
        </div>
        <div className="pp-field">
          <label htmlFor="campaign-start">Anchor date</label>
          <input
            id="campaign-start"
            type="date"
            className="pp-input"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <button className="pp-btn pp-btn-primary" disabled={busy} type="submit">
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
      {error && <p style={{ color: "var(--pp-crimson)", fontSize: 13 }}>{error}</p>}
    </form>
  );
}

export function Home({ user }: { user: AuthedUser }) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api
      .listCampaigns()
      .then(({ campaigns }) => setCampaigns(campaigns))
      .catch((err) => setError(err instanceof ApiError ? err.code : "Failed to load campaigns."));
  }

  useEffect(load, []);

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 22 }}>Welcome back, {user.username}.</h1>
        <p style={{ marginTop: 4 }}>
          {user.globalRole === "root" ? "You manage every campaign here." : "Here's what your tables are up to."}
        </p>
      </div>

      {user.globalRole === "root" && <NewCampaignForm onCreated={load} />}

      {error && <p style={{ color: "var(--pp-crimson)" }}>{error}</p>}

      {campaigns === null && !error && <p>Loading campaigns…</p>}

      {campaigns?.length === 0 && (
        <div className="pp-empty">
          <p>No campaigns yet. {user.globalRole === "root" ? "Create one above to get started." : "Ask your DM for an invite link."}</p>
        </div>
      )}

      {campaigns && campaigns.length > 0 && (
        <div style={{ display: "grid", gap: 10 }}>
          {campaigns.map((c) => (
            <CampaignCard key={c.id} campaign={c} />
          ))}
        </div>
      )}
    </div>
  );
}
