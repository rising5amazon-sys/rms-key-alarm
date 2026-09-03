import { config } from "./config.js";

// ライセンスキーをどこから取るか。
//
// なぜ共有DBから取るのか:
//   ライセンスキーは約6ヶ月で失効する。以前は再発行のたびに各PCの .env と
//   GitHub Secret を手で貼り替えていたが、1箇所でも漏れるとそこだけが401で止まる。
//   実際に 2026-09-03、RMSでキーを再発行したのに GitHub Secret が旧キーのままで、
//   このアラームが「失効しています」を鳴らし続けた（キーは生きていた）。
//   共有DB（Xserver の sync.php）を唯一の正にして、実行のたびに取りに行く。
//
// トークンは読み取り専用（config.php の read_tokens）。secret_get 以外は
// サーバー側が403で弾くので、このリポジトリのSecretが漏れても送信履歴・顧客名・
// Yahoo!トークンには届かない。
const SECRET_NAME = "rakuten_license_key";
const TIMEOUT_MS = 20000;

async function fetchFromSharedStore() {
  const res = await fetch(config.syncUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Toiawase-Token": config.syncReadToken,
      "User-Agent": "rmskeyalarm-keysource/1.0",
    },
    body: JSON.stringify({ action: "secret_get", name: SECRET_NAME }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `共有DBの応答がJSONではありません（HTTP ${res.status}）。SYNC_URL を確認してください`
    );
  }
  if (!json.ok) {
    throw new Error(
      `共有DBがエラーを返しました（HTTP ${res.status}）: ${json.error || "詳細なし"}`
    );
  }
  if (!json.found) {
    throw new Error(
      "共有DBに楽天ライセンスキーが未登録です。更新画面（key_update.php）で登録してください"
    );
  }
  const key = String(json.value || "");
  if (key === "" || /\s/.test(key)) {
    throw new Error("共有DBの楽天ライセンスキーの形式が不正です");
  }
  return {
    key,
    source: `共有DB（最終更新 ${json.updated_at || "不明"} / ${json.actor || "不明"}）`,
  };
}

// 共有DBが設定されているなら、そこが唯一の正。取得できなかったときに
// 環境変数の古いキーへフォールバックはしない。フォールバックすると
// 「共有DBが落ちている」を「キーが失効した」と誤って通知してしまい、
// 今回直した事故をそのまま再現することになる。
export async function resolveLicenseKey() {
  if (!config.useSharedStore) {
    return { key: config.rmsLicenseKey, source: "環境変数 RMS_LICENSE_KEY" };
  }
  return fetchFromSharedStore();
}
