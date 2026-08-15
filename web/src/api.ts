export interface AuthedUser {
  discordId: string;
  username: string;
  globalRole: "root" | "user";
  timezone: string;
}

export interface Campaign {
  id: string;
  slug: string;
  name: string;
  start_date: string;
  cadence_type: "bi-weekly" | "custom_interval" | "weekly_static";
  interval_weeks: number;
  sessions_per_interval: number;
  blackout_days_after_lock: number;
  min_players_required: number; // 0 = no minimum enforced
  dm_maybe_modifier: number; // extra weight (+/-) applied only to the DM's own contribution for a raw "Maybe" response; 0 = no change
  dm_if_needed_modifier: number; // extra weight (+/-) applied only to the DM's own contribution for a raw "If Needed" response; 0 = no change
  late_early_penalty: number; // deducted per active joining-late/dropping-early flag, floored at 0 overall; default 0.5
  session_time_start: string;
  session_time_end: string;
  timezone: string;
  last_session_number: number; // used to compute the number the NEXT locked session would get (last_session_number + 1)
  discord_webhook_url?: string | null; // present only for root — redacted otherwise
  reminder_advance_days: number;
  reminder_final_days: number;
  reminder_time_of_day: string;
  reminder_advance_enabled: boolean;
  reminder_final_enabled: boolean;
  reminder_dayof_enabled: boolean;
  reminder_lock_warning_days: number;
  reminder_lock_warning_enabled: boolean;
  confirm_ahead_sessions: number; // how many upcoming open blocks players can confirm ahead of time (1 = just the next one)
  myRole?: "DM" | "Player";
}

export interface Invite {
  token: string;
  url: string;
  role: "DM" | "Player";
  uses: number;
  maxUses: number | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface Member {
  discordId: string;
  username: string;
  role: "DM" | "Player";
  excludedFromScoring: boolean;
}

export interface AvailabilityAll {
  members: Member[];
  defaults: Array<{ discordId: string; dayOfWeek: number; weight: number }>;
  specific: Array<{ discordId: string; date: string; weight: number; joiningLate: boolean; droppingEarly: boolean }>;
}

export interface CandidateDate {
  date: string;
  score: number;
  isDmAvailable: boolean;
  isAboveMinPlayers: boolean;
  breakdown: Array<{ discordId: string; weight: number; joiningLate: boolean; droppingEarly: boolean; excluded: boolean }>;
}
export interface BlockedDate {
  date: string;
  reason: "block_full" | "block_skipped" | "blackout";
}

export interface Session {
  id: string;
  campaign_id: string;
  session_number: number | null;
  scheduled_start_utc: string;
  scheduled_end_utc: string;
  status: "scheduled" | "completed" | "skipped" | "cancelled";
  notes: string | null;
  absent_discord_ids: string[];
}

export interface AttendanceRow {
  discordId: string;
  username: string;
  totalSessions: number;
  totalAbsences: number;
  attendanceRate: number | null;
}
export interface Stats {
  attendance: AttendanceRow[];
  sessionCounts: Record<string, number>;
  campaignAgeDays: number;
}

class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.error ?? "unknown_error");
  return body as T;
}

