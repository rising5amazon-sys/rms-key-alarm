# RMSKeyAlarm

楽天RMSライセンスキーの有効期限が残り指定日数（デフォルト5日前・1日前）になったら、Slackの指定チャンネルへ Incoming Webhook で通知するCronスクリプトです。**GitHub Actionsのスケジュール実行**で運用しています（PCの電源状態に依存せず、無料枠内で毎日自動実行されます）。

`zidou` リポジトリ（`運用ツール/check_setup.py` の `_api_rakuten()`、`dashboard/health.py` の `_check_rakuten()`）で実際に使われている楽天RMS License Management APIの仕様に合わせて実装しています。

## 使っているAPI

```
GET https://api.rms.rakuten.co.jp/es/1.0/license-management/license-key/expiry-date?licenseKey={licenseKey}
Authorization: ESA {base64(serviceSecret:licenseKey)}
```

- 200: `{"expiryDate": "2026-09-01T23:59:59"}`
- 401: ライセンスキーが失効/認証情報が不正
- licenseKeyはクエリ必須（無いと400 DR0005）、GETのみ（POSTは405）

## 必要な認証情報

`rakuten-rms-client/.env` にある以下と同じ値を使います。

- `RMS_SERVICE_SECRET`（サービスシークレット、店舗単位で固定・無期限）
- `RMS_LICENSE_KEY`（ライセンスキー、約6ヶ月で失効・定期更新が必要）

## ローカルでのテスト

```bash
npm install --omit=dev # 依存パッケージなし。Node 18+ が必要
cp .env.example .env
# .env を編集して RMS_SERVICE_SECRET / RMS_LICENSE_KEY / SLACK_WEBHOOK_URL を設定

node --env-file=.env src/index.js
```

`WARNING_DAYS` を実際の残り日数に近い値にして動作確認すると、通知メッセージの内容を確認できます。

## Slack Incoming Webhook の準備

1. https://api.slack.com/apps で新規Appを作成（または既存Appを利用）
2. 「Incoming Webhooks」を有効化
3. 通知したいチャンネルを選んでWebhook URLを発行
4. 発行されたURLを `SLACK_WEBHOOK_URL` に設定（通知先チャンネルはこのURL発行時に固定されます）

## GitHub Actionsでの運用（メイン）

`.github/workflows/check-license.yml` が毎日 UTC 0:00（JST 9:00）に自動実行します。無料枠（プライベートリポジトリで月2,000分）で十分収まります。

### 初回セットアップ

1. GitHubのリポジトリページで **Settings → Secrets and variables → Actions** を開く
2. **「New repository secret」** で以下を1つずつ登録（値は `.env` にある実際の値）
   - `RMS_SERVICE_SECRET`
   - `RMS_LICENSE_KEY`
   - `SLACK_WEBHOOK_URL`
3. `.github/workflows/check-license.yml` をリポジトリにpush（またはブラウザでアップロード）すれば、その日からスケジュール実行が有効になる

### 動作確認・運用

- 今すぐ実行して確認したい場合: リポジトリの **Actions** タブ → 左メニュー **「RMS License Key Alarm」** → 右側の **「Run workflow」** ボタンで手動実行できる
- 実行ログは同じActionsタブの各実行から確認できる
- スケジュールを変更したい場合は `check-license.yml` の `cron: "0 0 * * *"` を編集（UTC基準）
- 通知条件（`WARNING_DAYS`等）を変えたい場合は同ファイルの `env:` を編集

## ローカル実行（動作確認用）

`run.bat` を使えばローカルでも同じ処理を実行できます（`.env`が必要）。

```powershell
C:\Users\user\RMSkeyAlarm\run.bat
```

実行結果は `logs\run.log` に追記されます。定期実行はGitHub Actionsに任せているため、通常はタスクスケジューラへの登録は不要です。

## Renderへのデプロイ（Cron Job・任意）

このリポジトリには `render.yaml` を同梱しているので、Render の Blueprint 機能でそのままデプロイできます。

1. このディレクトリをGitリポジトリとしてpush（GitHub/GitLab）
2. Renderダッシュボードで「New +」→「Blueprint」を選び、このリポジトリを指定
3. `render.yaml` の内容に従って Cron Job (`rms-key-alarm`) が作成される
4. `sync: false` になっている環境変数（`RMS_SERVICE_SECRET`, `RMS_LICENSE_KEY`, `SLACK_WEBHOOK_URL`）をRenderの画面上で入力
5. スケジュールはデフォルトで毎日 UTC 0:00（JST 9:00）。変更する場合は `render.yaml` の `schedule` を編集（cron形式）

Blueprintを使わず手動でCron Jobを作る場合は、Render上で以下を設定してください。

- Build Command: `npm install`
- Start Command: `npm start`
- Schedule: `0 0 * * *`（毎日 JST 9:00 相当）
- 環境変数: `.env.example` を参照して同名のキーを設定

## 通知条件

- `WARNING_DAYS`（デフォルト `5,1` = 5日前と1日前）で指定した残り日数のいずれかと一致した日にだけ通知（`ALERT_MODE=exact`）。カンマ区切りで何個でも指定可（例: `WARNING_DAYS=14,5,1`）
- Cronの実行漏れなどで見逃しが心配な場合は `ALERT_MODE=at_or_below` にすると、残り日数がWARNING_DAYSのいずれか以下になった日は毎回通知します（一番大きい値以下は毎日通知になるためスパムになりやすい点に注意）
- ライセンスキーが既に失効している場合（HTTP 401）は、`WARNING_DAYS`の設定に関わらず即座にSlackへ通知します
- API呼び出し自体が失敗した場合も、`NOTIFY_ON_ERROR=true`（デフォルト）ならSlackへエラー通知します

## 注意

`RMS_SERVICE_SECRET` / `RMS_LICENSE_KEY` は楽天RMSの認証情報そのものです。Renderの環境変数に設定する際は、他リポジトリやログに平文で残さないよう注意してください（このリポジトリの `.env` はGit管理対象外です）。
