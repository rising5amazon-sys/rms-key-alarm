import { config } from "./config.js";
import { withRetry, describeNetworkError } from "./retry.js";

// 楽天RMS License Management API を叩いてライセンスキーの有効期限を確認する。
// 参考実装: zidou/運用ツール/check_setup.py の _api_rakuten() / zidou/dashboard/health.py の _check_rakuten()
//   - 認証: Authorization: ESA {base64(serviceSecret:licenseKey)}
//   - licenseKey はクエリ必須（無いと 400 DR0005 Bad Request）
//   - GETのみ（POSTは405）
//   - 200 → {"expiryDate": "2026-09-01T23:59:59"} / 401 → 失効・認証情報不正
//
// licenseKey は引数で受け取る（共有DBから取ってくることがあるため、configから
// 直接読まない）。取得元の決定は keySource.js の責任。
const TIMEOUT_MS = 30000;
const RETRY_WAITS_MS = [2000, 6000]; // 3回まで試す

// 時間をおけば直る失敗（通信の揺れ・楽天側の5xx）の目印。
// 401 は「失効」という結論そのものなので、絶対に再試行しない。
class TransientError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransientError";
  }
}

async function requestExpiry(licenseKey) {
  const token = Buffer.from(
    `${config.rmsServiceSecret}:${licenseKey}`
  ).toString("base64");

  const url = new URL(config.rmsExpiryUrl);
  url.searchParams.set("licenseKey", licenseKey);

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `ESA ${token}` },
      // 無人実行なので、応答が返らないまま待ち続けないよう必ず上限を切る
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new TransientError(
      `RMS APIに接続できませんでした（${describeNetworkError(err, TIMEOUT_MS)}）`
    );
  }

  const body = await res.text();
  return { status: res.status, body };
}

export async function fetchLicenseExpiry(licenseKey) {
  let lastResponse = null;
  try {
    return await withRetry(
      async () => {
        const result = await requestExpiry(licenseKey);
        lastResponse = result;
        if (result.status >= 500 || result.status === 429) {
          throw new TransientError(`RMS APIが HTTP ${result.status} を返しました`);
        }
        return result;
      },
      {
        waits: RETRY_WAITS_MS,
        shouldRetry: (err) => err instanceof TransientError,
        label: "RMS APIへの照会",
      }
    );
  } catch (err) {
    // 5xx が続いたときは「通信エラー」ではなく実際のHTTPコードを呼び出し側に見せる
    // （楽天側の障害なのか、こちらの経路の問題なのかが通知で区別できるように）
    if (lastResponse !== null) return lastResponse;
    throw err;
  }
}

// レスポンスから有効期限を取り出す。
// 正式なキーは expiryDate だが、キー名の揺れに備えてJSON解釈に失敗しても
// 本文中の日付パターンを正規表現で拾うフォールバックを持たせる。
export function parseExpiryDate(body) {
  try {
    const json = JSON.parse(body);
    if (json && json.expiryDate) {
      const d = new Date(json.expiryDate);
      if (!Number.isNaN(d.getTime())) return d;
    }
  } catch {
    // JSONでなければ下の正規表現フォールバックへ
  }

  const m = (body || "").match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (!m) return null;

  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T23:59:59`);
  return Number.isNaN(d.getTime()) ? null : d;
}
