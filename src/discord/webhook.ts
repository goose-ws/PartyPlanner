export interface DiscordEmbed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
}

export interface DiscordPayload {
  /**
   * Plain text, shown above any embed. Discord ONLY delivers @mention
   * notifications for mentions here — mentions inside an embed's
   * description/fields render as resolved, clickable/highlighted text but
   * do NOT ping anyone. Use `content` for anything that needs to actually
   * notify someone (e.g. "still waiting on @so-and-so"); use `embeds` for
   * cosmetic highlighting (e.g. a roster listing who said what).
   */
  content?: string;
  embeds?: DiscordEmbed[];
}

/**
 * Posts a message to a Discord channel via an incoming webhook URL
 * (https://discord.com/api/webhooks/ID/TOKEN). Discord auto-parses <@id>
 * mentions in `content` by default — no special allowed_mentions handling
 * needed for the simple "ping specific users" case this app uses.
 */
export async function sendDiscordMessage(
  webhookUrl: string,
  payload: DiscordPayload
): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[discord] Webhook post failed: ${res.status} ${await res.text()}`);
    }
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.error("[discord] Webhook post threw:", err);
    return { ok: false };
  }
}
