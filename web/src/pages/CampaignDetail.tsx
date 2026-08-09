import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, ApiError, type Campaign, type Invite, type AuthedUser } from "../api";
import { RoleBadge } from "../components/RoleBadge";
import { WeeklyDefaultsEditor } from "../components/WeeklyDefaults";
import { CalendarMonth } from "../components/CalendarMonth";
import { DayDetailModal } from "../components/DayDetailModal";
import { SessionsList } from "../components/SessionsList";
import { StatsPanel } from "../components/StatsPanel";
import { NextUpBanner } from "../components/NextUpBanner";
import { BlockConfirmation } from "../components/BlockConfirmation";
import { BackfillSessionForm } from "../components/BackfillSessionForm";
import { Tabs } from "../components/Tabs";
import { useSchedulingData } from "../hooks/useSchedulingData";
import type { DateStr } from "../dateMath";

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
      await api.createInvite(campaignId, { role });
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
        <div style={{ display: "grid", gridTemplateColumns: canGrantDm ? "auto auto" : "auto", gap: 12, alignItems: "end" }}>
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
  const [members, setMembers] = useState<
    { discord_id: string; username: string; role: "DM" | "Player"; excluded_from_scoring: boolean }[] | null
  >(null);
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
    if (role === "DM") {
      const priorDm = members?.find((m) => m.role === "DM" && m.discord_id !== discordId);
      if (priorDm && !confirm(`Only one DM per campaign. This will move ${priorDm.username} to Player. Continue?`)) {
        return;
      }
    }
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

  async function toggleExclusion(discordId: string, currentlyExcluded: boolean) {
    setPendingId(discordId);
    try {
      await api.setMemberExclusion(campaignId, discordId, !currentlyExcluded);
      load();
    } catch {
      setError("Couldn't update that member's scoring exclusion.");
    } finally {
      setPendingId(null);
    }
  }

  async function remove(discordId: string, username: string) {
    if (!confirm(`Remove ${username} from this campaign? Their past responses stay on record.`)) return;
    setPendingId(discordId);
    try {
      await api.removeMember(campaignId, discordId);
      load();
    } catch {
      setError("Couldn't remove that member.");
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
        {members?.map((m) => {
          const canRemove = isRoot || m.role === "Player";
          return (
            <div
              key={m.discord_id}
              className="pp-card"
              style={{
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
                opacity: m.excluded_from_scoring ? 0.7 : 1,
              }}
            >
              <span style={{ fontSize: 14, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.username}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {m.excluded_from_scoring && (
                  <span
                    className="pp-mono"
                    title="This member's responses are ignored by all scoring calculations"
                    style={{ fontSize: 10, color: "var(--pp-ink-soft)", fontStyle: "italic" }}
                  >
                    excluded from scoring
                  </span>
                )}
                <RoleBadge role={m.role} />
                <button
                  className="pp-btn pp-btn-ghost"
                  disabled={pendingId === m.discord_id}
                  onClick={() => toggleExclusion(m.discord_id, m.excluded_from_scoring)}
                  title="DM/root-only: ignore this member's availability in all scoring calculations campaign-wide"
                >
                  {pendingId === m.discord_id ? "Updating…" : m.excluded_from_scoring ? "Include in scoring" : "Exclude from scoring"}
                </button>
                {isRoot && (
                  <button
                    className="pp-btn pp-btn-ghost"
                    disabled={pendingId === m.discord_id}
                    onClick={() => changeRole(m.discord_id, m.role === "DM" ? "Player" : "DM")}
                  >
                    {pendingId === m.discord_id ? "Updating…" : m.role === "DM" ? "Make Player" : "Make DM"}
                  </button>
                )}
                {canRemove && (
                  <button
                    className="pp-btn pp-btn-danger"
                    disabled={pendingId === m.discord_id}
                    onClick={() => remove(m.discord_id, m.username)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SettingsPanel({
  campaign,
  onUpdated,
  alwaysOpen,
}: {
  campaign: Campaign;
  onUpdated: (c: Campaign) => void;
  alwaysOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!alwaysOpen);
  const [start, setStart] = useState(campaign.session_time_start.slice(0, 5));
  const [end, setEnd] = useState(campaign.session_time_end.slice(0, 5));
  const [timezone, setTimezone] = useState(campaign.timezone);
  const [intervalWeeks, setIntervalWeeks] = useState(campaign.interval_weeks);
  const [sessionsPerInterval, setSessionsPerInterval] = useState(campaign.sessions_per_interval);
  const [blackoutDaysAfterLock, setBlackoutDaysAfterLock] = useState(campaign.blackout_days_after_lock);
  const [minPlayersRequired, setMinPlayersRequired] = useState(campaign.min_players_required);
  const [webhookUrl, setWebhookUrl] = useState(campaign.discord_webhook_url ?? "");
  const [advanceDays, setAdvanceDays] = useState(campaign.reminder_advance_days);
  const [finalDays, setFinalDays] = useState(campaign.reminder_final_days);
  const [timeOfDay, setTimeOfDay] = useState(campaign.reminder_time_of_day.slice(0, 5));
  const [advanceEnabled, setAdvanceEnabled] = useState(campaign.reminder_advance_enabled);
  const [finalEnabled, setFinalEnabled] = useState(campaign.reminder_final_enabled);
  const [dayofEnabled, setDayofEnabled] = useState(campaign.reminder_dayof_enabled);
  const [lockWarningDays, setLockWarningDays] = useState(campaign.reminder_lock_warning_days);
  const [lockWarningEnabled, setLockWarningEnabled] = useState(campaign.reminder_lock_warning_enabled);
  const [confirmAheadSessions, setConfirmAheadSessions] = useState(campaign.confirm_ahead_sessions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testingStage, setTestingStage] = useState<string | null>(null);

  async function runTest(stage: "advance" | "final" | "dayof") {
    setTestingStage(stage);
    setTestResult(null);
    try {
      const res = await api.testReminder(campaign.id, stage);
      if (!res.sent && res.reason === "nothing_to_report") {
        setTestResult("Nothing to send right now — no open block or no one's unresponsive.");
      } else if (!res.content) {
        setTestResult("Couldn't compose that reminder — check there's an open block / upcoming session.");
      } else {
        setTestResult(res.sent ? `Sent to Discord:\n${res.content}` : `Composed but failed to send:\n${res.content}`);
      }
    } catch (err: any) {
      let message = "Test failed — an unexpected error occurred.";
      if (err?.code === "no_webhook_configured") {
        message = "Set a webhook URL below first, then save, before testing.";
      } else if (err?.code === "no_upcoming_session") {
        message = "There's no upcoming session date yet — lock in a session on the calendar before testing the day-of reminder.";
      } else if (err?.code === "no_open_block") {
        message = "There's no open scheduling window right now — the advance/final reminders only have something to test once a block is open for availability.";
      } else if (err?.code === "campaign_not_found") {
        message = "Couldn't find this campaign — try refreshing the page.";
      }
      setTestResult(message);
    } finally {
      setTestingStage(null);
    }
  }

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
        blackoutDaysAfterLock,
        minPlayersRequired,
        discordWebhookUrl: webhookUrl.trim() || null,
        reminderAdvanceDays: advanceDays,
        reminderFinalDays: finalDays,
        reminderTimeOfDay: timeOfDay,
        reminderAdvanceEnabled: advanceEnabled,
        reminderFinalEnabled: finalEnabled,
        reminderDayofEnabled: dayofEnabled,
        reminderLockWarningDays: lockWarningDays,
        reminderLockWarningEnabled: lockWarningEnabled,
        confirmAheadSessions,
      });
      onUpdated(updated);
      if (!alwaysOpen) setOpen(false);
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
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
        <div className="pp-field">
          <label htmlFor="s-blackout">Blackout days after a lock</label>
          <input
            id="s-blackout"
            type="number"
            min={0}
            className="pp-input"
            value={blackoutDaysAfterLock}
            onChange={(e) => setBlackoutDaysAfterLock(Number(e.target.value))}
          />
          <p style={{ fontSize: 11, color: "var(--pp-ink-soft)", marginTop: 3 }}>
            Dates within this many days after any locked session are hidden as candidates — a cooldown before the next
            block reopens. Set to 0 to disable.
          </p>
        </div>
        <div className="pp-field">
          <label htmlFor="s-minplayers">Minimum players required</label>
          <input
            id="s-minplayers"
            type="number"
            min={0}
            className="pp-input"
            value={minPlayersRequired}
            onChange={(e) => setMinPlayersRequired(Number(e.target.value))}
          />
          <p style={{ fontSize: 11, color: "var(--pp-ink-soft)", marginTop: 3 }}>
            Dates with fewer available players than this score 0, same as a DM veto. Excluded members don't count
            toward this headcount either way. Set to 0 to disable.
          </p>
        </div>
        <div className="pp-field">
          <label htmlFor="s-confirm-ahead">Confirm-ahead window (blocks)</label>
          <input
            id="s-confirm-ahead"
            type="number"
            min={1}
            className="pp-input"
            value={confirmAheadSessions}
            onChange={(e) => setConfirmAheadSessions(Number(e.target.value))}
          />
          <p style={{ fontSize: 11, color: "var(--pp-ink-soft)", marginTop: 3 }}>
            How many upcoming open blocks players can confirm at once — 1 is just the next block; higher lets a table
            that plans further out confirm several sessions' worth of availability in one sitting.
          </p>
        </div>
        <div className="pp-field" style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="s-webhook">Discord webhook URL (optional)</label>
          <input
            id="s-webhook"
            className="pp-input"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://discord.com/api/webhooks/…"
          />
        </div>
        <div className="pp-field">
          <label htmlFor="s-advance">Advance reminder (days before)</label>
          <input
            id="s-advance"
            type="number"
            min={0}
            className="pp-input"
            value={advanceDays}
            onChange={(e) => setAdvanceDays(Number(e.target.value))}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400, fontSize: 12.5 }}>
            <input type="checkbox" checked={advanceEnabled} onChange={(e) => setAdvanceEnabled(e.target.checked)} />
            Enabled
          </label>
        </div>
        <div className="pp-field">
          <label htmlFor="s-final">Final-call reminder (days before)</label>
          <input
            id="s-final"
            type="number"
            min={0}
            className="pp-input"
            value={finalDays}
            onChange={(e) => setFinalDays(Number(e.target.value))}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400, fontSize: 12.5 }}>
            <input type="checkbox" checked={finalEnabled} onChange={(e) => setFinalEnabled(e.target.checked)} />
            Enabled
          </label>
        </div>
        <div className="pp-field">
          <label htmlFor="s-lock-warning">Unlocked-block warning (days before)</label>
          <input
            id="s-lock-warning"
            type="number"
            min={0}
            className="pp-input"
            value={lockWarningDays}
            onChange={(e) => setLockWarningDays(Number(e.target.value))}
          />
          <p style={{ fontSize: 11, color: "var(--pp-ink-soft)", marginTop: 3 }}>
            Pings the DM if no session has been locked in yet for the upcoming block. Only fires if nothing's locked.
          </p>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400, fontSize: 12.5 }}>
            <input type="checkbox" checked={lockWarningEnabled} onChange={(e) => setLockWarningEnabled(e.target.checked)} />
            Enabled
          </label>
        </div>
        <div className="pp-field">
          <label htmlFor="s-dayof-time">Reminders fire at (local time)</label>
          <input id="s-dayof-time" type="time" className="pp-input" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} />
        </div>
        <div className="pp-field">
          <label htmlFor="s-dayof-enabled" style={{ fontWeight: 600 }}>
            Day of Reminder
          </label>
          <p style={{ fontSize: 11.5, marginTop: 2, marginBottom: 6 }}>
            Announces the session + everyone's response, the day it happens.
          </p>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400, fontSize: 12.5 }}>
            <input
              id="s-dayof-enabled"
              type="checkbox"
              checked={dayofEnabled}
              onChange={(e) => setDayofEnabled(e.target.checked)}
            />
            Enabled
          </label>
        </div>
      </div>
      <div style={{ borderTop: "1px solid var(--pp-line)", paddingTop: 14, display: "grid", gap: 10 }}>
        <h4 style={{ fontSize: 13, fontWeight: 600, color: "var(--pp-ink-soft)" }}>Test reminders (sends a real message to the webhook, prefixed 🧪 TEST)</h4>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="pp-btn pp-btn-ghost" disabled={!!testingStage} onClick={() => runTest("advance")}>
            {testingStage === "advance" ? "Sending…" : "Test advance"}
          </button>
          <button type="button" className="pp-btn pp-btn-ghost" disabled={!!testingStage} onClick={() => runTest("final")}>
            {testingStage === "final" ? "Sending…" : "Test final call"}
          </button>
          <button type="button" className="pp-btn pp-btn-ghost" disabled={!!testingStage} onClick={() => runTest("dayof")}>
            {testingStage === "dayof" ? "Sending…" : "Test day-of"}
          </button>
        </div>
        {testResult && (
          <pre
            style={{
              fontSize: 12,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxWidth: "100%",
              background: "var(--pp-bg)",
              padding: 10,
              borderRadius: 6,
            }}
          >
            {testResult}
          </pre>
        )}
      </div>

      {error && <p style={{ color: "var(--pp-crimson)", fontSize: 13 }}>{error}</p>}
      <div style={{ display: "flex", gap: 10 }}>
        <button className="pp-btn pp-btn-primary" disabled={busy} type="submit">
          {busy ? "Saving…" : "Save"}
        </button>
        {!alwaysOpen && (
          <button className="pp-btn pp-btn-ghost" type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

const CADENCE_LABEL: Record<Campaign["cadence_type"], string> = {
  "bi-weekly": "Every 2 weeks",
  custom_interval: "Custom interval",
  weekly_static: "Weekly",
};

function RootJoinPrompt({ campaignId, onJoined }: { campaignId: string; onJoined: () => void }) {
  const [busy, setBusy] = useState(false);

  async function join(role: "DM" | "Player") {
    setBusy(true);
    try {
      await api.joinCampaign(campaignId, role);
      onJoined();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pp-card" style={{ padding: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <p style={{ fontSize: 13.5 }}>
        You're not a member of this campaign yet, so your own availability won't count toward scoring. Join it to participate.
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="pp-btn pp-btn-ghost" disabled={busy} onClick={() => join("Player")}>
          Join as Player
        </button>
        <button className="pp-btn pp-btn-brass" disabled={busy} onClick={() => join("DM")}>
          Join as DM
        </button>
      </div>
    </div>
  );
}

function CampaignTabs({
  campaign,
  user,
  onCampaignChanged,
}: {
  campaign: Campaign;
  user: AuthedUser;
  onCampaignChanged: () => void;
}) {
  const { availability, candidates, blocked, sessions, stats, error, reload } = useSchedulingData(campaign.id);
  const [selectedDate, setSelectedDate] = useState<DateStr | null>(null);
  const [focusDate, setFocusDate] = useState<DateStr | null>(null);
  const [activeTab, setActiveTab] = useState("schedule");

  const isRoot = user.globalRole === "root";
  const isDm = campaign.myRole === "DM";
  const canManage = isRoot || isDm;

  function jumpToCalendar(date: DateStr) {
    setFocusDate(date);
    setActiveTab("schedule");
  }

  if (error) return <p style={{ color: "var(--pp-crimson)" }}>{error}</p>;
  if (!availability) return <p>Loading scheduling data…</p>;

  const scheduleTab = (
    <div style={{ display: "grid", gap: 24 }}>
      {isRoot && !campaign.myRole && <RootJoinPrompt campaignId={campaign.id} onJoined={onCampaignChanged} />}
      <NextUpBanner campaign={campaign} sessions={sessions} candidates={candidates} onViewOnCalendar={jumpToCalendar} />
      <BlockConfirmation campaignId={campaign.id} members={availability.members} canManage={canManage} />
      <WeeklyDefaultsEditor campaignId={campaign.id} onSaved={reload} />
      <CalendarMonth
        campaign={campaign}
        availability={availability}
        candidates={candidates}
        blocked={blocked}
        sessions={sessions}
        focusDate={focusDate}
        currentUserId={user.discordId}
        onDayClick={setSelectedDate}
        onChanged={reload}
      />
      {selectedDate && (
        <DayDetailModal
          date={selectedDate}
          campaignId={campaign.id}
          campaignMyRole={campaign.myRole}
          user={user}
          availability={availability}
          candidate={candidates.find((c) => c.date === selectedDate)}
          session={sessions.find((s) => s.scheduled_start_utc.slice(0, 10) === selectedDate && s.status !== "cancelled")}
          onClose={() => setSelectedDate(null)}
          onChanged={reload}
        />
      )}
    </div>
  );

  const sessionsTab = (
    <div style={{ display: "grid", gap: 16 }}>
      {canManage && <BackfillSessionForm campaignId={campaign.id} members={availability.members} onDone={reload} />}
      <SessionsList
        sessions={sessions}
        campaignId={campaign.id}
        campaignName={campaign.name}
        canManage={canManage}
        onChanged={reload}
        onViewOnCalendar={jumpToCalendar}
      />
    </div>
  );

  const statsTab = stats ? <StatsPanel stats={stats} /> : <p>Loading stats…</p>;

  const tabs = [
    { id: "schedule", label: "Schedule", content: scheduleTab },
    { id: "sessions", label: "Sessions", content: sessionsTab },
    { id: "stats", label: "Stats", content: statsTab },
  ];

  if (canManage) {
    tabs.push({
      id: "members",
      label: "Members",
      content: (
        <div style={{ display: "grid", gap: 24 }}>
          <MemberManager campaignId={campaign.id} isRoot={isRoot} />
          <InviteManager campaignId={campaign.id} canGrantDm={isRoot} />
        </div>
      ),
    });
  }
  if (isRoot) {
    tabs.push({
      id: "settings",
      label: "Settings",
      content: <SettingsPanel campaign={campaign} onUpdated={() => onCampaignChanged()} alwaysOpen />,
    });
  }

  return <Tabs tabs={tabs} active={activeTab} onActiveChange={setActiveTab} />;
}

export function CampaignDetail({ user }: { user: AuthedUser }) {
  const { campaignId } = useParams<{ campaignId: string }>();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!campaignId) return;
    reloadCampaign();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  function reloadCampaign() {
    if (!campaignId) return;
    api
      .getCampaign(campaignId)
      .then(({ campaign }) => setCampaign(campaign))
      .catch((err) =>
        setError(err instanceof ApiError && err.status === 403 ? "You're not part of this campaign." : "Campaign not found.")
      );
  }

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

  return (
    <div style={{ display: "grid", gap: 24 }}>
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

      <CampaignTabs campaign={campaign} user={user} onCampaignChanged={reloadCampaign} />
    </div>
  );
}
