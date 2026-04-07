# Penetration Test Record — Node.js Express Server (Port 3000)

## 対象環境

| 項目 | 内容 |
|------|------|
| フレームワーク | Express 4.18.2 |
| ランタイム | Node.js 24 |
| コンテナ | distroless (`gcr.io/distroless/nodejs24-debian13:nonroot`) |
| 実行ユーザ | nonroot (uid=65532) |
| 公開ポート | 3000 |
| エントリポイント | `index.js` (`GET /` のみ定義) |
| 実施日 | 2026-04-08 |

---

## Phase 1 — 偵察 (Reconnaissance)

### 1-1. ポートスキャン

```bash
nmap -sV -sC -p 3000 localhost
```

| オプション | 説明 |
|-----------|------|
| `-sV` | サービスのバージョンを検出する（Service Version detection）|
| `-sC` | デフォルトスクリプトを実行する（NSE: Nmap Scripting Engine）。HTTP タイトル取得など基本情報を自動収集 |
| `-p 3000` | スキャン対象ポートを 3000 番に限定 |

**実行意図:** サービスの種類（HTTP/HTTPS など）とバージョンを把握し、既知の脆弱性を調べる起点とする。

**結果:**
```
PORT     STATE SERVICE VERSION
3000/tcp open  http    Node.js (Express middleware)
```
→ Express を使っていることが外部から確認できてしまう。

---

### 1-2. レスポンスヘッダの確認

```bash
curl -v http://localhost:3000/
```

| オプション | 説明 |
|-----------|------|
| `-v` | 詳細出力（verbose）。送受信ヘッダを含む全通信内容を表示 |

**実行意図:** サーバが返すレスポンスヘッダを確認し、技術スタックの情報漏洩・セキュリティヘッダの有無を確認する。

**結果（注目点）:**
```
X-Powered-By: Express   ← 技術スタックの漏洩
```
セキュリティヘッダ（`X-Frame-Options` 等）は一切返されていない。

---

### 1-3. HTTPメソッドの列挙

```bash
for method in GET POST PUT DELETE PATCH OPTIONS HEAD TRACE; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X $method http://localhost:3000/)
  echo "$method: $code"
done
```

| オプション | 説明 |
|-----------|------|
| `-s` | サイレントモード（進捗バーを非表示） |
| `-o /dev/null` | レスポンスボディを破棄（不要な出力を抑制） |
| `-w "%{http_code}"` | ステータスコードのみ標準出力に書き出す |
| `-X $method` | 使用する HTTP メソッドを指定 |

**実行意図:** サーバが受け付ける HTTP メソッドを列挙する。`TRACE` が有効な場合はクロスサイトトレーシング（XST）攻撃のリスクがある。

**結果:**
```
GET:     200
POST:    404
OPTIONS: 200   ← Allow ヘッダで許可メソッドが開示される
HEAD:    200
TRACE:   404   ← 無効（安全）
```

---

## Phase 2 — エンドポイント列挙 (Enumeration)

### 2-1. 機密パスのチェック

```bash
for path in /admin /api /env /.env /config /health /metrics /debug /status \
            /api/v1 /graphql /login /dashboard /upload /files /static \
            /public /private /secret /token /auth; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000$path)
  echo "$code  $path"
done
```

**実行意図:** 認証なしでアクセス可能な管理画面・設定ファイル・APIエンドポイントが存在しないかを確認する。`/.env` や `/config` が 200 を返す場合は機密情報が漏洩する。

**結果:** 全パス 404。定義されたルートは `GET /` のみのため影響なし。

---

### 2-2. Node.js 固有パスのチェック

```bash
for path in /node_modules /package.json /__proto__ /constructor /prototype \
            /server.js /index.js /app.js /main.js /.git /.gitignore /Dockerfile; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000$path)
  echo "$code  $path"
done
```

**実行意図:** ソースコードや依存関係情報（`package.json`）、Git リポジトリ（`.git`）が外部に公開されていないかを確認する。`/node_modules` が参照できると依存パッケージの脆弱性を調査される。

**結果:** 全パス 404。Express の静的ファイル配信は未設定のため安全。

---

## Phase 3 — 脆弱性テスト (Vulnerability Assessment)

### 3-1. セキュリティヘッダの欠如確認

```bash
headers=$(curl -s -I http://localhost:3000/)
for h in "x-frame-options" "x-content-type-options" "x-xss-protection" \
         "content-security-policy" "strict-transport-security" \
         "referrer-policy" "permissions-policy"; do
  if echo "$headers" | grep -qi "$h"; then
    echo "OK      $h"
  else
    echo "MISSING $h"
  fi
done
```

