import type { AppConfig } from "../types/config.js";

const DISCORD_API = "https://discord.com/api/v10";

export interface DiscordTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  /** Discord's "display name" shown in messages/mentions — null for accounts that never set one, in which case Discord itself falls back to showing `username`. */
  global_name: string | null;
  avatar: string | null;
}

function redirectUri(cfg: AppConfig): string {
  return `${cfg.publicUrl}/auth/callback`;
}

export function buildAuthorizeUrl(cfg: AppConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.discord.clientId!, // non-null: these routes only ever run once setup is confirmed complete
    redirect_uri: redirectUri(cfg),
    response_type: "code",
    scope: "identify",
    state,
    prompt: "none",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(cfg: AppConfig, code: string): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: cfg.discord.clientId!, // non-null: these routes only ever run once setup is confirmed complete
    client_secret: cfg.discord.clientSecret!,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(cfg),
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Discord token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DiscordTokenResponse;
}

export async function refreshDiscordToken(cfg: AppConfig, refreshToken: string): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: cfg.discord.clientId!, // non-null: these routes only ever run once setup is confirmed complete
    client_secret: cfg.discord.clientSecret!,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Discord token refresh failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DiscordTokenResponse;
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Discord user fetch failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DiscordUser;
}
