import crypto from "node:crypto";
import type { AppConfig } from "../types/config.js";
import type { DateStr } from "./dateMath.js";

interface ConfirmTokenPayload {
  campaignId: string;
  discordId: string;
  blockStart: DateStr;
  exp: number; // unix seconds
}

const CONFIRM_TOKEN_TTL_SECONDS = 21 * 24 * 60 * 60; // 21 days — comfortably longer than any block (interval_weeks maxes out well under this in practice), short enough that a leaked/forwarded link doesn't work forever

function sign(cfg: AppConfig, data: string): string {
  return crypto.createHmac("sha256", cfg.session.signingSecret).update(`confirm:${data}`).digest("base64url");
}

/** A compact, self-verifying token identifying exactly one (campaign, member, block) — the whole point being that tapping the link needs no login at all. */
export function signConfirmToken(cfg: AppConfig, campaignId: string, discordId: string, blockStart: DateStr): string {
  const payload: ConfirmTokenPayload = {
    campaignId,
    discordId,
    blockStart,
    exp: Math.floor(Date.now() / 1000) + CONFIRM_TOKEN_TTL_SECONDS,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(cfg, data)}`;
}

export function verifyConfirmToken(cfg: AppConfig, token: string): ConfirmTokenPayload | null {
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;

  const expected = sign(cfg, data);
  // Constant-time compare — this gates a real (if low-stakes) write action, so don't leak timing info about a partial match.
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const payload: ConfirmTokenPayload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.campaignId || !payload.discordId || !payload.blockStart) return null;
    return payload;
  } catch {
    return null;
  }
}
