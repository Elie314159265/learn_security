# CLAUDE.md — learn_security

## プロジェクトの目的

セキュリティ研究を目的としたリポジトリ。
毎回「ある技術スタックでアプリを実装 → Dockerコンテナ化 → 偵察・攻撃・計測・結果報告」のサイクルを繰り返す。
攻撃手順は **Cyber Kill Chain** を骨格とし、**MITRE ATT&CK Enterprise Matrix** のタクティクス・テクニックに対応付けて理論的に組み立てる。

---

## 管理ファイル

| ファイル | 役割 |
|---------|------|
| `CLAUDE.md` | 全体コンテキスト・進め方・規約 |
| `README.md` | リポジトリ概要（外部向け） |
| `THEMES.md` | 実施済みテーマの一覧（スタック・深刻度・ステータス） |

---

## ディレクトリ構成ルール

```
learn_security/
├── CLAUDE.md                        # このファイル（全体のコンテキスト）
├── README.md
└── <カテゴリ>/                      # 例: container/, web/, network/
    └── <技術名>/                    # 例: distroless/, flask/
        └── <スタック名>/            # 例: node/, python/
            ├── docker-compose.yml   # アプリ + 観測基盤をまとめて定義
            ├── Dockerfile
            ├── prometheus.yml       # Prometheus スクレイプ設定
            ├── <アプリソース>
            └── PENETRATION.md       # 攻撃記録（必須）
```

---

## 各回の進め方

### Step 1 — アプリ開発
- 対象技術スタックでシンプルなアプリを実装する
- 意図的に脆弱性を含める場合はコード内にコメントで明記し、ユーザに確認を取る

### Step 2 — コンテナ化と観測基盤の構築

`docker-compose.yml` に以下を含める。

```yaml
services:
  app:           # 対象アプリ
  prometheus:    # メトリクス収集（ポート 9090）
  grafana:       # 可視化（ポート 3001 など app と被らないポート）
  node-exporter: # ホストメトリクス（ポート 9100）
```

アプリのログは Volume で永続化する。

```yaml
volumes:
  app-logs:
    driver: local
```

```yaml
# app サービス内
volumes:
  - app-logs:/app/logs
```

Node.js アプリの場合は `prom-client` でアプリ層メトリクスを `/metrics` エンドポイントに公開し、Prometheus がスクレイプする。

### Step 3 — コンテナ起動 & ログ確認

```bash
docker compose up -d --build

# アプリログ（リアルタイム）
docker logs -f <container>

# Volume に永続化されたログ
docker compose exec app cat /app/logs/access.log
```

### Step 4 — 静的脆弱性スキャン（Trivy）

攻撃前にコンテナイメージの既知脆弱性を把握する。

```bash
# ローカルスキャン
trivy image --severity HIGH,CRITICAL <image>

# SBOM 出力
trivy image --format cyclonedx --output sbom.json <image>
```

> **GitHub Actions での注意（2026年3月の Supply Chain インシデントより）:**  
> `aquasecurity/trivy-action` はバージョンタグではなく、イミュータブルなコミット SHA にピンすること。

```yaml
- uses: aquasecurity/trivy-action@<commit-sha>  # タグ指定禁止
  with:
    image-ref: '<image>'
    format: 'sarif'
    output: 'trivy-results.sarif'
    severity: 'HIGH,CRITICAL'
    exit-code: '1'
```

### Step 5 — 偵察・攻撃（Kill Chain × ATT&CK）

以下のフェーズ順で実施し、各フェーズに対応する **ATT&CK タクティクス** を明記して `PENETRATION.md` に記録する。

| Kill Chain フェーズ | ATT&CK タクティクス（Enterprise） | 主なツール |
|--------------------|----------------------------------|-----------|
| 1. Reconnaissance（偵察） | TA0043 Reconnaissance / TA0007 Discovery | `nmap`, `curl` |
| 2. Weaponization（武器化） | TA0001 Initial Access（前提調査） | ペイロード作成 |
| 3. Delivery（配信） | TA0001 Initial Access | `curl`, `ffuf`, `gobuster` |
| 4. Exploitation（悪用） | TA0002 Execution | `sqlmap`, `curl` |
| 5. Installation（永続化） | TA0003 Persistence / TA0004 Privilege Escalation | `docker exec` |
| 6. C2（指令統制） | TA0011 Command and Control | 状況に応じ |
| 7. Actions on Objectives | TA0009 Collection / TA0010 Exfiltration / TA0040 Impact | 状況に応じ |

各テクニックは `T1xxx` の ATT&CK ID で記録する（例: パストラバーサル → T1083 File and Directory Discovery）。

### Step 6 — メトリクス・ログ収集

攻撃中・後に以下を確認する。

