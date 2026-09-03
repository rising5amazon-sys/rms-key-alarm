function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

const syncUrl = optional("SYNC_URL", "");
const syncReadToken = optional("SYNC_READ_TOKEN", "");
const licenseKeyEnv = optional("RMS_LICENSE_KEY", "");

// ライセンスキーは約6ヶ月で失効する。手で4箇所（各PCの.env・GitHub Secret）に
// 貼り直す運用だと必ず1箇所漏れて、漏れたところだけが業務中に401で止まる。
// 共有DB（Xserver の sync.php）に1箇所だけ置き、実行のたびに取りに行く。
// SYNC_URL / SYNC_READ_TOKEN が両方あれば共有DBが正。無ければ従来の環境変数を使う。
const useSharedStore = syncUrl !== "" && syncReadToken !== "";
if (!useSharedStore && licenseKeyEnv === "") {
  throw new Error(
    "ライセンスキーの取得元がありません。SYNC_URL と SYNC_READ_TOKEN の両方、" +
      "または RMS_LICENSE_KEY を設定してください"
  );
}
// 秘密情報が通るため平文HTTPは使わせない（テスト用のlocalhostだけ許可する。
// toiawase/sync_client.py の from_env() と同じ判定にしてある）
if (
  syncUrl !== "" &&
  !syncUrl.toLowerCase().startsWith("https://") &&
  !syncUrl.includes("127.0.0.1") &&
  !syncUrl.includes("localhost")
) {
  throw new Error("SYNC_URL は https:// で指定してください");
}

// 通知に載せる更新画面のURL。SYNC_URL と同じディレクトリの key_update.php を
// 既定にする（sync.php の隣に置く前提）。別の場所に置いたら KEY_UPDATE_URL で上書き。
function defaultKeyUpdateUrl() {
  if (syncUrl === "") return "";
  try {
    const url = new URL(syncUrl);
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/[^/]*$/, "key_update.php");
    return url.toString();
  } catch {
    return "";
  }
}

export const config = {
  // 楽天RMS License Management API（zidouリポジトリの check_setup.py / dashboard/health.py と同一仕様）
  rmsServiceSecret: required("RMS_SERVICE_SECRET"),
  // 通常は変更不要。テスト時にモックサーバーへ向けるためだけに上書き可能にしている
  rmsExpiryUrl: optional(
    "RMS_EXPIRY_URL",
    "https://api.rms.rakuten.co.jp/es/1.0/license-management/license-key/expiry-date"
  ),

  // 共有DB（読み取り専用トークン。secret_get 以外は通らない）
  useSharedStore,
  syncUrl,
  syncReadToken,
  // 共有DBを使わない場合のライセンスキー（ローカルでの動作確認・移行期間用）
  rmsLicenseKey: licenseKeyEnv,
  // Slack通知に載せる更新画面のURL
  keyUpdateUrl: optional("KEY_UPDATE_URL", defaultKeyUpdateUrl()),

  // 残り日数がこのいずれかの値になったら通知（カンマ区切りで複数指定可、デフォルト5日前・1日前）
  warningDaysList: optional("WARNING_DAYS", "5,1")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n)),

  // exact: 残り日数がWARNING_DAYSのいずれかと一致した日だけ通知（デフォルト）
  // at_or_below: 残り日数がWARNING_DAYSのいずれか以下になった日は毎回通知
  alertMode: optional("ALERT_MODE", "exact"),

  // Slack
  slackWebhookUrl: required("SLACK_WEBHOOK_URL"),

  // 通信エラー・想定外レスポンス時にもSlack通知するか
  notifyOnError: optional("NOTIFY_ON_ERROR", "true") === "true",
};
