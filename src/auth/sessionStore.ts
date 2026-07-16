import crypto from "node:crypto";
import { db } from "../db/index.js";
import type { AuthedUser } from "../types/express.js";

/**
 * Sessions are intentionally dumb: user_sessions just maps an opaque sid to
 * a discord_id + expiry. All the actual user data (role, timezone, etc) is
 * re-read from `users` on each request. This keeps the session table tiny
 * and means role changes take effect immediately instead of waiting for the
 * cookie to be re-issued.
 */

const SID_BYTES = 32;

export function generateSid(): string {
  return crypto.randomBytes(SID_BYTES).toString("hex");
}

export async function createSession(discordId: string, maxAgeSeconds: number): Promise<string> {
  const sid = generateSid();
  const expires = new Date(Date.now() + maxAgeSeconds * 1000);
  await db()("user_sessions").insert({ sid, discord_id: discordId, expires });
  return sid;
}

export async function destroySession(sid: string): Promise<void> {
  await db()("user_sessions").where({ sid }).delete();
}

/**
 * Resolves a sid to the authenticated user, if the session exists and
 * hasn't expired. Also performs sliding-window renewal: if less than 90% of
 * the max age remains, the expiry is pushed back out to a full maxAgeSeconds
 * from now. The threshold avoids writing to the sessions table on every
 * single request while still keeping active users logged in indefinitely.
 */
export async function resolveSession(
  sid: string,
  maxAgeSeconds: number
): Promise<AuthedUser | null> {
  const row = await db()("user_sessions")
    .join("users", "users.discord_id", "user_sessions.discord_id")
    .where("user_sessions.sid", sid)
    .andWhere("user_sessions.expires", ">", db().fn.now())
    .select(
      "users.discord_id",
      "users.username",
      "users.global_role",
      "users.timezone",
      "user_sessions.expires"
    )
    .first();

  if (!row) return null;

  const remainingMs = new Date(row.expires).getTime() - Date.now();
  const renewalThresholdMs = maxAgeSeconds * 1000 * 0.9;
  if (remainingMs < renewalThresholdMs) {
    const newExpires = new Date(Date.now() + maxAgeSeconds * 1000);
    await db()("user_sessions").where({ sid }).update({ expires: newExpires });
  }

  return {
    discordId: row.discord_id,
    username: row.username,
    globalRole: row.global_role,
    timezone: row.timezone,
  };
}
