# Implementation Plan

- [x] 1. プロジェクト構造とコア設定の初期化
  - TypeScriptプロジェクトの初期化とpackage.json設定
  - 必要な依存関係のインストール（ws, sqlite3, dotenv, axios等）
  - ディレクトリ構造の作成（src/models, src/services, src/utils等）
  - TypeScript設定ファイル（tsconfig.json）の作成
  - 環境変数設定ファイル（.env.example）の作成
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 2. データモデルとインターfaces定義
  - [x] 2.1 コアデータ型とインターフェースの定義
    - TradeData, OptionData, AlertMessage等の型定義
    - IDataCollector, IAlertManager, IDatabaseManager等のインターフェース定義
    - _Requirements: 1.1, 2.1_

  - [x] 2.2 設定管理モジュールの実装
    - AppConfig型の定義と環境変数読み込み機能
    - 設定値の検証とデフォルト値の設定
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 3. データベース管理機能の実装
  - [x] 3.1 SQLiteデータベース接続とスキーマ作成
    - データベース接続ユーティリティの実装
    - テーブル作成SQLの実行機能
    - インデックス作成機能
    - _Requirements: 1.2, 2.2_

  - [x] 3.2 データベース操作メソッドの実装
    - 約定データ保存機能（saveTradeData）
    - オプションデータ保存機能（saveOptionData）
    - 過去24時間データ取得機能（getTradeDataLast24Hours）
    - 最新オプションデータ取得機能（getLatestOptionData）
    - _Requirements: 1.2, 2.2, 4.1_

  - [x] 3.3 データベース操作のユニットテスト
    - データ保存・取得機能のテスト
    - データ整合性検証のテスト
    - _Requirements: 1.4, 2.4_

- [x] 4. Deribit API接続とデータ収集機能
  - [x] 4.1 WebSocketクライアントの実装
    - Deribit WebSocket APIへの接続機能
    - BTC関連シンボルの約定データ購読
    - 自動再接続機能の実装
    - _Requirements: 1.1, 1.3_

  - [x] 4.2 REST APIクライアントの実装
    - オプションデータ取得のためのREST API呼び出し
    - 1時間ごとの定期実行機能
    - リトライ機能の実装
    - _Requirements: 2.1, 2.3_

  - [x] 4.3 データ収集サービスの統合
    - DataCollectorクラスの実装
    - 受信データの検証とフォーマット
    - データベースへの保存処理
    - _Requirements: 1.2, 1.4, 2.2, 2.4_

  - [x] 4.4 API接続機能のユニットテスト
    - WebSocket接続のモックテスト
    - REST API呼び出しのモックテスト
    - 再接続機能のテスト
    - _Requirements: 1.3, 2.3_

- [x] 5. 計算エンジンとアラート条件の実装
  - [x] 5.1 CVD計算とZ-score監視機能
    - Cumulative Volume Delta計算ロジック
    - 過去24時間データに基づくZ-score計算
    - Z-score閾値監視機能
    - _Requirements: 4.1, 4.2_

  - [x] 5.2 C-P Δ25移動平均線計算機能
    - Call-Put Delta 25の計算ロジック
    - 移動平均線の計算と変化検知
    - _Requirements: 3.1, 3.2_

  - [x]* 5.3 計算ロジックのユニットテスト
    - CVD計算の正確性テスト
    - Z-score計算の検証テスト
    - 移動平均線計算のテスト
    - _Requirements: 3.1, 4.1_

- [x] 6. Discord Webhookアラート機能
  - [x] 6.1 Discord Webhook送信機能の実装
    - Webhook URL設定の読み込み
    - アラートメッセージの送信機能
    - 送信失敗時のリトライ機能
    - _Requirements: 3.3, 4.3_

  - [x] 6.2 アラート管理機能の実装
    - アラート条件チェック機能
    - 重複アラート防止（クールダウン機能）
    - アラート履歴の記録
    - _Requirements: 3.2, 3.4, 4.3, 4.4_

  - [x]* 6.3 アラート機能のユニットテスト
    - Webhook送信のモックテスト
    - アラート条件判定のテスト
    - クールダウン機能のテスト
    - _Requirements: 3.3, 4.3_

- [x] 7. メインアプリケーションの統合
  - [x] 7.1 アプリケーションエントリーポイントの作成
    - 全モジュールの初期化と起動
    - 環境変数の検証と設定
    - グレースフルシャットダウンの実装
    - _Requirements: 5.4_

  - [x] 7.2 エラーハンドリングとログ機能
    - 統一されたエラーハンドリング
    - ログ出力機能の実装
    - 障害回復機能の統合
    - _Requirements: 1.3, 2.3_

  - [x]* 7.3 統合テストの実装
    - 全体的なデータフローのテスト
    - エラー回復機能のテスト
    - 長時間稼働テスト
    - _Requirements: 1.1, 2.1, 3.1, 4.1_

- [x] 8. 本番環境準備とドキュメント
  - [x] 8.1 本番用設定ファイルの作成
    - .env.exampleファイルの完成
    - README.mdの作成（セットアップ手順含む）
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 8.2 起動スクリプトとプロセス管理
    - npm scriptsの設定
    - プロセス監視用の設定（PM2等）
    - _Requirements: 全般_

  - [x]* 8.3 パフォーマンステストとドキュメント
    - 大量データ処理のパフォーマンステスト
    - メモリ使用量の監視テスト
    - 運用ドキュメントの作成
    - _Requirements: 全般_
