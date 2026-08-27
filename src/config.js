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

export const config = {
  // 楽天RMS License Management API（zidouリポジトリの check_setup.py / dashboard/health.py と同一仕様）
  rmsServiceSecret: required("RMS_SERVICE_SECRET"),
  rmsLicenseKey: required("RMS_LICENSE_KEY"),
  // 通常は変更不要。テスト時にモックサーバーへ向けるためだけに上書き可能にしている
  rmsExpiryUrl: optional(
    "RMS_EXPIRY_URL",
    "https://api.rms.rakuten.co.jp/es/1.0/license-management/license-key/expiry-date"
  ),

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
