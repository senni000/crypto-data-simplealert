# Crypto Data Alert System

暗号通貨データ収集・アラートシステム - Deribit APIからBTCデータを収集し、Discord Webhookでアラート通知を送信するシステムです。

## 機能

- Deribit WebSocket APIを使用したBTC約定データのリアルタイム収集
- Deribit REST APIを使用したBTCオプションデータの定期収集
- SQLiteデータベースでのデータ永続化
- CVD（Cumulative Volume Delta）のZ-score監視（DBキュー経由）
- C-P Δ25移動平均線の変化監視
- 0DTE / Front の Bid/Ask Ratio スパイク検知（Zスコア / 1分差分）
- 0DTE / Front の Skew Impulse 検知（Risk Reversal / Slope / 変化率）
- Ratio × Skew の複合アラート（時間差 2 分以内の連動検知）
- 4時間ごとの BTC/USD × 1M 25Δ Skew チャート生成・Discord 投稿
- Discord Webhookによるアラート通知
- インジェスト / 集計 / アラートの 3 プロセス分離構成（PM2管理想定）

## 実装機能とデータ保存先

### 収集しているデータ

#### トレード（WebSocket）
- `src/services/websocket-client.ts` が Deribit の `trades.BTC-PERPETUAL.100ms` / `trades.BTC-PERPETUAL-USDC.100ms` / `trades.BTC-USD.100ms` / `trades.option.BTC.raw` / `block_trade.BTC` を購読し、約定を `TradeData` に正規化します。
- 取り込むフィールドは `symbol`, `timestamp`, `price`, `amount`, `direction`, `tradeId` に加え、提供される場合は `markPrice`, `indexPrice`, `underlyingPrice`, `iv`, `channel`, `isBlockTrade` も保持します。
- `src/services/data-collector.ts` が検証後に 5 秒間隔・最大 1,000 件でバッファをフラッシュし、`DatabaseManager.saveTradeData` 経由で `trade_data` テーブルへ書き込みます。
- 書き込みと同時に `tradeDataReceived` / `blockTradeThresholdExceeded` イベントを発火し、CVD 計算やブロックトレード監視に利用します。

#### オプション（REST）
- `DeribitRestClient` が `/public/get_instruments` で BTC オプション銘柄一覧を取得し、各銘柄に対して `/public/get_order_book` を呼び出して板情報・Greeks を収集します。
- 収集レコードは `symbol`, `timestamp`（収集時刻）, `underlyingPrice`, `markPrice`, `impliedVolatility`, `delta`, `gamma`, `theta`, `vega`, `rho` を保持し、同様にバッファ経由で `option_data` テーブルへ保存されます。
- 取得頻度は `.env` の `OPTION_DATA_INTERVAL`（既定 1 時間）で制御され、エラーは指数バックオフ付きでリトライします。

#### 派生指標の蓄積
- `CvdAggregationWorker` が共有ライブラリ `@crypto-data/cvd-core` の累積 CVD アグリゲータを用いて `trade_data` の新規レコードを巡回し、`cvd_data` テーブルへ Z スコア付きで追記します（直近 24 時間分を参照）。閾値超過時は `alert_queue` に `CVD_ZSCORE` ペイロードを enqueue します。
- `AlertManager.checkCPDelta25Alert` が `CPDelta25Calculator` でデルタが +0.25/-0.25 に最も近いコール・プットを選び、`MovingAverageMonitor`（期間 10）に値を渡して移動平均系列を維持します。

### アラートの種類
- **COMBO_CALL / COMBO_PUT（テキスト）**  
  - 同じ 1 分足、または Skew 発生後 2 分以内に Ratio も条件を満たした場合に複合アラートを送信。  
  - 「CALL Skew Spike + Bid dominance」などのメッセージを出力。

- **CVD_ZSCORE（テキスト）**  
  - `CvdAggregationWorker` が enqueue したペイロードを `AlertQueueProcessor` がポーリングし、Discord へ送信します。閾値（既定 2.0）とサプレッションウィンドウ（既定 30 分）を満たす場合のみ配送されます。  
  - 配送完了後に `alert_history` にアラート種別・値・閾値・メッセージを記録します。

- **CP_DELTA_25（テキスト）**  
  - C-P Δ25 の移動平均（期間 10）が直前の平均から 5%以上変動し、クールダウン 15 分を過ぎている場合に送信。  
  - 抽出したコール・プット銘柄、変動率などをメッセージ化して `alert_history` に保存します。

- **ブロックトレード検知（Discord Embed）**  
  - `block_trade.BTC` チャネル由来で `amount > 1000` の取引を検出すると、`AlertManager.sendBlockTradeAlert` が数量・価格・Mark/Index 価格を含む埋め込みメッセージを送信します。  
  - このアラートは履歴テーブルには書き込まず、Discord 通知のみを行います。

### 健全性モニタリング
- `DataHealthMonitor` がトレード流量の停滞、オプションバッチ遅延、想定外のバッチ間隔ギャップ、REST エラー急増、システムスリープ復帰を検知します。
- 兆候を捉えると `restartTradeDataCollection` / `restartOptionDataCollection` や `recoverFromSystemResume` を呼び出して自動復旧し、警告ログを残します（Discord への通知は行いません）。