| オプション | 説明 |
|-----------|------|
| `-I` | HEAD リクエストを送信し、ヘッダのみ取得 |
| `grep -qi` | 大文字小文字を無視（`-i`）してサイレント検索（`-q`） |

**実行意図:** OWASP が推奨するセキュリティヘッダが設定されているかを確認する。欠如しているとブラウザ側の防御機構が無効になる。

**結果（全て MISSING）:**

| ヘッダ | 欠如による影響 |
|--------|--------------|
| `X-Frame-Options` | クリックジャッキング攻撃が可能 |
| `X-Content-Type-Options` | MIME スニッフィングによる XSS が可能 |
| `X-XSS-Protection` | 旧ブラウザの XSS フィルタ無効 |
| `Content-Security-Policy` | XSS・データインジェクション攻撃が可能 |
| `Strict-Transport-Security` | HTTP ダウングレード攻撃が可能 |
| `Referrer-Policy` | リファラ経由の情報漏洩が可能 |
| `Permissions-Policy` | カメラ・位置情報等への不正アクセスが可能 |

---

### 3-2. パストラバーサル (Path Traversal)

```bash
# 通常
curl -v "http://localhost:3000/../../../etc/passwd"

# URLエンコード（../  を %2e%2e%2f に変換）
curl -s -o /dev/null -w "%{http_code}" \
  "http://localhost:3000/%2e%2e%2f%2e%2e%2fetc%2fpasswd"

# ダブルエンコード（%2e → %252e）
curl -s -o /dev/null -w "%{http_code}" \
  "http://localhost:3000/%252e%252e%252f%252e%252e%252fetc%252fpasswd"
```

**実行意図:** `../` を使ってドキュメントルート外のファイル（`/etc/passwd` 等）を読み出せないかを確認する。URLエンコードやダブルエンコードで WAF・フィルタを回避するパターンも試す。

**結果:** 全て 404。Express はルーティング前にパスを正規化するため `../` は除去される。

---

### 3-3. XSS・インジェクション系

```bash
# XSS
curl -s "http://localhost:3000/?q=<script>alert(1)</script>"

# SQL インジェクション（URLエンコード済み）
curl -s -o /dev/null -w "status: %{http_code}\n" \
  "http://localhost:3000/?id=1%27%20OR%20%271%27%3D%271"

# コマンドインジェクション
curl -s -o /dev/null -w "status: %{http_code}\n" \
  "http://localhost:3000/?cmd=\$(id)"
```

**実行意図:** クエリパラメータが DB クエリやシェルコマンドに渡されている場合の影響を確認する。レスポンスにペイロードが反映されると Reflected XSS が成立する。

**結果:** `GET /` はパラメータを一切処理しないため影響なし。ただし将来ルートを追加した際は要注意。

---

### 3-4. Prototype Pollution

```bash
curl -s -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -d '{"__proto__":{"polluted":true}}'

curl -s -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -d '{"constructor":{"prototype":{"polluted":true}}}'
```

| オプション | 説明 |
|-----------|------|
| `-X POST` | HTTP メソッドを POST に指定 |
| `-H "Content-Type: application/json"` | JSON ボディを送ることをサーバに伝えるヘッダ |
| `-d '...'` | リクエストボディのデータを指定 |

**実行意図:** JSON ボディの `__proto__` や `constructor.prototype` を操作して JavaScript のオブジェクト原型を汚染できないかを確認する（Node.js 固有の深刻な脆弱性）。

**結果:** POST ルートが未定義のため 404。ボディが処理される場合は Express の `express.json()` ミドルウェアと組み合わせて検証が必要。

---

### 3-5. HTTPレスポンス分割 / ヘッダインジェクション

```bash
# CRLF インジェクション（%0d%0a = \r\n）
curl -v "http://localhost:3000/?name=foo%0d%0aSet-Cookie:%20malicious=1"

# Host ヘッダインジェクション
curl -s -o /dev/null -w "status: %{http_code}\n" \
  -H "Host: evil.com" http://localhost:3000/

# X-Forwarded-For 偽装
curl -s -I -H "X-Forwarded-For: 127.0.0.1" http://localhost:3000/
```