export const api = {
  me: () => request<{ user: AuthedUser }>("/api/auth/me"),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),

  listCampaigns: () => request<{ campaigns: Campaign[] }>("/api/campaigns"),
  getCampaign: (id: string) => request<{ campaign: Campaign }>(`/api/campaigns/${id}`),
  createCampaign: (input: { name: string; startDate: string }) =>
    request<Campaign>("/api/campaigns", { method: "POST", body: JSON.stringify(input) }),
  updateCampaign: (
    id: string,
    input: Partial<{
      name: string;
      sessionTimeStart: string;
      sessionTimeEnd: string;
      timezone: string;
      cadenceType: Campaign["cadence_type"];
      intervalWeeks: number;
      sessionsPerInterval: number;
      blackoutDaysAfterLock: number;
      minPlayersRequired: number;
      dmMaybeModifier: number;
      dmIfNeededModifier: number;
      lateEarlyPenalty: number;
      discordWebhookUrl: string | null;
      reminderAdvanceDays: number;
      reminderFinalDays: number;
      reminderTimeOfDay: string;
      reminderAdvanceEnabled: boolean;
      reminderFinalEnabled: boolean;
      reminderDayofEnabled: boolean;
      reminderLockWarningDays: number;
      reminderLockWarningEnabled: boolean;
      confirmAheadSessions: number;
    }>
  ) => request<Campaign>(`/api/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  testReminder: (campaignId: string, stage: "advance" | "final" | "dayof") =>
    request<{ sent: boolean; content: string | null; reason?: string }>(`/api/campaigns/${campaignId}/reminders/test`, {
      method: "POST",
      body: JSON.stringify({ stage }),
    }),
  joinCampaign: (id: string, role: "DM" | "Player") =>
    request<void>(`/api/campaigns/${id}/join`, { method: "POST", body: JSON.stringify({ role }) }),

  listMembers: (campaignId: string) =>
    request<{ members: { discord_id: string; username: string; role: "DM" | "Player"; excluded_from_scoring: boolean }[] }>(
      `/api/campaigns/${campaignId}/members`
    ),
  setMemberRole: (campaignId: string, discordId: string, role: "DM" | "Player") =>
    request<void>(`/api/campaigns/${campaignId}/members/${discordId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  setMemberExclusion: (campaignId: string, discordId: string, excludedFromScoring: boolean) =>
    request<void>(`/api/campaigns/${campaignId}/members/${discordId}/exclusion`, {
      method: "PATCH",
      body: JSON.stringify({ excludedFromScoring }),
    }),
  removeMember: (campaignId: string, discordId: string) =>
    request<void>(`/api/campaigns/${campaignId}/members/${discordId}`, { method: "DELETE" }),

  listInvites: (campaignId: string) => request<{ invites: Invite[] }>(`/api/campaigns/${campaignId}/invites`),
  createInvite: (campaignId: string, input: { role?: "DM" | "Player"; maxUses?: number; expiresInDays?: number }) =>
    request<Invite>(`/api/campaigns/${campaignId}/invites`, { method: "POST", body: JSON.stringify(input) }),
  revokeInvite: (campaignId: string, token: string) =>
    request<void>(`/api/campaigns/${campaignId}/invites/${token}/revoke`, { method: "POST" }),

  getAllAvailability: (campaignId: string) => request<AvailabilityAll>(`/api/campaigns/${campaignId}/availability/all`),
  setDefaultAvailability: (campaignId: string, days: Array<{ dayOfWeek: number; weight: number }>, discordId?: string) =>
    request<void>(`/api/campaigns/${campaignId}/availability/default`, {
      method: "PUT",
      body: JSON.stringify({ days, discordId }),
    }),
  setSpecificAvailability: (
    campaignId: string,
    date: string,
    weight: number | null,
    discordId?: string,
    flags?: { joiningLate?: boolean; droppingEarly?: boolean }
  ) =>
    request<void>(`/api/campaigns/${campaignId}/availability/specific`, {
      method: "PUT",
      body: JSON.stringify({ date, weight, discordId, joiningLate: flags?.joiningLate, droppingEarly: flags?.droppingEarly }),
    }),

  getCandidates: (campaignId: string, months = 6) =>
    request<{ candidates: CandidateDate[]; blocked: BlockedDate[] }>(`/api/campaigns/${campaignId}/candidates?months=${months}`),
  getSessions: (campaignId: string) => request<{ sessions: Session[] }>(`/api/campaigns/${campaignId}/sessions`),
  lockSession: (campaignId: string, date: string) =>
    request<Session>(`/api/campaigns/${campaignId}/sessions/lock`, { method: "POST", body: JSON.stringify({ date }) }),
  rescheduleSession: (campaignId: string, sessionId: string, date: string) =>
    request<void>(`/api/campaigns/${campaignId}/sessions/${sessionId}/reschedule`, {
      method: "PATCH",
      body: JSON.stringify({ date }),
    }),
  cancelSession: (campaignId: string, sessionId: string) =>
    request<void>(`/api/campaigns/${campaignId}/sessions/${sessionId}/cancel`, { method: "POST" }),
  cancelBlock: (campaignId: string, sessionId: string, notes?: string) =>
    request<void>(`/api/campaigns/${campaignId}/sessions/${sessionId}/cancel-block`, {
      method: "POST",
      body: JSON.stringify({ notes }),
    }),
  skipBlock: (campaignId: string, date: string, notes?: string) =>
    request<void>(`/api/campaigns/${campaignId}/blocks/skip`, { method: "POST", body: JSON.stringify({ date, notes }) }),
  backfillSession: (
    campaignId: string,
    input: { date: string; status: "completed" | "cancelled" | "skipped"; notes?: string; absentDiscordIds: string[] }
  ) => request<{ id: string; sessionNumber: number | null }>(`/api/campaigns/${campaignId}/sessions/backfill`, { method: "POST", body: JSON.stringify(input) }),
  updateSessionNotes: (campaignId: string, sessionId: string, notes: string | null) =>
    request<void>(`/api/campaigns/${campaignId}/sessions/${sessionId}/notes`, {
      method: "PATCH",
      body: JSON.stringify({ notes }),
    }),
  markAbsent: (campaignId: string, sessionId: string, discordId: string, excused = true) =>
    request<void>(`/api/campaigns/${campaignId}/sessions/${sessionId}/absences`, {
      method: "POST",
      body: JSON.stringify({ discordId, excused }),
    }),
  clearAbsence: (campaignId: string, sessionId: string, discordId: string) =>
    request<void>(`/api/campaigns/${campaignId}/sessions/${sessionId}/absences/${discordId}`, { method: "DELETE" }),

  getBlockStatus: (campaignId: string) =>
    request<{
      blocks: Array<{
        block: { index: number; start: string; end: string };
        confirmations: Record<string, boolean>;
        youConfirmed: boolean;
      }>;
    }>(`/api/campaigns/${campaignId}/block-status`),
  setBlockConfirmation: (campaignId: string, blockStart: string, confirmed: boolean) =>
    request<void>(`/api/campaigns/${campaignId}/block-status/me`, { method: "PUT", body: JSON.stringify({ blockStart, confirmed }) }),
  setMemberBlockConfirmation: (campaignId: string, discordId: string, blockStart: string, confirmed: boolean) =>
    request<void>(`/api/campaigns/${campaignId}/block-status/${discordId}`, {
      method: "PUT",
      body: JSON.stringify({ blockStart, confirmed }),
    }),

  getAuditLog: (params: { campaignId?: string; event?: string; before?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.campaignId) qs.set("campaignId", params.campaignId);
    if (params.event) qs.set("event", params.event);
    if (params.before) qs.set("before", String(params.before));
    return request<{
      entries: Array<{
        id: number;
        campaignId: string | null;
        actorDiscordId: string | null;
        event: string;
        detail: Record<string, unknown> | null;
        createdAt: string;
      }>;
    }>(`/api/audit-log${qs.toString() ? `?${qs}` : ""}`);
  },

  getStats: (campaignId: string) => request<Stats>(`/api/campaigns/${campaignId}/stats`),

  getSetupStatus: () => request<{ complete: boolean; missing: string[] }>("/api/setup/status"),
  completeSetup: (input: {
    publicUrl: string;
    dbHost: string;
    dbPort?: string;
    dbUser: string;
    dbName: string;
    dbPassword: string;
    discordClientId: string;
    discordClientSecret: string;
    initialRootDiscordId: string;
  }) => request<{ ok: true; message: string }>("/api/setup/complete", { method: "POST", body: JSON.stringify(input) }),

  getCoreSettings: () => request<CoreSettings>("/api/core-settings"),
  revealCoreSetting: (field: "dbPassword" | "discordClientSecret") =>
    request<{ field: string; value: string }>(`/api/core-settings/reveal/${field}`),
  updateCoreSettings: (patch: Record<string, unknown>) =>
    request<{ ok: true; message: string }>("/api/core-settings", { method: "PATCH", body: JSON.stringify(patch) }),
};

export interface CoreSettings {
  publicUrl: string | null;
  port: number;
  trustProxy: boolean;
  db: { host: string | null; port: number; user: string | null; database: string | null; passwordSet: boolean };
  discord: { clientId: string | null; clientSecretSet: boolean; rootDiscordId: string | null };
  session: { cookieName: string; maxAgeSeconds: number; signingSecretSet: boolean };
  security: { tokenEncryptionKeySet: boolean };
  scheduling: { defaultWindowMonths: number };
}

export { ApiError };
