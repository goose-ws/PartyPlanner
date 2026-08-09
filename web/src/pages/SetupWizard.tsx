import { useState } from "react";
import { api, ApiError } from "../api";
import { Logo } from "../components/Logo";

const FIELDS: Array<{ key: string; label: string; hint: string; type?: string }> = [
  { key: "publicUrl", label: "Public URL", hint: "The full URL this app is reachable at, e.g. https://partyplanner.example.com" },
  { key: "dbHost", label: "Database host", hint: "Hostname or Docker service name of your MariaDB instance" },
  { key: "dbPort", label: "Database port", hint: "Defaults to 3306 if left blank" },
  { key: "dbUser", label: "Database user", hint: "" },
  { key: "dbName", label: "Database name", hint: "" },
  { key: "dbPassword", label: "Database password", hint: "", type: "password" },
  { key: "discordClientId", label: "Discord Client ID", hint: "From your app on discord.com/developers/applications" },
  { key: "discordClientSecret", label: "Discord Client Secret", hint: "Same page — Reset Secret if you don't have it handy", type: "password" },
  { key: "initialRootDiscordId", label: "Your Discord user ID", hint: "This account becomes the first root admin" },
];

export function SetupWizard() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function setField(key: string, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.completeSetup(values as any);
      setDone(res.message);
    } catch (err: any) {
      setError(err instanceof ApiError ? `Missing or invalid: ${err.code}` : "Something went wrong — check the fields and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="pp-empty" style={{ maxWidth: 480, margin: "80px auto 0" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
          <Logo size={34} />
        </div>
        <h1 style={{ fontSize: 22, marginBottom: 10 }}>Configuration saved.</h1>
        <p>{done}</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: "48px auto 0" }}>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
          <Logo size={34} />
        </div>
        <h1 style={{ fontSize: 22 }}>Let's set up Party Planner.</h1>
        <p style={{ marginTop: 6 }}>This runs once. Everything here is saved to config.json on the server.</p>
      </div>

      <form onSubmit={submit} className="pp-card" style={{ padding: 22, display: "grid", gap: 14 }}>
        {FIELDS.map((f) => (
          <div className="pp-field" key={f.key}>
            <label htmlFor={f.key}>{f.label}</label>
            <input
              id={f.key}
              type={f.type ?? "text"}
              className="pp-input"
              value={values[f.key] ?? ""}
              onChange={(e) => setField(f.key, e.target.value)}
            />
            {f.hint && <p style={{ fontSize: 11.5 }}>{f.hint}</p>}
          </div>
        ))}

        {error && <p style={{ color: "var(--pp-crimson)", fontSize: 13 }}>{error}</p>}

        <button className="pp-btn pp-btn-brass" disabled={busy} type="submit">
          {busy ? "Saving…" : "Save & finish setup"}
        </button>
      </form>
    </div>
  );
}
