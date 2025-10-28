# Requirements Document

## Introduction

暗号通貨データ収集・アラートシステムは、Deribit Public APIを使用してBTC関連の取引データとオプションデータを収集し、特定の条件に基づいてDiscord Webhookを通じてアラート通知を送信するシステムです。個人開発向けの必要最低限の機能に焦点を当て、将来的なバックテストや拡張機能の基盤となるデータ蓄積を行います。

## Glossary

- **Crypto_Data_System**: 暗号通貨データ収集・アラートシステム
- **Deribit_API**: Deribitの公開API
- **Trade_Data**: 約定データ（取引履歴）
- **Option_Data**: オプション関連データ（指標、スナップショット）
- **Discord_Webhook**: Discord通知用のWebhook URL
- **CVD_Data**: Cumulative Volume Delta（累積出来高差分）
- **CP_Delta25**: Call-Put Delta 25のオプション指標
- **Z_Score**: 統計的な標準化スコア

## Requirements

### Requirement 1

**User Story:** 開発者として、BTCの全シンボルの約定データをリアルタイムで収集したい。将来のバックテストや分析に使用するためです。

#### Acceptance Criteria

1. WHEN Deribit_APIに接続する時、THE Crypto_Data_System SHALL WebSocketを使用してBTC関連の全シンボル（perpetual、spot）の約定データを取得する
2. WHEN 約定データを受信した時、THE Crypto_Data_System SHALL データを~/Volume/buffalohd配下のSQLiteデータベースに保存する
3. THE Crypto_Data_System SHALL 接続が切断された場合に自動的に再接続を試行する
4. THE Crypto_Data_System SHALL 受信したデータの整合性を検証してから保存する

### Requirement 2

**User Story:** 開発者として、BTCオプションの全データを定期的に収集したい。オプション市場の分析を行うためです。

#### Acceptance Criteria

1. THE Crypto_Data_System SHALL 1時間ごとにDeribit_APIからBTC関連オプションのスナップショットデータを取得する
2. WHEN オプションデータを取得した時、THE Crypto_Data_System SHALL 全てのオプション指標を~/Volume/buffalohd配下のSQLiteデータベースに保存する
3. THE Crypto_Data_System SHALL オプションデータ取得の失敗時にリトライ機能を提供する
4. THE Crypto_Data_System SHALL 取得したオプションデータにタイムスタンプを付与して保存する

### Requirement 3

**User Story:** 開発者として、C-P Δ25の移動平均線の変化をリアルタイムで監視したい。市場の変化を即座に把握するためです。

#### Acceptance Criteria

1. WHEN 最新のオプションデータが更新された時、THE Crypto_Data_System SHALL C-P Δ25の移動平均線を計算する
2. WHEN C-P Δ25の移動平均線が変化した時、THE Crypto_Data_System SHALL Discord_Webhookを使用してアラート通知を送信する
3. THE Crypto_Data_System SHALL .envファイルからDiscord Webhook URLを読み込む
4. THE Crypto_Data_System SHALL アラート通知に現在の値と変化量を含める

### Requirement 4

**User Story:** 開発者として、CVDデータの異常値を検知したい。市場の急激な変化を見逃さないためです。

#### Acceptance Criteria

1. WHEN Deribit perpetual BTCの約定データを受信した時、THE Crypto_Data_System SHALL CVDデータを計算する
2. WHEN CVDデータの過去24時間のZ-scoreを計算した時、THE Crypto_Data_System SHALL Z-score値が+2を超えているかチェックする
3. IF CVDデータのZ-scoreが+2を超えた場合、THEN THE Crypto_Data_System SHALL Discord_Webhookを使用してアラート通知を送信する
4. THE Crypto_Data_System SHALL CVDアラートの重複送信を防ぐためのクールダウン機能を提供する

### Requirement 5

**User Story:** 開発者として、システムの設定を環境変数で管理したい。セキュリティと設定の柔軟性を確保するためです。

#### Acceptance Criteria

1. THE Crypto_Data_System SHALL .envファイルからDiscord Webhook URLを読み込む
2. THE Crypto_Data_System SHALL .envファイルからデータベースパス設定を読み込む
3. THE Crypto_Data_System SHALL .envファイルからAPI接続設定を読み込む
4. THE Crypto_Data_System SHALL 環境変数が設定されていない場合にエラーメッセージを表示する