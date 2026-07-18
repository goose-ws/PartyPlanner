/**
 * Posts a message to a Discord channel via an incoming webhook URL
 * (https://discord.com/api/webhooks/ID/TOKEN). Discord auto-parses <@id>
 * mentions in `content` by default — no special allowed_mentions handling
 * needed for the simple "ping specific users" case this app uses.
 */
export async function sendDiscordMessage(webhookUrl: string, content: string): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
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