### 可用性・ログ
- `DatabaseBackupScheduler` は `.env` の `DATABASE_BACKUP_ENABLED=true` 時にバックアップを定期実行し、失敗・スキップ理由をログ出力します。
- `src/utils/setup-logging.ts` が `console` 系出力に ISO8601 タイムスタンプとレベルを付与し、PM2 使用時は `~/.pm2/logs/crypto-data-alert-{out,error}-0.log` にローテートされます。

### SQLite テーブル構成（`.env` の `DATABASE_PATH` に出力）
| テーブル       | 役割                      | 主なカラム |
|---------------|---------------------------|------------|
| `trade_data`  | WebSocket 約定履歴        | `symbol`, `timestamp`, `price`, `amount`, `direction`, `trade_id`, `channel`, `mark_price`, `index_price`, `underlying_price`, `is_block_trade`, `created_at` |
| `option_data` | REST 取得オプション情報    | `symbol`, `timestamp`, `underlying_price`, `mark_price`, `delta` など |
| `cvd_data`    | CVD 値と Zスコアの履歴     | `timestamp`, `cvd_value`, `z_score`, `created_at` |
| `alert_history` | 送信済みアラートの記録   | `alert_type`, `timestamp`, `value`, `threshold`, `message`, `created_at` |
| `order_flow_ratio` | Ratio 指標の時系列    | `timestamp`, `expiry_type`, `expiry_timestamp`, `delta_bucket`, `option_type`, `ratio` |
| `skew_raw_data`   | Skew計算用のIV等生データ | `timestamp`, `expiry_type`, `expiry_timestamp`, `delta_bucket`, `option_type`, `mark_iv`, `mark_price`, `delta`, `index_price` |
| `processing_state` | 各ワーカーの進捗カーソル | `process_name`, `key`, `last_row_id`, `last_timestamp`, `updated_at` |
| `alert_queue`      | 非同期アラート配送キュー  | `alert_type`, `timestamp`, `payload_json`, `attempt_count`, `last_error`, `processed_at`, `created_at` |

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. 環境変数の設定

`.env.example`をコピーして`.env`ファイルを作成し、必要な値を設定してください：

```bash
cp .env.example .env
```

### 3. 必要な設定項目

- `DISCORD_WEBHOOK_URL`: Discord WebhookのURL
- `DATABASE_PATH`: SQLiteデータベースファイルのパス
- `LOG_LEVEL`: ログ出力レベル（`error` / `warn` / `info` / `debug`）
- `DATABASE_BACKUP_ENABLED`: 定期バックアップを有効にする場合は `true`
- `DATABASE_BACKUP_PATH`: バックアップを保存するディレクトリ（例: `/Volumes/buffalohd/crypto-data/backups/deribit`）
- `DATABASE_BACKUP_INTERVAL_MS`: バックアップ間隔 (ミリ秒) ※ デフォルト 86400000 (24時間)
- その他の設定は`.env.example`を参照

### 4. ビルドと実行

```bash
# TypeScriptをコンパイル
npm run build

# プロセスごとの起動例
npm run start:ingest
npm run start:aggregate
npm run start:alert

# 開発モード（ts-node 実行）
npm run dev:ingest
npm run dev:aggregate
npm run dev:alert

# PM2で常駐起動
npm run start:pm2
```

### 5. テスト実行

```bash
npm test
```

### 6. パフォーマンス計測

擬似データを用いたSQLite書き込み性能を計測するハーネスを用意しています。

```bash
npm run perf
```

デフォルトでは一時ディレクトリにデータベースを作成し、完了後に削除します。`PERF_KEEP_DB=true` でファイルを保持、`PERF_TRADE_BATCH` や `PERF_OPTION_BATCH` で投入件数を調整できます。

### 7. 短時間の動作確認（SQLite保存 + Discord通知）

実際のDeribit APIに接続してデータ収集・SQLite保存・アラートパイプラインを検証するスクリプトを用意しています。

```bash
# 30秒だけ収集し、Discord送信はドライラン（payloadをログ出力）のまま
COLLECT_DURATION_MS=30000 ENABLE_ALERTS=false npm run collect:sample

# Discord通知まで行いたい場合（本番Webhookを設定）
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." \
COLLECT_DURATION_MS=60000 ENABLE_ALERTS=true npm run collect:sample
```

※ Discord通知を有効にする場合は、必ず検証用チャンネルまたはWebhookを事前に用意してください。

## 運用メモ

- 常駐運用には [PM2](https://pm2.keymetrics.io/) の利用を想定しており、`ecosystem.config.js` に `deribit-ingest` / `deribit-aggregate` / `deribit-alert` の 3 アプリを定義しています。
- `npm run start:pm2` / `npm run stop:pm2` で各プロセスの起動・削除をまとめて実行できます。
- ログレベルは `.env` の `LOG_LEVEL` で制御でき、`debug` に設定すると詳細ログを出力します。

## プロジェクト構造

```
src/
├── models/     # データモデル定義
├── services/   # ビジネスロジック
├── utils/      # ユーティリティ関数
└── types/      # TypeScript型定義
```

## 要件

- Node.js 18以上
- SQLite3
- 十分なディスク容量（データベース保存用）

## ライセンス

MIT
- **定期レポート（画像）**  
  - 4 時間ごとに 1M 25Δ Skew（Front 満期）と BTC/USD を重ねたチャートを生成し、Discord Webhook へ PNG 画像を投稿します。  
  - Skew は Put IV − Call IV（%）で計算し、最大 100 日の移動平均線を併記します。
