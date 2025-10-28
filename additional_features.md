🧭 全体像

収集対象は Deribit の Public API（REST または WS）から：

目的	データ種	満期	デルタ帯	取得間隔	保存
板圧力の可視化	Bid/Ask Ratio	0DTE, Front, Next, Quarterly	10Δ / 25Δ / ATM	1分	ratio値のみ
Skew impulse	IV, delta, mark price（raw）	同上	同上	1分（or 30秒）	rawデータ

👉 板の方は軽く、Skewの方は将来的なモデル検証用に生データを持っておく。

🧱 1. 対象とする満期（4種）
ラベル	内容	例（2025/10/28基準）	備考
0DTE	当日満期	2025-10-28	当日限り。daily option
Front	当月末	2025-10-31	monthly expiry
Next	翌月末	2025-11-28	monthly expiry
Quarterly	次の四半期末	2025-12-26	quarterly expiry

✅ 実装では public/get_instruments で expiration_timestamp を取得し、
残存日数から自動で 0DTE / front / next / quarterly に分類するとよいです。

🧭 2. 対象デルタ帯（3種）
Δ帯	意味	主な役割
10Δ	panic hedge, squeeze	イベント感度が高い
25Δ	directional skew, ヘッジ初動	skew impulseのコア
ATM	確認・追随シグナル	ノイズもあるが補助的

📊 3. Bid/Ask Ratio データ収集
✅ 目的

・「板のバランス」から短期の方向圧力を把握する
・保存するのは ratio 値だけ（軽量化）

✅ データソース

public/get_order_book または WebSocket book.{instrument_name}

✅ 処理内容

25Δの銘柄リストを取得（Call/Put別）

best bid/ask ± $5 の範囲の数量を集計

bid / ask ratio を計算

1分ごとに保存

ratio = sum(bid_volume in ±5$) / sum(ask_volume in ±5$)

✅ 保存例（DBスキーマ）
timestamp	expiry_type	delta_bucket	option_type	ratio
2025-10-28 09:00:00	front	25Δ	call	2.13
2025-10-28 09:00:00	front	25Δ	put	0.87
...	...	...	...	...

👉 軽くてクエリもしやすい
👉 ratioの分布から「閾値」や「zスコア」アラートも容易。

🧮 4. Skew Impulse データ収集
✅ 目的

・Skew（RR / Slope）を後から計算・チューニング
・生データを残すことで戦略のバックテストが可能

✅ データソース

public/ticker（IV・delta・mark price・index price）

必要なら public/get_book_summary_by_instrument（補完）

✅ 処理内容

満期×デルタ帯ごとの銘柄を取得

IV, delta, mark_price, index_price を取得

1分ごとにDBに保存

✅ 保存例（DBスキーマ）
timestamp	expiry_type	delta_bucket	option_type	mark_iv	mark_price	delta	index_price
2025-10-28 09:00:00	front	25Δ	call	0.45	750	0.25	110,000
2025-10-28 09:00:00	front	25Δ	put	0.55	790	-0.25	110,000
...	...	...	...	...	...	...	...

👉 Skewの計算はここから後で行う（ストリームでも、オフラインでもOK）

🧮 5. RRとSlope計算の設計
RR（25Δ Risk Reversal）
𝑅
𝑅
=
𝐼
𝑉
𝑝
𝑢
𝑡
,
25
Δ
−
𝐼
𝑉
𝑐
𝑎
𝑙
𝑙
,
25
Δ
RR=IV
put,25Δ
	​

−IV
call,25Δ
	​


→ アラート例：

RR < -0.05 で「Call skew優勢」

RR > 0.05 で「Put skew優勢」

dRR/dt の急変も見る

Slope（Skewness）

線形近似または差分：

𝑆
𝑙
𝑜
𝑝
𝑒
=
𝐼
𝑉
𝑝
𝑢
𝑡
,
25
Δ
−
𝐼
𝑉
𝑐
𝑎
𝑙
𝑙
,
25
Δ
0.5
Slope=
0.5
IV
put,25Δ
	​

−IV
call,25Δ
	​

	​


or

𝐼
𝑉
=
𝑎
+
𝑏
×
Δ
IV=a+b×Δ

で 
𝑏
b を取る

→ アラート例：

slope > 0.1（Put skew spike）

slope < -0.1（Call skew spike）

👉 RR は方向、Slope は変化の強さを見る。

⏳ 6. 推奨収集間隔とデータ量
データ種	間隔	理由	1ヶ月のデータ量目安
Ratio	1分	フロー圧力は1分粒度で十分	軽い（数十万レコード）
Skew Raw	1分（or 30秒）	Slope/RR検出に十分	6満期×6銘柄でも現実的

👉 まずは 1分で十分。0DTEでさらに精度を上げたいなら0.5分や10秒に拡張可能。

🧠 7. 改善ポイント・設計Tips

銘柄抽出は毎回しない → 起動時に get_instruments で対象を決めてキャッシュ

0DTEは刻々と変わるので → 1日数回再スキャン（AM/PM）

ratio計算は pre-processing 層（collector）に入れる

skewは rawデータだけ保存、計算は strategy 側（handler or バッチ）

DBは軽量な Parquet or 時系列DB（例：InfluxDB, TimescaleDB）が◎

timestampはUTCで統一

✅ まとめ：実装仕様整理
項目	Ratio	Skew Raw
満期	0DTE, Front, Next, Quarterly	同
Δ帯	10Δ, 25Δ, ATM	同
データ	bid/ask volume ±5$, ratio	IV, delta, mark_price, index_price
取得API	get_order_book	ticker
保存	ratioのみ	raw値全て
間隔	1分	1分（30sも可）
目的	order flow圧力の即時監視	skew impulse検出＋戦略開発
処理	collector内で計算→保存	collectorでraw保存→後で計算
戦略	ratio閾値＋skew impulse	RR/Slope閾値＋変化率アラート