```bash
# Prometheus でリクエスト数・レイテンシを確認
curl http://localhost:9090/api/v1/query?query=http_requests_total

# Grafana ダッシュボードで可視化（ブラウザ）
# http://localhost:3001

# アプリログから異常リクエストを抽出
docker logs <container> 2>&1 | grep -E "4[0-9]{2}|5[0-9]{2}|error|Error"
```

### Step 7 — 結果報告（PENETRATION.md）

以下のセクションを必ず含める。

```markdown
## 対象環境（テーブル）
## 静的スキャン結果（Trivy）
## 攻撃フェーズ（Kill Chain × ATT&CK 対応付き）
## 観測メトリクス・ログ（攻撃前後の比較）
## 総合結果（脆弱性テーブル）
## 推奨修正
## 使用ツール
```

---

## 脆弱性の記録フォーマット

総合結果テーブルには以下を含める。

| 項目 | 内容 |
|------|------|
| 脆弱性名 | 例: Reflected XSS |
| CWE | 例: CWE-79 |
| CVE | 該当があれば（例: CVE-2024-XXXX）、なければ「N/A」|
| CVSS v4.0 スコア | Base Score（推測値可）と各メトリクスグループの評価 |
| 深刻度 | Critical / High / Medium / Low / Info |
| ATT&CK ID | 例: T1059 |
| 状態 | 検出 / 問題なし / 要調査 |

### CVSS v4.0 スコアグループ（参考）

| グループ | 説明 |
|---------|------|
| Base | 脆弱性の本質的な特性（AV, AC, AT, PR, UI, VC, VI, VA, SC, SI, SA）|
| Threat | 実際の悪用状況・PoC の存在（E: Exploit Maturity）|
| Environmental | 対象環境固有の重要度・緩和策（CR, IR, AR + Modified Base）|
| Supplemental | 追加文脈（スコア変動なし）|

---

## 深刻度の基準（CVSS v4.0 Base Score 準拠）

| 深刻度 | CVSS v4.0 スコア | 例 |
|--------|----------------|-----|
| Critical | 9.0 〜 10.0 | RCE、認証バイパス |
| High | 7.0 〜 8.9 | SQLi、SSRF、パストラバーサル、Prototype Pollution |
| Medium | 4.0 〜 6.9 | XSS、セキュリティヘッダ欠如、CORS 設定ミス |
| Low | 0.1 〜 3.9 | バージョン情報漏洩、不要な HTTP メソッド許可 |
| Info | 0.0 | その他の観察事項 |

---

## GitHub Actions — CI スキャン構成方針

毎回のプッシュ・PR で以下を自動実行する。

1. **Trivy イメージスキャン** — HIGH/CRITICAL 検出時は CI を失敗させる
2. **SARIF レポート** — GitHub Security タブに自動アップロード
3. **SBOM 生成** — CycloneDX 形式でアーティファクト保存

> `aquasecurity/trivy-action` はコミット SHA でピンすること（タグは Supply Chain インシデントのリスクあり）。

---

## CLAUDE.md の更新ルール

このファイルに更新すべき内容が生じた場合（新しいフレームワーク導入、手順変更等）は：

1. 変更内容を Issue としてリポジトリ（`Elie314159265/learn_security`）に起票する
2. または修正を加えた PR を作成してレビューを受ける

直接コミットではなく Issue / PR を経由することで変更の意図を記録する。

---

## Claude Code への指示

- 新しいテーマ開始時は Step 1〜7 の順に進める
- 攻撃計画は必ず **Kill Chain フェーズ → ATT&CK タクティクス・テクニック ID** の順に対応付けて立案する
- 脆弱性の記録には **CVSS v4.0 スコア（推測値可）・CWE・CVE** を必ず付記する
- 日々新しい CVE が公開されるため、スキャン実施時は最新の脆弱性情報を Web 検索で補完する
- コンテナ起動前に `trivy image` で静的スキャンを行う
- `PENETRATION.md` には実際のコマンド出力を省略せず記録する
- コンテナの観測基盤（Prometheus / Grafana）を起動してから攻撃を開始し、攻撃前後のメトリクスを比較する
- 意図的に脆弱なコードを追加する場合は必ずユーザに確認を取る
- 攻撃対象は**ローカル環境のみ**とする
- 新しいテーマを開始するとき（Step 1 の冒頭）は `THEMES.md` の該当カテゴリセクションに新しい行を追加し、ステータスを「進行中」とする。カテゴリが存在しない場合は新セクションを作成する
- Step 7（PENETRATION.md 完成後）は `THEMES.md` の対応行を更新する。実施日・スタック・最高深刻度（総合結果テーブルで `状態 = 検出` の行の最高値）・主要脆弱性（検出済み上位2件）を記入し、ステータスを「完了」に変更する
