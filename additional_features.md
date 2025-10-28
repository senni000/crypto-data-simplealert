アラート実装
🧭 1. ratio 系アラート（flow）
✅ 対象

満期：0DTE と Front

Δ帯：25Δ のみ

指標：Bid/Ask ratio

集計頻度：1分足

判定方法：Zスコア + スパイク検知（dRatio/dt）

📐 1-1. Zスコアベースの閾値

Zスコア：

𝑍
=
𝑅
𝑡
−
𝜇
1
𝑑
𝜎
1
𝑑
Z=
σ
1d
	​

R
t
	​

−μ
1d
	​

	​


𝜇
1
𝑑
μ
1d
	​

：過去1日分の ratio 平均

𝜎
1
𝑑
σ
1d
	​

：過去1日分の ratio 標準偏差

𝑍
≥
2.0
Z≥2.0 をスパイクとみなす

→ 日中の板の厚さの偏り（通常ノイズ）を除外しやすい。
→ 突発的な流動性偏り＝本物のフローである確率が高い。

⚡ 1-2. 突発スパイク検出（dRatio/dt）

dRatio/dt の計算：

𝑑
𝑅
𝑎
𝑡
𝑖
𝑜
/
𝑑
𝑡
=
𝑅
𝑎
𝑡
𝑖
𝑜
𝑡
−
𝑅
𝑎
𝑡
𝑖
𝑜
𝑡
−
1
dRatio/dt=Ratio
t
	​

−Ratio
t−1
	​


（時間差1分）

閾値の目安：

∣
𝑑
𝑅
𝑎
𝑡
𝑖
𝑜
/
𝑑
𝑡
∣
≥
0.8
∣dRatio/dt∣≥0.8 で「急変」と判断
（Zスコアが平常でも急変で検知可能）

例：

前の足 1.2 → 現在 3.0 ⇒ 
𝑑
𝑅
𝑎
𝑡
𝑖
𝑜
/
𝑑
𝑡
=
1.8
dRatio/dt=1.8 → 上方向急変

前の足 2.5 → 現在 0.7 ⇒ 
𝑑
𝑅
𝑎
𝑡
𝑖
𝑜
/
𝑑
𝑡
=
−
1.8
dRatio/dt=−1.8 → 下方向急変

👉 Zスコアで“絶対水準”を、dRatio/dtで“変化の初動”を拾う。

📨 1-3. Discord通知内容（例）
[ORDERFLOW ALERT]
2025-10-28 04:58:00 | 0DTE | 25Δ | CALL
ratio: 2.86 (Z=2.43) | dR/dt=+1.67
→ Buy side dominance spike detected ⚡

🧠 2. Skew impulse系アラート（vol）
✅ 対象

満期：0DTE / Front

Δ帯：25Δ

指標：RR（Risk Reversal）・Slope（Skewness）

判定：閾値 + 変化率

📐 2-1. RR
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


RR < -0.05 → Call skew spike

RR > +0.05 → Put skew spike

|dRR/dt| > 0.02 → 急変

📐 2-2. Slope
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


Slope < -0.1 → Call skew spike

Slope > 0.1 → Put skew spike

|dSlope/dt| > 0.05 → 初動

📨 2-3. Discord通知内容（例）
[SKEW ALERT]
2025-10-28 04:58:00 | Front | 25Δ
RR:-0.065 | dRR/dt:-0.028
Slope:-0.12 | dSlope/dt:-0.062
→ Call skew impulse detected 📈

🧠 3. コンビネーション（複合）アラート

あなたの意図する「本命のシグナル」はココ👇

✅ 対象

満期：0DTE / Front

Δ帯：25Δ

トリガー：ratio系 + skew impulse系 同時 or 近接発生

📐 3-1. ロジック
🟢 上方向（ロングサイド）

ratio Zscore ≥ 2 or dRatio/dt ≥ 0.8

RR < -0.05 or slope < -0.1（Call skew優勢）

→ callフローによる squeeze 初動シグナル

🔴 下方向（ショートサイド）

ratio Zscore ≤ -2 or dRatio/dt ≤ -0.8

RR > +0.05 or slope > +0.1（Put skew優勢）

→ putフローによる panic hedge / dump 初動シグナル

⏳ 3-2. 発火条件

同じ 1分足で両方の条件が満たされたとき

または skew→ratio のタイムラグ ≤ 2分 以内

👉 Skewが先に走って、板が続くケースも考慮
👉 ratioだけでも skewだけでもアラートは出るが、「両方揃うと強いトリガー」として別枠アラート

📨 3-3. Discord通知例
[COMBO ALERT 🚨]
2025-10-28 04:58:00 | 0DTE | 25Δ
ratio: 2.46 (Z=2.38, dR/dt=+1.53)
RR:-0.067 (dRR/dt=-0.031)
Slope:-0.11
→ CALL Skew Spike + Bid dominance
>>> STRONG BUY PRESSURE SIGNAL ⚡

🧮 4. 想定されるアラート本数
種別	対象	判定粒度	満期×Δ帯×方向	本数（概算/1日）
Ratio単独	25Δ	1分足	0DTE,Front × Call/Put	30〜60件
RR/Slope単独	25Δ	1分足	同上	20〜40件
複合（Combo）	25Δ	1分足	同上	5〜15件

👉 ※これは BTC/ETH どちらも監視した場合の目安
👉 実際には Zスコア＋dRatioフィルターで 大半のノイズはカット されます。

🧪 5. ratioのrawデータに対する注意点

あなたの例👇

Next ATM put ratio = 0.0156
Front ATM put ratio = 107.0000


これはおそらく：

板が薄い → 片側ゼロに近い

一瞬の剥がれ・異常値

⚠️ なので：

ratio計算前に「bid/askの合計サイズが閾値未満なら無視」
例）合計サイズが 10 USD 以下はスキップ

ratio > 50 とかは outlier として除外

Zスコアベースにすることでこうした外れ値は自然に弾ける

👉 これで ダマシをかなり削減 できます。

✅ まとめ：あなたのアラート構成
アラート種別	対象	閾値・条件	備考
Ratio Spike	25Δ, 0DTE/Front	Z≥2 or	dR/dt
RR Spike	同上	RR< -0.05 or > 0.05 /	dRR/dt
Slope Spike	同上	Slope < -0.1 or > 0.1 /	dSlope/dt
Combo	同上	Ratio + RR/Slope同時発火	本命シグナル 🚀
Outlier対策	ratio>50 or 板薄	除外処理	ダマシ対策