import { config } from "./config.js";
import { resolveLicenseKey } from "./keySource.js";
import { fetchLicenseExpiry, parseExpiryDate } from "./rmsClient.js";
import { sendSlackMessage } from "./slackNotifier.js";
import { loadState, saveState, notifiedMarks, recordMarks } from "./notifyState.js";

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

function formatRemaining(remaining) {
  if (remaining >= 1) return `残り${remaining}日`;
  if (remaining === 0) return "本日が期限";
  return `${-remaining}日前に期限切れ`;
}

// 技術的な失敗の扱いを1箇所にまとめる。
//
// 既定ではSlackへ出さない（NOTIFY_ON_ERROR=false）。ここで鳴る失敗は
// 「時間をおけば直る通信の揺れ」がほとんどで、受け取った人に打つ手がない。
// 代わりに必ずログへ残し、終了コードを1にして GitHub Actions の実行を
// 赤くする（Actionsの失敗はGitHubからメールが飛ぶので、気づく経路は残る）。
async function reportProblem(logMessage, slackMessage) {
  console.error(logMessage);
  process.exitCode = 1;
  if (!config.notifyOnError) return;
  try {
    await sendSlackMessage(slackMessage);
  } catch (err) {
    console.error("Slackへの通知に失敗しました:", err.message);
  }
}

// 「残り日数がこの閾値を割った」通知のうち、まだ出していないもの。
//
// 実行できなかった日があっても拾い直せるように、一致（==）ではなく
// 割り込み（<=）で判定し、出したものを記録しておく。
// 例: WARNING_DAYS=5,1 で5日前の実行が通信エラーだった場合、
//     翌日の実行が「残り4日」として5日前ぶんの通知を出す。
function dueMarks(remaining, already) {
  return config.warningDaysList
    .filter((w) => remaining <= w && !already.has(w))
    .sort((a, b) => b - a);
}

async function main() {
  // まず「どのキーを見るのか」を決める。共有DBが不通なら、環境変数のキーで
  // 縮退運転になる（trusted:false）。どちらも無理なら期限の判定はしない。
  let resolved;
  try {
    resolved = await resolveLicenseKey();
  } catch (err) {
    await reportProblem(
      `ライセンスキーを取得できませんでした（期限の判定は行っていません）: ${err.message}`,
      ":warning: RMSライセンスキーを取得できませんでした（期限の判定は行っていません）\n" +
        "キーの失効ではありません。キーの置き場（共有DB）へ問い合わせられなかっただけです。\n" +
        `\`\`\`${err.message}\`\`\``
    );
    return;
  }
  console.log(`ライセンスキーの取得元: ${resolved.source}`);

  let result;
  try {
    result = await fetchLicenseExpiry(resolved.key);
  } catch (err) {
    await reportProblem(
      `RMS APIへ照会できませんでした（通信エラー）: ${err.message}`,
      `:warning: RMSライセンスキーの状態を確認できませんでした（通信エラー）\n\`\`\`${err.message}\`\`\``
    );
    return;
  }

  const { status, body } = result;

  if (status === 401) {
    // 縮退運転中の401は「古いキーを渡しただけ」の可能性がある。
    // ここで失効と断定すると 2026-09-03 の誤報（生きているキーを失効と通知）を
    // 再現してしまうので、共有DBが復旧してから判定し直す。
    if (!resolved.trusted) {
      await reportProblem(
        "縮退運転中に401を受け取りました。共有DBが復旧してから判定し直します" +
          "（古いキーの可能性があるため、失効とは断定しません）",
        ":warning: 縮退運転中に401を受け取りました（失効かどうかは判定できていません）"
      );
      return;
    }
    console.error("RMSライセンスキーが失効/不正です (HTTP 401)");
    process.exitCode = 1;
    await sendSlackMessage(
      `:rotating_light: RMSライセンスキーが失効しています（認証エラー / HTTP 401）。\n${RENEW_HINT}`
    );
    return;
  }

  if (status !== 200) {
    await reportProblem(
      `RMS APIがエラーを返しました: HTTP ${status} ${body.slice(0, 200)}`,
      `:warning: RMSライセンスキーの状態を確認できませんでした（HTTP ${status}）\n\`\`\`${body.slice(0, 200)}\`\`\``
    );
    return;
  }

  const expiresAt = parseExpiryDate(body);
  if (!expiresAt) {
    await reportProblem(
      `レスポンスから有効期限を取得できませんでした: ${body.slice(0, 200)}`,
      `:warning: RMSライセンスキーの有効期限をレスポンスから取得できませんでした\n\`\`\`${body.slice(0, 200)}\`\`\``
    );
    return;
  }

  const remaining = daysRemaining(expiresAt);
  const dateStr = expiresAt.toISOString().slice(0, 10);
  console.log(`${formatRemaining(remaining)} (期限日: ${dateStr})`);

  // 縮退運転中でも、200が返っているならそのキーの期限は本物なので通知してよい。
  // ただしどのキーを見た結果なのかは通知に残す（共有DBの新しいキーとは
  // 別のキーを見ている可能性があるため）。
  const sourceNote = resolved.trusted
    ? ""
    : "\n（注: 共有DBが不通のため、環境変数のキーで確認した結果です）";

  const expiryAlert = (extra = "") =>
    `:rotating_light: RMSライセンスキーの有効期限まで${formatRemaining(remaining)}です。\n` +
    `期限日: ${dateStr}\n${RENEW_HINT}${extra}${sourceNote}`;

  if (config.alertMode === "exact") {
    // 従来動作。その日に実行できないとこの閾値の通知は失われる。
    if (!config.warningDaysList.includes(remaining)) {
      console.log("通知条件に該当しないため、通知しません。");
      return;
    }
    await sendSlackMessage(expiryAlert());
    console.log("Slackへ通知しました。");
    return;
  }

  if (config.alertMode === "at_or_below") {
    // 閾値を割っている間は毎回鳴らす（記録を使わない）。
    if (!config.warningDaysList.some((w) => remaining <= w)) {
      console.log("通知条件に該当しないため、通知しません。");
      return;
    }
    await sendSlackMessage(expiryAlert());
    console.log("Slackへ通知しました。");
    return;
  }

  // catchup（既定）: 閾値ごとに1回だけ。取りこぼした閾値は後の実行が拾う。
  const state = loadState();
  const already = notifiedMarks(state, dateStr);
  const due = dueMarks(remaining, already);
  if (due.length === 0) {
    console.log(
      already.size > 0
        ? `通知条件に該当しないため、通知しません（通知済みの閾値: ${[...already].join(",")}日前）。`
        : "通知条件に該当しないため、通知しません。"
    );
    return;
  }

  const lateNote =
    remaining < due[0] && remaining >= 1
      ? `\n（${due[0]}日前の通知を出せていなかったため、いま出しています）`
      : "";

  // 記録するのは送信できたあと。送れなかった通知を「送った」ことにすると、
  // 次の実行が拾い直せなくなる（通知が1回まるごと消える）。
  await sendSlackMessage(expiryAlert(lateNote));
  saveState(recordMarks(state, dateStr, due));
  console.log(`Slackへ通知しました（消化した閾値: ${due.join(",")}日前）。`);
}

// Slackへの通知が3回とも失敗した場合など、ここまで来る例外は素通しせずに
// 1行で残す（Actionsのログにスタックだけが出ても原因が読めないため）。
main().catch((err) => {
  console.error(`実行を中断しました: ${err.message}`);
  process.exitCode = 1;
});
