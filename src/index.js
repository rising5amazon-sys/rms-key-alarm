import { config } from "./config.js";
import { fetchLicenseExpiry, parseExpiryDate } from "./rmsClient.js";
import { sendSlackMessage } from "./slackNotifier.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RENEW_HINT =
  "RMS → 拡張サービス → RMS WEB SERVICE → ライセンスキー発行 で再発行してください。";

function daysRemaining(expiresAt, now = new Date()) {
  return Math.ceil((expiresAt.getTime() - now.getTime()) / MS_PER_DAY);
}

function shouldNotify(remaining) {
  if (config.alertMode === "at_or_below") {
    return config.warningDaysList.some((d) => remaining <= d);
  }
  return config.warningDaysList.includes(remaining);
}

async function notifyIfPossible(text) {
  try {
    await sendSlackMessage(text);
  } catch (err) {
    console.error("Slackへの通知に失敗しました:", err);
  }
}

async function main() {
  let result;
  try {
    result = await fetchLicenseExpiry();
  } catch (err) {
    console.error(err);
    if (config.notifyOnError) {
      await notifyIfPossible(
        `:warning: RMSライセンスキーの状態を確認できませんでした（通信エラー）\n\`\`\`${err.message}\`\`\``
      );
    }
    process.exitCode = 1;
    return;
  }

  const { status, body } = result;

  if (status === 401) {
    console.error("RMSライセンスキーが失効/不正です (HTTP 401)");
    await notifyIfPossible(
      `:rotating_light: RMSライセンスキーが失効しています（認証エラー / HTTP 401）。\n${RENEW_HINT}`
    );
    process.exitCode = 1;
    return;
  }

  if (status !== 200) {
    console.error(`RMS APIがエラーを返しました: HTTP ${status} ${body.slice(0, 200)}`);
    if (config.notifyOnError) {
      await notifyIfPossible(
        `:warning: RMSライセンスキーの状態を確認できませんでした（HTTP ${status}）\n\`\`\`${body.slice(0, 200)}\`\`\``
      );
    }
    process.exitCode = 1;
    return;
  }

  const expiresAt = parseExpiryDate(body);
  if (!expiresAt) {
    console.error(`レスポンスから有効期限を取得できませんでした: ${body.slice(0, 200)}`);
    if (config.notifyOnError) {
      await notifyIfPossible(
        `:warning: RMSライセンスキーの有効期限をレスポンスから取得できませんでした\n\`\`\`${body.slice(0, 200)}\`\`\``
      );
    }
    process.exitCode = 1;
    return;
  }

  const remaining = daysRemaining(expiresAt);
  const dateStr = expiresAt.toISOString().slice(0, 10);
  console.log(`残り日数: ${remaining}日 (期限日: ${dateStr})`);

  if (shouldNotify(remaining)) {
    await sendSlackMessage(
      `:rotating_light: RMSライセンスキーの有効期限まで残り${remaining}日です。\n期限日: ${dateStr}\n${RENEW_HINT}`
    );
    console.log("Slackへ通知しました。");
  } else {
    console.log("通知条件に該当しないため、通知しません。");
  }
}

main();
