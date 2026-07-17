export interface AuthedUser {
  discordId: string;
  username: string;
  globalRole: "root" | "user";
  timezone: string;
}

export interface Campaign {
  id: string;
  name: string;
  start_date: string;
  cadence_type: "bi-weekly" | "custom_interval" | "weekly_static";
  interval_weeks: number;
  sessions_per_interval: number;
  blackout_days_after_lock: number;
  session_time_start: string;
  session_time_end: string;
  timezone: string;
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
    }>
  ) => request<Campaign>(`/api/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

  listMembers: (campaignId: string) =>
    request<{ members: { discord_id: string; username: string; role: "DM" | "Player" }[] }>(
      `/api/campaigns/${campaignId}/members`
    ),
  setMemberRole: (campaignId: string, discordId: string, role: "DM" | "Player") =>
    request<void>(`/api/campaigns/${campaignId}/members/${discordId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),

  listInvites: (campaignId: string) => request<{ invites: Invite[] }>(`/api/campaigns/${campaignId}/invites`),
  createInvite: (
    campaignId: string,
    input: { role?: "DM" | "Player"; email?: string; maxUses?: number; expiresInDays?: number }
  ) => request<Invite>(`/api/campaigns/${campaignId}/invites`, { method: "POST", body: JSON.stringify(input) }),
  revokeInvite: (campaignId: string, token: string) =>
    request<void>(`/api/campaigns/${campaignId}/invites/${token}/revoke`, { method: "POST" }),
};

export { ApiError };
