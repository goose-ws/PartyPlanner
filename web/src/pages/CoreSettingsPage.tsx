import { useEffect, useState } from "react";
import { api, type CoreSettings } from "../api";

function AuditLogViewer() {
  const [entries, setEntries] = useState<
    Array<{ id: number; campaignId: string | null; actorDiscordId: string | null; event: string; detail: Record<string, unknown> | null; createdAt: string }>
  >([]);
  const [eventFilter, setEventFilter] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  function load(reset: boolean) {
    setLoading(true);
    const before = reset ? undefined : entries[entries.length - 1]?.id;
    api
      .getAuditLog({ event: eventFilter || undefined, before })
      .then((res) => {
        setEntries(reset ? res.entries : [...entries, ...res.entries]);
        setHasMore(res.entries.length === 100);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => load(true), [eventFilter]);

  return (
    <div className="pp-card" style={{ padding: 18, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <h3 style={{ fontSize: 15 }}>Audit Log</h3>
        <input
          className="pp-input"
          style={{ maxWidth: 240 }}
          placeholder="Filter by event, e.g. session.locked"
          value={eventFilter}
          onChange={(e) => setEventFilter(e.target.value)}
        />
      </div>
      <p style={{ fontSize: 12, color: "var(--pp-ink-soft)" }}>
        Every mutating action across every campaign — session locks/cancels, invites, membership changes, availability
        edits, confirmations, reminders sent. Kept in the database rather than relying on container log retention, so
        it survives log rotation and restarts.
      </p>
      <div style={{ display: "grid", gap: 4 }}>
        {entries.length === 0 && !loading && <p style={{ fontSize: 13, color: "var(--pp-ink-soft)" }}>No matching entries.</p>}
        {entries.map((e) => (
          <div key={e.id} style={{ borderBottom: "1px solid var(--pp-line)", padding: "8px 0" }}>
            <div
              style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", cursor: "pointer" }}
              onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
            >
              <span className="pp-mono" style={{ fontSize: 11, color: "var(--pp-ink-faint)", minWidth: 145 }}>
                {new Date(e.createdAt).toLocaleString()}
              </span>
              <span
                className="pp-mono"
                style={{ fontSize: 11, fontWeight: 700, background: "var(--pp-bg)", border: "1px solid var(--pp-line)", borderRadius: 4, padding: "1px 6px" }}
              >
                {e.event}
              </span>
              {e.actorDiscordId && (
                <span className="pp-mono" style={{ fontSize: 11, color: "var(--pp-ink-soft)" }}>
                  by {e.actorDiscordId}
                </span>
              )}
              {e.campaignId && (
                <span className="pp-mono" style={{ fontSize: 11, color: "var(--pp-ink-faint)" }}>
                  campaign {e.campaignId.slice(0, 8)}…
                </span>
              )}
            </div>
            {expandedId === e.id && e.detail && (
              <pre
                className="pp-mono"
                style={{ fontSize: 11, background: "var(--pp-bg)", padding: 10, borderRadius: 6, marginTop: 6, overflowX: "auto" }}
              >
                {JSON.stringify(e.detail, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
      {hasMore && entries.length > 0 && (
        <button type="button" className="pp-btn pp-btn-ghost" disabled={loading} onClick={() => load(false)}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

function RevealableField({
  isSet,
  field,
  onSave,
}: {
  isSet: boolean;
  field: "dbPassword" | "discordClientSecret";
  onSave: (value: string) => void;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  async function reveal() {
    const res = await api.revealCoreSetting(field);
    setRevealed(res.value);
  }

  if (editing) {
    return (
      <div style={{ display: "flex", gap: 8 }}>
        <input className="pp-input" type="password" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="New value" />
        <button
          type="button"
          className="pp-btn pp-btn-primary"
          onClick={() => {
            onSave(draft);
            setEditing(false);
            setDraft("");
          }}
        >
          Save
        </button>
        <button type="button" className="pp-btn pp-btn-ghost" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span className="pp-mono" style={{ fontSize: 13 }}>
        {isSet ? revealed ?? "•".repeat(16) : "(not set)"}
      </span>
      {isSet && !revealed && (
        <button type="button" className="pp-btn pp-btn-ghost" onClick={reveal}>
          Reveal
        </button>
      )}
      <button type="button" className="pp-btn pp-btn-ghost" onClick={() => setEditing(true)}>
        {isSet ? "Change" : "Set"}
      </button>
    </div>
  );
}

export function CoreSettingsPage() {
  const [settings, setSettings] = useState<CoreSettings | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.getCoreSettings().then(setSettings).catch(() => setError("Couldn't load settings."));
  }
  useEffect(load, []);

  async function patch(fields: Record<string, unknown>) {
    setMessage(null);
    setError(null);
    try {
      const res = await api.updateCoreSettings(fields);
      setMessage(res.message);
      load();
    } catch {
      setError("Couldn't save that change.");
    }
  }

  async function regenerate(field: "regenerateSigningSecret" | "regenerateTokenEncryptionKey") {
    const warning =
      field === "regenerateSigningSecret"
        ? "This logs every signed-in user out immediately (including you). Continue?"
        : "This makes everyone's stored Discord token invalid — they'll just need to log in again via Discord, nothing else breaks. Continue?";
    if (!confirm(warning)) return;
    await patch({ [field]: true });
  }

  if (error) return <p style={{ color: "var(--pp-crimson)" }}>{error}</p>;
  if (!settings) return <p>Loading…</p>;

  return (
    <div style={{ display: "grid", gap: 24, maxWidth: 640 }}>
      <div>
        <h1 style={{ fontSize: 22 }}>Core Settings</h1>
        <p style={{ marginTop: 6 }}>
          These control the whole app, not one campaign. Almost every change here needs a container restart
          (<code className="pp-mono">docker compose restart partyplanner</code>) before it takes effect — saving just
          writes to config.json.
        </p>
      </div>

      {message && (
        <div className="pp-card" style={{ padding: 14, borderLeft: "3px solid var(--pp-brass)" }}>
          <p style={{ fontSize: 13.5 }}>{message}</p>
        </div>
      )}

      <div className="pp-card" style={{ padding: 18, display: "grid", gap: 14 }}>
        <h3 style={{ fontSize: 15 }}>App</h3>
        <div className="pp-field">
          <label>Public URL</label>
          <p style={{ fontSize: 13 }} className="pp-mono">
            {settings.publicUrl}
          </p>
          <p style={{ fontSize: 11.5 }}>The full URL Discord and invite links point back to. Must match your reverse proxy config.</p>
        </div>
      </div>

      <div className="pp-card" style={{ padding: 18, display: "grid", gap: 14 }}>
        <h3 style={{ fontSize: 15 }}>Database</h3>
        <div className="pp-field">
          <label>Host / port / user / database</label>
          <p className="pp-mono" style={{ fontSize: 13 }}>
            {settings.db.host}:{settings.db.port} · {settings.db.user} · {settings.db.database}
          </p>
        </div>
        <div className="pp-field">
          <label>Password</label>
          <RevealableField isSet={settings.db.passwordSet} field="dbPassword" onSave={(v) => patch({ dbPassword: v })} />
        </div>
      </div>

      <div className="pp-card" style={{ padding: 18, display: "grid", gap: 14 }}>
        <h3 style={{ fontSize: 15 }}>Discord</h3>
        <div className="pp-field">
          <label>Client ID</label>
          <p className="pp-mono" style={{ fontSize: 13 }}>
            {settings.discord.clientId}
          </p>
        </div>
        <div className="pp-field">
          <label>Client Secret</label>
          <RevealableField
            isSet={settings.discord.clientSecretSet}
            field="discordClientSecret"
            onSave={(v) => patch({ discordClientSecret: v })}
          />
        </div>
      </div>

      <div className="pp-card" style={{ padding: 18, display: "grid", gap: 14 }}>
        <h3 style={{ fontSize: 15 }}>Secrets</h3>
        <p style={{ fontSize: 12.5 }}>
          These are generated automatically and never displayed — there's nothing to look up, only to rotate if you
          have a specific reason to.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" className="pp-btn pp-btn-danger" onClick={() => regenerate("regenerateSigningSecret")}>
            Regenerate session signing secret
          </button>
          <button type="button" className="pp-btn pp-btn-danger" onClick={() => regenerate("regenerateTokenEncryptionKey")}>
            Regenerate token encryption key
          </button>
        </div>
      </div>

      <AuditLogViewer />
    </div>
  );
}
