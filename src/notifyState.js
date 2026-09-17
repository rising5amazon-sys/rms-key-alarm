import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// 「この期限日について、どの閾値の通知をもう出したか」だけを記録する小さなファイル。
//
// なぜ要るか（自己修復のため）:
//   通信が落ちた日は判定できない。状態を持たないと「5日前ちょうど」の1回を
//   逃したまま誰にも届かない。どの閾値まで通知したかを覚えておけば、翌日の実行が
//   「残り4日（5日前の通知が未送）」として拾い直せる。1日に複数回実行しても、
//   同じ閾値は二度送らない。
//
// 中身は期限日と閾値だけ。ライセンスキーそのものは絶対に書かない
// （GitHub Actions のキャッシュに載るため）。
//
// 消えても壊れない作りにしてある。読めなければ「まだ何も通知していない」と
// みなす。最悪の結果は通知が1回重複するだけで、通知が消えるより軽い。

function emptyState() {
  return { version: 1, notified: {} };
}

export function loadState() {
  try {
    const raw = fs.readFileSync(config.stateFile, "utf8");
    const json = JSON.parse(raw);
    if (!json || typeof json !== "object" || typeof json.notified !== "object") {
      return emptyState();
    }
    return { version: 1, notified: json.notified || {} };
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`通知済み記録を読めませんでした（未通知として扱います）: ${err.message}`);
    }
    return emptyState();
  }
}

// 書けなくても実行は止めない。止めると「記録できない日は通知もできない」ことになり、
// 本来の目的（期限を知らせる）を巻き込んでしまう。
export function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
    fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn(`通知済み記録を保存できませんでした（次回に通知が重複する可能性があります）: ${err.message}`);
  }
}

export function notifiedMarks(state, expiryKey) {
  const list = state.notified[expiryKey];
  return new Set(Array.isArray(list) ? list : []);
}

// 期限日が変わったら（＝キーを再発行したら）古い記録は用済み。
// 増え続けないように直近数件だけ残す。
const KEEP_ENTRIES = 5;

export function recordMarks(state, expiryKey, marks) {
  const current = notifiedMarks(state, expiryKey);
  marks.forEach((m) => current.add(m));
  state.notified[expiryKey] = [...current].sort((a, b) => b - a);

  const keys = Object.keys(state.notified).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_ENTRIES))) {
    delete state.notified[old];
  }
  return state;
}
