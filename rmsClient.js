import { config } from "./config.js";

// 楽天RMS License Management API を叩いてライセンスキーの有効期限を確認する。
// 参考実装: zidou/運用ツール/check_setup.py の _api_rakuten() / zidou/dashboard/health.py の _check_rakuten()
//   - 認証: Authorization: ESA {base64(serviceSecret:licenseKey)}
//   - licenseKey はクエリ必須（無いと 400 DR0005 Bad Request）
//   - GETのみ（POSTは405）
//   - 200 → {"expiryDate": "2026-09-01T23:59:59"} / 401 → 失効・認証情報不正
//
// licenseKey は引数で受け取る（共有DBから取ってくることがあるため、configから
// 直接読まない）。取得元の決定は keySource.js の責任。
export async function fetchLicenseExpiry(licenseKey) {
  const token = Buffer.from(
    `${config.rmsServiceSecret}:${licenseKey}`
  ).toString("base64");

  const url = new URL(config.rmsExpiryUrl);
  url.searchParams.set("licenseKey", licenseKey);

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `ESA ${token}` },
  });

  const body = await res.text();
  return { status: res.status, body };
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
