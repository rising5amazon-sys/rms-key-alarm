import { config } from "./config.js";
import { withRetry, describeNetworkError } from "./retry.js";

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
// 1日1回の無人実行なので、数十秒粘ってでもその場で直す方がよい
// （ここで諦めると、次に判定できるのは翌日になる）
const RETRY_WAITS_MS = [5000, 15000, 30000]; // 4回まで試す（合計約50秒）

// 再試行してよい失敗かどうかを、投げる側で決めて持ち回る。
// 通信の揺れ・5xx は待てば直る。401/403/400 と「未登録」は設定の間違いなので
// 何度叩いても同じ答えが返る（待つだけ無駄で、通知も遅れる）。
class KeySourceError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "KeySourceError";
    this.retryable = retryable;
  }
}

async function requestSecret() {
  let res;
  try {
    res = await fetch(config.syncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Toiawase-Token": config.syncReadToken,
        "User-Agent": "rmskeyalarm-keysource/1.0",
      },
      body: JSON.stringify({ action: "secret_get", name: SECRET_NAME }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new KeySourceError(
      `共有DBに接続できませんでした（${describeNetworkError(err, TIMEOUT_MS)}）`,
      { retryable: true }
    );
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 5xx はXserver側の一時的な不調でもHTMLが返る。4xxのHTMLは設定の間違い
    // （URLの綴り違い・ディレクトリにアクセス制限を掛けた等）なので再試行しない。
    throw new KeySourceError(
      `共有DBの応答がJSONではありません（HTTP ${res.status}）。SYNC_URL を確認してください`,
      { retryable: res.status >= 500 }
    );
  }
  if (!json.ok) {
    throw new KeySourceError(
      `共有DBがエラーを返しました（HTTP ${res.status}）: ${json.error || "詳細なし"}`,
      { retryable: res.status >= 500 || res.status === 429 }
    );
  }
  if (!json.found) {
    throw new KeySourceError(
      "共有DBに楽天ライセンスキーが未登録です。更新画面（key_update.php）で登録してください"
    );
  }
  const key = String(json.value || "");
  if (key === "" || /\s/.test(key)) {
    throw new KeySourceError("共有DBの楽天ライセンスキーの形式が不正です");
  }
  return {
    key,
    source: `共有DB（最終更新 ${json.updated_at || "不明"} / ${json.actor || "不明"}）`,
  };
}

async function fetchFromSharedStore() {
  try {
    return await withRetry(requestSecret, {
      waits: RETRY_WAITS_MS,
      shouldRetry: (err) => err instanceof KeySourceError && err.retryable,
      label: "共有DBからのライセンスキー取得",
    });
  } catch (err) {
    // 何回粘ったのかが分からないと、通知を見た人が「一瞬の揺れ」なのか
    // 「ずっと落ちている」のかを判断できない。
    if (err instanceof KeySourceError && err.retryable) {
      err.message = `${err.message}（${RETRY_WAITS_MS.length + 1}回試行）`;
    }
    throw err;
  }
}

// 共有DBが唯一の正。ただし、取れなかったときに何もできずに終わると、
// その日は期限の判定ごと落ちる（通信が落ちただけで見張りが止まる）。
//
// そこで環境変数のキーがあれば、それで判定だけは続ける「縮退運転」をする。
// trusted:false を付けて返すのが肝で、これが付いた判定では
// **401を「失効」と断定しない**（古いキーかもしれないため）。
// 2026-09-03 の事故（旧キーで判定して「失効しています」を鳴らし続けた）は
// これで再現しない。逆に200が返れば、そのキーの期限は本物なので通知してよい。
export async function resolveLicenseKey() {
  if (!config.useSharedStore) {
    return { key: config.rmsLicenseKey, source: "環境変数 RMS_LICENSE_KEY", trusted: true };
  }

  try {
    const resolved = await fetchFromSharedStore();
    return { ...resolved, trusted: true };
  } catch (err) {
    if (config.rmsLicenseKey === "") throw err;
    console.warn(`共有DBから取得できませんでした: ${err.message}`);
    console.warn("環境変数 RMS_LICENSE_KEY で縮退運転します（401は失効と断定しません）");
    return {
      key: config.rmsLicenseKey,
      source: "環境変数 RMS_LICENSE_KEY（共有DBが不通のため縮退）",
      trusted: false,
      degradedReason: err.message,
    };
  }
}
