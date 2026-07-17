import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, ApiError, type Campaign, type Invite, type AuthedUser } from "../api";
import { RoleBadge } from "../components/RoleBadge";

function InviteRow({ invite, onRevoke }: { invite: Invite; onRevoke: () => void }) {
  const [copied, setCopied] = useState(false);
  const isDead = !!invite.revokedAt || (invite.expiresAt && new Date(invite.expiresAt) < new Date());

  return (
    <div
      className="pp-card"
      style={{
        padding: "14px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        opacity: isDead ? 0.5 : 1,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div className="pp-mono" style={{ fontSize: 13, wordBreak: "break-all" }}>
          {invite.url}
        </div>
        <div style={{ fontSize: 12, color: "var(--pp-ink-soft)", marginTop: 4 }}>
          {invite.role} invite · used {invite.uses}
          {invite.maxUses !== null ? `/${invite.maxUses}` : ""} times
          {invite.expiresAt ? ` · expires ${new Date(invite.expiresAt).toLocaleDateString()}` : ""}
          {invite.revokedAt ? " · revoked" : ""}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button
          className="pp-btn pp-btn-ghost"
          onClick={() => {
            navigator.clipboard.writeText(invite.url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {!isDead && (
          <button className="pp-btn pp-btn-danger" onClick={onRevoke}>
            Revoke
          </button>
        )}
      </div>
    </div>
  );
}

function InviteManager({ campaignId, canGrantDm }: { campaignId: string; canGrantDm: boolean }) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [role, setRole] = useState<"Player" | "DM">("Player");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api
      .listInvites(campaignId)
      .then(({ invites }) => setInvites(invites))
      .catch(() => setError("Couldn't load invites."));
  }

  useEffect(load, [campaignId]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createInvite(campaignId, { role, email: email.trim() || undefined });
      setEmail("");
      load();
    } catch {
      setError("Couldn't create the invite.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(token: string) {
    await api.revokeInvite(campaignId, token);
    load();
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h2 style={{ fontSize: 17 }}>Invites</h2>

      <form onSubmit={create} className="pp-card" style={{ padding: 18, display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: canGrantDm ? "auto 1fr auto" : "1fr auto", gap: 12, alignItems: "end" }}>
          {canGrantDm && (
            <div className="pp-field">
              <label htmlFor="invite-role">Role</label>
              <select
                id="invite-role"
                className="pp-select"
                value={role}
                onChange={(e) => setRole(e.target.value as "Player" | "DM")}
              >
                <option value="Player">Player</option>
                <option value="DM">DM</option>
              </select>
            </div>
          )}
          <div className="pp-field">
            <label htmlFor="invite-email">Email (optional)</label>
            <input
              id="invite-email"
              type="email"
              className="pp-input"
              placeholder="Only if you want it emailed"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <button className="pp-btn pp-btn-primary" disabled={busy} type="submit">
            {busy ? "Creating…" : "Create link"}
          </button>
        </div>
        {error && <p style={{ color: "var(--pp-crimson)", fontSize: 13 }}>{error}</p>}
      </form>

      {invites === null && <p>Loading invites…</p>}
      {invites?.length === 0 && (
        <div className="pp-empty">
          <p>No invites yet. Create one above to bring in a player.</p>
        </div>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {invites?.map((inv) => (
          <InviteRow key={inv.token} invite={inv} onRevoke={() => revoke(inv.token)} />
        ))}
      </div>
    </div>
  );
}

function MemberManager({ campaignId, isRoot }: { campaignId: string; isRoot: boolean }) {
  const [members, setMembers] = useState<{ discord_id: string; username: string; role: "DM" | "Player" }[] | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  function load() {
    api
      .listMembers(campaignId)
      .then(({ members }) => setMembers(members))
      .catch(() => setError("Couldn't load members."));
  }

  useEffect(load, [campaignId]);

  async function changeRole(discordId: string, role: "DM" | "Player") {
    setPendingId(discordId);
    try {
      await api.setMemberRole(campaignId, discordId, role);
      load();
    } catch {
      setError("Couldn't update that member's role.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h2 style={{ fontSize: 17 }}>Members</h2>
      {error && <p style={{ color: "var(--pp-crimson)", fontSize: 13 }}>{error}</p>}
      {members === null && !error && <p>Loading members…</p>}
      {members?.length === 0 && (
        <div className="pp-empty">
          <p>No one's joined yet — send an invite link above.</p>
        </div>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {members?.map((m) => (
          <div
            key={m.discord_id}
            className="pp-card"
            style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}
          >
            <span style={{ fontSize: 14 }}>{m.username}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <RoleBadge role={m.role} />
              {isRoot && (
                <button
                  className="pp-btn pp-btn-ghost"
                  disabled={pendingId === m.discord_id}
                  onClick={() => changeRole(m.discord_id, m.role === "DM" ? "Player" : "DM")}
                >
                  {pendingId === m.discord_id ? "Updating…" : m.role === "DM" ? "Make Player" : "Make DM"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsPanel({ campaign, onUpdated }: { campaign: Campaign; onUpdated: (c: Campaign) => void }) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(campaign.session_time_start.slice(0, 5));
  const [end, setEnd] = useState(campaign.session_time_end.slice(0, 5));
  const [timezone, setTimezone] = useState(campaign.timezone);
  const [intervalWeeks, setIntervalWeeks] = useState(campaign.interval_weeks);
  const [sessionsPerInterval, setSessionsPerInterval] = useState(campaign.sessions_per_interval);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateCampaign(campaign.id, {
        sessionTimeStart: start,
        sessionTimeEnd: end,
        timezone,
        intervalWeeks,
        sessionsPerInterval,
      });
      onUpdated(updated);
      setOpen(false);
    } catch {
      setError("Couldn't save — check the values and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="pp-btn pp-btn-ghost" onClick={() => setOpen(true)} style={{ justifySelf: "start" }}>
        Edit settings
      </button>
    );
  }

  return (
    <form onSubmit={save} className="pp-card" style={{ padding: 18, display: "grid", gap: 14 }}>
      <h3 style={{ fontSize: 15 }}>Campaign settings</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="pp-field">
          <label htmlFor="s-start">Session start</label>
          <input id="s-start" type="time" className="pp-input" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="pp-field">
          <label htmlFor="s-end">Session end</label>
          <input id="s-end" type="time" className="pp-input" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <div className="pp-field" style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="s-tz">Timezone (IANA name)</label>
          <input
            id="s-tz"
            className="pp-input"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="America/New_York"
          />
        </div>
        <div className="pp-field">
          <label htmlFor="s-interval">Block length (weeks)</label>
          <input
            id="s-interval"
            type="number"
            min={1}
            className="pp-input"
            value={intervalWeeks}
            onChange={(e) => setIntervalWeeks(Number(e.target.value))}
          />
        </div>
        <div className="pp-field">
          <label htmlFor="s-per">Sessions per block</label>
          <input
            id="s-per"
            type="number"
            min={1}
            className="pp-input"
            value={sessionsPerInterval}
            onChange={(e) => setSessionsPerInterval(Number(e.target.value))}
          />
        </div>
      </div>
      {error && <p style={{ color: "var(--pp-crimson)", fontSize: 13 }}>{error}</p>}
      <div style={{ display: "flex", gap: 10 }}>
        <button className="pp-btn pp-btn-primary" disabled={busy} type="submit">
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="pp-btn pp-btn-ghost" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const CADENCE_LABEL: Record<Campaign["cadence_type"], string> = {
  "bi-weekly": "Every 2 weeks",
  custom_interval: "Custom interval",
  weekly_static: "Weekly",
};

export function CampaignDetail({ user }: { user: AuthedUser }) {
  const { campaignId } = useParams<{ campaignId: string }>();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!campaignId) return;
    api
      .getCampaign(campaignId)
      .then(({ campaign }) => setCampaign(campaign))
      .catch((err) =>
        setError(err instanceof ApiError && err.status === 403 ? "You're not part of this campaign." : "Campaign not found.")
      );
  }, [campaignId]);

  if (error) {
    return (
      <div className="pp-empty">
        <p>{error}</p>
        <Link to="/" className="pp-btn pp-btn-ghost" style={{ marginTop: 16 }}>
          Back to campaigns
        </Link>
      </div>
    );
  }

  if (!campaign || !campaignId) return <p>Loading…</p>;

  const canManageInvites = user.globalRole === "root" || campaign.myRole === "DM";

  return (
    <div style={{ display: "grid", gap: 32 }}>
      <div>
        <Link to="/" style={{ fontSize: 13, color: "var(--pp-ink-soft)", textDecoration: "none" }}>
          ← All campaigns
        </Link>
        <h1 style={{ fontSize: 24, marginTop: 8 }}>{campaign.name}</h1>
        <p className="pp-mono" style={{ fontSize: 12.5, marginTop: 6 }}>
          {CADENCE_LABEL[campaign.cadence_type]} · anchored {campaign.start_date} · {campaign.session_time_start.slice(0, 5)}–
          {campaign.session_time_end.slice(0, 5)} {campaign.timezone}
        </p>
      </div>

      {user.globalRole === "root" && <SettingsPanel campaign={campaign} onUpdated={setCampaign} />}

      {canManageInvites ? (
        <>
          <MemberManager campaignId={campaignId} isRoot={user.globalRole === "root"} />
          <InviteManager campaignId={campaignId} canGrantDm={user.globalRole === "root"} />
        </>
      ) : (
        <div className="pp-empty">
          <p>The scheduling grid for this campaign isn't built yet — check back soon.</p>
        </div>
      )}
    </div>
  );
}
