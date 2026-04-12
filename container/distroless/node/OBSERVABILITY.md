# OBSERVABILITY.md — メトリクス & ログ解析手順

> 対象: `container/distroless/node` スタック  
> 観測スタック: Prometheus / Grafana / Loki / Fluent Bit / cAdvisor / Node Exporter

---

## 目次

1. [アーキテクチャ概要](#1-アーキテクチャ概要)
2. [サービス一覧とポート](#2-サービス一覧とポート)
3. [起動・停止手順](#3-起動停止手順)
4. [メトリクス解析（Prometheus / Grafana）](#4-メトリクス解析prometheus--grafana)
5. [ログ解析（Loki / LogQL）](#5-ログ解析loki--logql)
6. [Grafana ダッシュボード操作](#6-grafana-ダッシュボード操作)
7. [攻撃フェーズ別の観測手順](#7-攻撃フェーズ別の観測手順)
8. [トラブルシューティング](#8-トラブルシューティング)

---

## 1. アーキテクチャ概要

```
┌─────────────────────────────────────────────────────────────┐
│  メトリクスパイプライン                                        │
│                                                             │
│  node-app (:3000/metrics) ──┐                               │
│  node-exporter (:9100)  ────┼──→ Prometheus (:9090)         │
│  cadvisor (:8080)       ────┘        │                      │
│                                      ▼                      │
│                               Grafana (:3001)               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  ログパイプライン                                              │
│                                                             │
│  各コンテナ (stdout/stderr)                                   │
│      │ Docker fluentd log driver                            │
│      ▼                                                      │
│  Fluent Bit (:24224) ──→ Loki (:3100)                        │
│                                   │                         │
│                                   ▼                         │
│                            Grafana (:3001)                   │
└─────────────────────────────────────────────────────────────┘
```

**ログ収集の仕組み:**  
各コンテナは Docker の `fluentd` ログドライバーで stdout/stderr を Fluent Bit へ送信する。`fluentd-async: true` により Fluent Bit 起動前のログも消失しない。Fluent Bit は受信したログに `container_name` / `source` ラベルを付与して Loki へ転送する。

---

## 2. サービス一覧とポート

| サービス | イメージ | ポート | 役割 |
|---------|---------|--------|------|
| app | node-app (distroless) | 3000 | 対象 Node.js アプリ |
| prometheus | prom/prometheus:v2.51.2 | 9090 | メトリクス収集・保存 |
| grafana | grafana/grafana:10.4.2 | 3001 | 可視化 UI |
| node-exporter | prom/node-exporter:v1.7.0 | 9100 | ホスト OS メトリクス |
| cadvisor | gcr.io/cadvisor/cadvisor:v0.55.1 | 8080 | コンテナメトリクス |
| loki | grafana/loki:3.3.2 | 3100 | ログ保存・検索 |
| fluent-bit | fluent/fluent-bit:5.0.2 | 24224 / 2020 | ログ収集・転送 |

---

## 3. 起動・停止手順

```bash
# 初回ビルド＆起動
docker compose up -d --build

# 再起動（コード変更後）
docker compose up -d --build app

# 全サービス停止
docker compose down

# ログ・データを含めて完全削除
docker compose down -v
```

### ヘルスチェック（起動確認）

```bash
# アプリ
curl http://localhost:3000/

# Loki（"ready" が返れば OK）
curl http://localhost:3100/ready

# Prometheus
curl http://localhost:9090/-/ready

# Fluent Bit（空レスポンスが返れば OK）
curl http://localhost:2020/api/v1/health

# Grafana
curl http://localhost:3001/api/health
```

---

## 4. メトリクス解析（Prometheus / Grafana）

### 4-1. Prometheus で直接クエリ（PromQL）

Prometheus UI: `http://localhost:9090`

#### アプリ層メトリクス

```promql
# HTTP リクエスト数（1分間レート）
sum(rate(http_requests_total[1m])) by (method, path, status)

# 4xx / 5xx エラー率
sum(rate(http_requests_total{status=~"4.."}[1m]))
sum(rate(http_requests_total{status=~"5.."}[1m]))

# 特定パスへのリクエスト数（偵察ツールのスキャン検出に有効）
sum(rate(http_requests_total{path="/admin"}[1m]))

# レスポンスタイム p50 / p95 / p99
histogram_quantile(0.50, sum(rate(http_request_duration_ms_bucket[1m])) by (le))
histogram_quantile(0.95, sum(rate(http_request_duration_ms_bucket[1m])) by (le))
histogram_quantile(0.99, sum(rate(http_request_duration_ms_bucket[1m])) by (le))
```

#### ホスト OS メトリクス（Node Exporter）

```promql
# CPU 使用率 (%)
100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[1m])) * 100)

# メモリ使用量
node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes

# メモリ使用率 (%)
(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100

# ディスク I/O（読み書きバイト/秒）
rate(node_disk_read_bytes_total[1m])
rate(node_disk_written_bytes_total[1m])

# ネットワーク受信バイト/秒
rate(node_network_receive_bytes_total{device="eth0"}[1m])
```

#### コンテナメトリクス（cAdvisor）

```promql
# コンテナ別 CPU 使用率
rate(container_cpu_usage_seconds_total{image!=""}[1m])

# コンテナ別メモリ使用量
container_memory_usage_bytes{image!=""}

# コンテナ別ネットワーク受信バイト/秒
rate(container_network_receive_bytes_total{image!=""}[1m])

# コンテナ別ファイルシステム使用量
container_fs_usage_bytes{image!=""}
```

### 4-2. 攻撃前後の比較（PromQL）

攻撃開始・終了時刻を記録しておき、以下のクエリで前後を比較する。

```promql
# 攻撃開始 5 分前のリクエスト数
sum(increase(http_requests_total[5m] offset 10m))

# 攻撃中のリクエスト数
sum(increase(http_requests_total[5m] offset 5m))

# 攻撃中の 404 急増確認
sum(increase(http_requests_total{status="404"}[1m]))
```

### 4-3. Fluent Bit 内部メトリクス

```bash
# 受信・送信レコード数とエラー確認
curl -s http://localhost:2020/api/v1/metrics | python3 -m json.tool
```

```json
{
  "input":  { "forward.0": { "records": 291, "bytes": 107183 } },
  "output": { "loki.0":    { "proc_records": 288, "errors": 0, "dropped_records": 0 } }
}
```

`errors` または `dropped_records` が増加している場合は Loki との疎通を確認する。

---

## 5. ログ解析（Loki / LogQL）

### 5-1. Loki API 直接クエリ

```bash
START=$(date -d '1 hour ago' +%s)000000000
END=$(date +%s)000000000

# 全コンテナの最新ログを取得
curl -s "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={job="fluent-bit"}' \
  --data-urlencode "start=$START" \
  --data-urlencode "end=$END" \
  --data-urlencode "limit=50" | python3 -m json.tool

# 利用可能なラベルの確認
curl -s http://localhost:3100/loki/api/v1/labels | python3 -m json.tool

# container_name に存在するコンテナ一覧
curl -s http://localhost:3100/loki/api/v1/label/container_name/values | python3 -m json.tool
```

### 5-2. LogQL クエリ集

LogQL はフィルタパイプライン `|~`（正規表現一致）/ `!~`（正規表現除外）で絞り込む。

#### 基本的なログ取得

```logql
# 全コンテナのログ
{job="fluent-bit"}

# 特定コンテナのみ
{container_name="/node-app-1"}

# stderr のみ（エラーログ）
{job="fluent-bit", source="stderr"}
```

#### エラー検出

```logql
# HTTP 4xx / 5xx エラーをすべて抽出
{container_name="/node-app-1"} |~ " [45][0-9]{2} "

# 404 のみ
{container_name="/node-app-1"} |~ " 404 "

# 500 系のみ
{container_name="/node-app-1"} |~ " 5[0-9]{2} "
```

#### 攻撃パターン検出

```logql
# パストラバーサル試行（../、URLエンコード済み含む）
{container_name="/node-app-1"} |~ "(\\.\\./|%2e%2e|%252e|etc/passwd|etc/shadow)"

# SQLインジェクション試行
{container_name="/node-app-1"} |~ "(?i)(union|select|insert|drop|delete|update|--|;--|' or| or ')"

# XSS 試行
{container_name="/node-app-1"} |~ "(?i)(<script|javascript:|onerror=|onload=|alert\\()"

# コマンドインジェクション試行
{container_name="/node-app-1"} |~ "(;\\s*(ls|cat|id|whoami|uname)|\\|\\s*(bash|sh)|`)"

# 全攻撃パターンをまとめて検出（PENETRATION.md 記録用）
{container_name="/node-app-1"}
  |~ "(\\.\\./|%2e%2e|union|select|insert|drop|<script|onerror=|;.*sh|\\|.*bash)"
```

#### 偵察フェーズの検出（ディレクトリスキャン）

```logql
# 短時間に大量の 404（ffuf / gobuster のスキャン痕跡）
# Grafana の Explore → rate({container_name="/node-app-1"} |~ " 404 "[1m]) で確認

# 存在しないパスへのアクセス一覧
{container_name="/node-app-1"} |~ " 404 " | line_format "{{.log}}"
```

#### ログ集計（rate クエリ）

```logql
# 1分あたりのログ行数（全コンテナ）
rate({job="fluent-bit"}[1m])

# app の 1分あたりエラー数
rate({container_name="/node-app-1"} |~ " [45][0-9]{2} "[1m])
```

### 5-3. コマンドラインでのログ解析スクリプト

```bash
# 過去1時間の app ログをすべて取得してパターン検出
START=$(date -d '1 hour ago' +%s)000000000
END=$(date +%s)000000000

curl -s "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={container_name="/node-app-1"}' \
  --data-urlencode "start=$START" \
  --data-urlencode "end=$END" \
  --data-urlencode "limit=1000" | python3 -c "
import sys, json, re

d = json.load(sys.stdin)
attack_pattern = re.compile(
    r'(\.\./|%2e%2e|etc/passwd|union|select|<script|onerror)',
    re.IGNORECASE
)

print('=== 攻撃パターン検出 ===')
for stream in d['data']['result']:
    for ts, line in stream['values']:
        log = json.loads(line).get('log', '')
        if attack_pattern.search(log):
            print(log.strip())
"
```

---

## 6. Grafana ダッシュボード操作

### アクセス

URL: `http://localhost:3001`  
認証: `admin` / `admin`

### ダッシュボード構成（Node App Observability）

| パネル | タイプ | データソース | 内容 |
|-------|-------|------------|------|
| HTTP Requests / sec | timeseries | Prometheus | method/path/status 別リクエストレート |
| HTTP Request Duration p50/p95/p99 | timeseries | Prometheus | パーセンタイルレスポンスタイム |
| Active Handles / Requests | stat | Prometheus | Node.js 非同期ハンドル数 |
| CPU Usage (Node.js process) | timeseries | Prometheus | プロセス CPU 使用時間 |
| Memory Usage (Node.js Heap) | timeseries | Prometheus | ヒープ使用量 |
| GC Duration | timeseries | Prometheus | GC 処理時間 |
| Host CPU Usage | timeseries | Prometheus | ホスト CPU 使用率 |
| Host Memory Usage | timeseries | Prometheus | ホストメモリ使用量 |
| Host Network Traffic | timeseries | Prometheus | ネットワーク送受信バイト |
| Container CPU Usage | timeseries | Prometheus | コンテナ別 CPU |
| Container Memory Usage | timeseries | Prometheus | コンテナ別メモリ |
| Container Network | timeseries | Prometheus | コンテナ別ネットワーク |
| Container Filesystem Usage | timeseries | Prometheus | コンテナ別 FS 使用量 |
| Container Restart Count | stat | Prometheus | 再起動回数 |
| **Logs — All Containers** | logs | **Loki** | 全コンテナのリアルタイムログ |
| **Logs — HTTP 4xx/5xx** | logs | **Loki** | エラーレスポンスのみ抽出 |
| **Logs — 攻撃パターン検出** | logs | **Loki** | パストラバーサル・SQLi 検出 |

### Explore でのアドホック解析

1. 左メニュー → **Explore**（コンパスアイコン）
2. データソースを **Loki** に切り替え
3. クエリ入力欄に LogQL を入力
4. 時間範囲を攻撃実施時間帯に合わせて絞り込む

### アノテーションの活用

攻撃開始・終了のタイミングをダッシュボードに記録する。

1. ダッシュボード上部 → **Edit** → **Annotations** → **Add annotation**
2. 攻撃開始時刻・フェーズ名（例: `Reconnaissance start`）を入力
3. メトリクスの変化点とログのタイムラインを視覚的に対応付けられる

---

## 7. 攻撃フェーズ別の観測手順

### Phase 1 — Reconnaissance（偵察）

**目的:** スキャンツールによるディレクトリ探索の痕跡を確認する。

```bash
# Prometheus: 404 急増を確認
curl -s "http://localhost:9090/api/v1/query" \
  --data-urlencode 'query=sum(rate(http_requests_total{status="404"}[1m]))' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['result'])"

# Loki: 存在しないパス一覧を抽出
START=$(date -d '30 minutes ago' +%s)000000000
END=$(date +%s)000000000
curl -s "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={container_name="/node-app-1"} |~ " 404 "' \
  --data-urlencode "start=$START" --data-urlencode "end=$END" \
  --data-urlencode "limit=100" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
paths=set()
for s in d['data']['result']:
    for ts,line in s['values']:
        log=json.loads(line).get('log','')
        parts=log.split()
        if len(parts)>=3: paths.add(parts[2])
for p in sorted(paths): print(p)
"
```

### Phase 3 — Delivery / Phase 4 — Exploitation（配信・悪用）

**目的:** 攻撃ペイロードの到達を確認する。

```bash
# Loki: パストラバーサル・SQLi ペイロードを時系列で抽出
START=$(date -d '1 hour ago' +%s)000000000
END=$(date +%s)000000000

curl -s "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={container_name="/node-app-1"} |~ "(\\.\\./|%2e%2e|union|select|<script)"' \
  --data-urlencode "start=$START" --data-urlencode "end=$END" \
  --data-urlencode "limit=50" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
for s in d['data']['result']:
    for ts,line in s['values']:
        log=json.loads(line).get('log','').strip()
        # ナノ秒タイムスタンプを秒に変換
        t=int(ts)//10**9
        from datetime import datetime,timezone
        dt=datetime.fromtimestamp(t,tz=timezone.utc).strftime('%H:%M:%S')
        print(f'[{dt}] {log}')
"
```

### Phase 7 — Actions on Objectives（目的達成）

**目的:** 攻撃後のシステム状態変化をメトリクスで確認する。

```promql
# 攻撃前後のリクエスト総数比較
increase(http_requests_total[30m])

# メモリリーク確認（攻撃後にヒープが増大していないか）
nodejs_heap_size_used_bytes

# 異常なファイルシステム使用量の増加（永続化試行の痕跡）
rate(container_fs_usage_bytes{name="node-app-1"}[5m])
```

---

## 8. トラブルシューティング

### ログが Loki に届かない

```bash
# 1. Fluent Bit の受信状況確認
curl -s http://localhost:2020/api/v1/metrics

# 2. Fluent Bit のエラーログ確認
docker logs node-fluent-bit-1 2>&1 | grep -i error

# 3. Loki の Ready 確認
curl http://localhost:3100/ready

# 4. コンテナのログドライバー確認
docker inspect <container_name> --format '{{json .HostConfig.LogConfig}}'

# 5. コンテナ再起動でログを再送
docker restart <container_name>
```

### Prometheus がメトリクスを収集できない

```bash
# スクレイプ状況を確認
curl -s "http://localhost:9090/api/v1/targets" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for t in d['data']['activeTargets']:
    print(t['scrapeUrl'], t['health'], t.get('lastError',''))
"
```

### Grafana で Loki パネルにデータが表示されない

1. Grafana → **Connections** → **Data sources** → **Loki** → **Test** を実行
2. クエリの時間範囲が正しいか確認（右上の時間セレクタ）
3. `container_name` ラベルの値が `/node-app-1` のようにスラッシュを含むことに注意

```logql
# 正しい書き方（スラッシュあり）
{container_name="/node-app-1"}

# 正規表現で前方一致
{container_name=~"/node-.*"}
```

### クエリ時間範囲エラー（`query length exceeds the limit`）

Loki のデフォルト最大クエリ範囲は 30 日。`start=0` などエポックゼロを指定しない。

```bash
# 正しい例: 過去 1 時間
START=$(date -d '1 hour ago' +%s)000000000
END=$(date +%s)000000000
```
