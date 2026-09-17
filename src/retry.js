// 一時的な通信の失敗で誤報を出さないための再試行。
//
// なぜ要るか: このアラームは1日1回しか走らない無人実行なので、1回の失敗が
// そのまま人へのSlack通知になる。2026-09-17、共有DBの取得が1回の通信エラーで
// 落ちて「ライセンスキーを取得できませんでした」が流れたが、同時刻に社内PCから
// 同じURLを叩くと0.6秒で正常応答した（サーバーではなく経路側の揺れ）。
//
// 再試行するのは「時間をおけば直る種類」だけ。認証エラー・設定の間違いは
// 何度叩いても同じ答えなので、待つだけ無駄で通知も遅れる。判定は呼び出し側が
// shouldRetry で決める。
const DEFAULT_WAITS_MS = [2000, 6000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry(fn, { waits = DEFAULT_WAITS_MS, shouldRetry, label = "" } = {}) {
  const attempts = waits.length + 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !shouldRetry(err)) throw err;
      const wait = waits[attempt - 1];
      // 無人実行なので、何回目に何が起きたかはログに残す（Actionsのログで追える）
      console.warn(
        `${label}に失敗（${attempt}/${attempts}）: ${err.message} / ${wait / 1000}秒後に再試行します`
      );
      await sleep(wait);
    }
  }
}

// fetch が投げる例外は "fetch failed" だけで中身が分からない。原因を切り分けられる
// 文言にする（時間切れなのか、DNSなのか、繋がらないのか）。
export function describeNetworkError(err, timeoutMs) {
  if (err && err.name === "TimeoutError") {
    return `${timeoutMs / 1000}秒以内に応答がありませんでした`;
  }
  const code = err && err.cause && err.cause.code ? err.cause.code : "";
  return code || (err && err.message) || "詳細不明";
}
