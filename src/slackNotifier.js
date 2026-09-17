import { config } from "./config.js";
import { withRetry, describeNetworkError } from "./retry.js";

// 通知が落ちると「期限が近い」という一番届けたい情報がどこにも残らない
// （無人実行なので、誰も画面を見ていない）。ここも一時的な失敗は粘る。
const TIMEOUT_MS = 15000;
const RETRY_WAITS_MS = [2000, 6000]; // 3回まで試す

class TransientError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransientError";
  }
}

async function post(text) {
  let res;
  try {
    res = await fetch(config.slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new TransientError(
      `Slackへ接続できませんでした（${describeNetworkError(err, TIMEOUT_MS)}）`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const message = `Slackへの通知に失敗しました: HTTP ${res.status} ${res.statusText} ${body}`;
    // 4xx は Webhook URL の失効・本文の作り方の問題。粘っても直らない。
    if (res.status >= 500 || res.status === 429) throw new TransientError(message);
    throw new Error(message);
  }
}

export async function sendSlackMessage(text) {
  await withRetry(() => post(text), {
    waits: RETRY_WAITS_MS,
    shouldRetry: (err) => err instanceof TransientError,
    label: "Slackへの通知",
  });
}
