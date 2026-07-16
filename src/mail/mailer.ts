import nodemailer, { type Transporter } from "nodemailer";
import type { AppConfig } from "../types/config.js";

let transporter: Transporter | null | undefined; // undefined = not yet initialized, null = intentionally disabled

export function isMailConfigured(cfg: AppConfig): boolean {
  return !!(cfg.smtp.host && cfg.smtp.user && cfg.smtp.password);
}

function getTransporter(cfg: AppConfig): Transporter | null {
  if (transporter !== undefined) return transporter;

  if (!isMailConfigured(cfg)) {
    console.log("[mail] SMTP not configured — invite emails will be skipped; links can still be shared manually.");
    transporter = null;
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: cfg.smtp.host!,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: { user: cfg.smtp.user!, pass: cfg.smtp.password! },
  });
  return transporter;
}

export async function sendInviteEmail(
  cfg: AppConfig,
  to: string,
  campaignName: string,
  inviteUrl: string
): Promise<{ sent: boolean; reason?: string }> {
  const t = getTransporter(cfg);
  if (!t) return { sent: false, reason: "smtp_not_configured" };

  try {
    await t.sendMail({
      from: cfg.smtp.fromAddress,
      to,
      subject: `You're invited to join "${campaignName}" on Party Planner`,
      text: `You've been invited to join the campaign "${campaignName}".\n\nJoin here: ${inviteUrl}\n\nThis link works with your Discord account.`,
      html: `<p>You've been invited to join the campaign <strong>${escapeHtml(campaignName)}</strong>.</p><p><a href="${inviteUrl}">Join here</a> — you'll sign in with Discord.</p>`,
    });
    return { sent: true };
  } catch (err) {
    console.error("[mail] Failed to send invite email:", err);
    return { sent: false, reason: "send_failed" };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
