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
  session_time_start: string;
  session_time_end: string;
  timezone: string;
  discord_webhook_url?: string | null; // present only for root — redacted otherwise
  reminder_advance_days: number;
  reminder_final_days: number;
  reminder_time_of_day: string;
  reminder_advance_enabled: boolean;
  reminder_final_enabled: boolean;
  reminder_dayof_enabled: boolean;
  myRole?: "DM" | "Player";
}

export interface Invite {
  token: string;
  url: string;
  role: "DM" | "Player";
  email: string | null;
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
  breakdown: Array<{ discordId: string; weight: number; joiningLate: boolean; droppingEarly: boolean }>;
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
      discordWebhookUrl: string | null;
      reminderAdvanceDays: number;
      reminderFinalDays: number;
      reminderTimeOfDay: string;
      reminderAdvanceEnabled: boolean;
      reminderFinalEnabled: boolean;
      reminderDayofEnabled: boolean;
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
    request<{ members: { discord_id: string; username: string; role: "DM" | "Player" }[] }>(
      `/api/campaigns/${campaignId}/members`
    ),
  setMemberRole: (campaignId: string, discordId: string, role: "DM" | "Player") =>
    request<void>(`/api/campaigns/${campaignId}/members/${discordId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  removeMember: (campaignId: string, discordId: string) =>
    request<void>(`/api/campaigns/${campaignId}/members/${discordId}`, { method: "DELETE" }),

  listInvites: (campaignId: string) => request<{ invites: Invite[] }>(`/api/campaigns/${campaignId}/invites`),
  createInvite: (
    campaignId: string,
    input: { role?: "DM" | "Player"; email?: string; maxUses?: number; expiresInDays?: number }
  ) => request<Invite>(`/api/campaigns/${campaignId}/invites`, { method: "POST", body: JSON.stringify(input) }),
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
    input: { sessionNumber: number | null; date: string; status: "completed" | "cancelled" | "skipped"; notes?: string; absentDiscordIds: string[] }
  ) => request<{ id: string }>(`/api/campaigns/${campaignId}/sessions/backfill`, { method: "POST", body: JSON.stringify(input) }),

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
  smtp: { host: string | null; port: number; user: string | null; passwordSet: boolean; fromAddress: string; secure: boolean };
}

export { ApiError };
