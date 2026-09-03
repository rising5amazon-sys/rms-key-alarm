import { config } from "./config.js";
import { resolveLicenseKey } from "./keySource.js";
import { fetchLicenseExpiry, parseExpiryDate } from "./rmsClient.js";
import { sendSlackMessage } from "./slackNotifier.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// 通知に載せる「次にやること」。共有DBを使っているなら、再発行したキーを貼る先は
// 更新画面1箇所だけ（各PCの .env も GitHub Secret も触らなくてよい）。
const RENEW_HINT = config.useSharedStore
  ? "RMS → 拡張サービス → RMS WEB SERVICE → ライセンスキー発行 で再発行し、" +
    `更新画面で貼り替えてください（全PCへ自動で配られます）。\n${config.keyUpdateUrl}`
  : "RMS → 拡張サービス → RMS WEB SERVICE → ライセンスキー発行 で再発行してください。";

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
  // まず「どのキーを見るのか」を決める。ここで失敗したら期限の判定はしない。
  // 古いキーで代わりに判定すると、共有DBの不通を「失効」と誤通知してしまう。
  let licenseKey;
  try {
    const resolved = await resolveLicenseKey();
    licenseKey = resolved.key;
    console.log(`ライセンスキーの取得元: ${resolved.source}`);
  } catch (err) {
    console.error(err);
    if (config.notifyOnError) {
      await notifyIfPossible(
        `:warning: RMSライセンスキーを取得できませんでした（期限の判定は行っていません）\n\`\`\`${err.message}\`\`\``
      );
    }
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = await fetchLicenseExpiry(licenseKey);
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