**実行意図:**
- **CRLF インジェクション:** レスポンスヘッダにユーザ入力が混入する場合、`\r\n` を挿入することで任意のヘッダやボディを注入できる。
- **Host インジェクション:** パスワードリセットメール等でサーバが Host ヘッダを信頼している場合、悪意のあるドメインへのリンクを生成させられる。
- **X-Forwarded-For:** IP ベースのアクセス制御を回避できないかを確認。

**結果:** Express が CRLF を無効化。Host ヘッダは処理されない（200 を返すのみ）。

---

### 3-6. CORS 設定確認

```bash
# CORS ヘッダの有無を確認
curl -s -I -H "Origin: https://evil.com" http://localhost:3000/ \
  | grep -iE "access-control|origin"
```

**実行意図:** 悪意のあるオリジンからのリクエストに `Access-Control-Allow-Origin: *` を返す場合、クロスサイトリクエストでレスポンスを読み取られる。

**結果:** CORS ヘッダなし。ブラウザからのクロスオリジンリクエストはデフォルトでブロックされる状態。ただし将来 CORS を設定する際は `*` を避けること。

---

### 3-7. 負荷テスト（DoS 耐性）

```bash
# 50並列リクエスト
time (seq 50 | xargs -P50 -I{} curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:3000/ | sort | uniq -c)

# 巨大クエリストリング（10,000文字）
python3 -c "print('A'*10000)" | tr -d '\n' | \
  xargs -I{} curl -s -o /dev/null -w "status: %{http_code}\n" \
  "http://localhost:3000/?q={}"

# 巨大 POST ボディ（100KB）
python3 -c "import sys; sys.stdout.write('A'*100000)" | \
  curl -s -X POST -H "Content-Type: text/plain" \
  --data-binary @- -o /dev/null -w "status: %{http_code}\n" \
  http://localhost:3000/
```

| オプション | 説明 |
|-----------|------|
| `xargs -P50` | 最大 50 プロセス並列実行 |
| `--data-binary @-` | 標準入力をそのままバイナリとして POST ボディに渡す |
| `time (...)` | コマンドの実行時間を計測 |

**実行意図:** 大量リクエストや巨大ペイロードでサービスが停止・遅延しないかを確認する（簡易 DoS テスト）。

**結果:**
- 50 並列: 全て 200、応答時間 **0.111 秒**（問題なし）
- 10,000 文字クエリ: 200（Express は処理）
- 100KB POST: 404（POST ルート未定義のため受け付けない）

---

## 総合結果

| # | 脆弱性 | 深刻度 | 状態 |
|---|--------|--------|------|
| 1 | `X-Powered-By` による技術スタック漏洩 | 低 | **検出** |
| 2 | セキュリティヘッダ全欠如（7項目）| 中 | **検出** |
| 3 | パストラバーサル | 高 | 問題なし |
| 4 | XSS（Reflected） | 高 | 問題なし（現状） |
| 5 | SQL インジェクション | 高 | 問題なし（現状） |
| 6 | コマンドインジェクション | 高 | 問題なし（現状） |
| 7 | Prototype Pollution | 高 | 問題なし（現状） |
| 8 | CRLF / ヘッダインジェクション | 中 | 問題なし |
| 9 | CORS 未設定 | 中 | 要注意（将来的リスク） |
| 10 | DoS 耐性 | — | 問題なし |

---

## 推奨修正

### 優先度: 高

```bash
npm install helmet
```

```js
// index.js
const helmet = require('helmet')
app.use(helmet()) // セキュリティヘッダを一括付与 + X-Powered-By を自動削除
```

`helmet()` が付与するヘッダ:

| ヘッダ | 内容 |
|--------|------|
| `Content-Security-Policy` | 読み込み可能なリソースを制限 |
| `X-Content-Type-Options: nosniff` | MIME スニッフィング防止 |
| `X-Frame-Options: SAMEORIGIN` | クリックジャッキング防止 |
| `Strict-Transport-Security` | HTTPS 強制 |
| `Referrer-Policy` | リファラ制限 |
| `Permissions-Policy` | ブラウザ機能へのアクセス制限 |

### 優先度: 中

```js
// レート制限（express-rate-limit）
const rateLimit = require('express-rate-limit')
app.use(rateLimit({ windowMs: 60_000, max: 100 }))
```

---

## 使用ツール

| ツール | 用途 |
|--------|------|
| `nmap` | ポートスキャン・サービス検出 |
| `curl` | HTTP リクエスト送信・ヘッダ確認・各種テスト |
| `python3` | 大量データ生成 |
| `xargs -P` | 並列リクエスト実行 |
