import { config } from "./config.js";

export async function sendSlackMessage(text) {
  const res = await fetch(config.slackWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Slackへの通知に失敗しました: HTTP ${res.status} ${res.statusText} ${body}`
    );
  }
}
