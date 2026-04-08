const express = require('express')
const client = require('prom-client')
const fs = require('fs')
const path = require('path')

const app = express()
const port = 3000
const register = new client.Registry()

// デフォルトメトリクス（CPU・メモリ等）の自動収集
client.collectDefaultMetrics({ register })

// HTTPリクエスト数カウンター
const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [register]
})

// HTTPリクエスト処理時間ヒストグラム
const httpRequestDurationMs = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'Duration of HTTP requests in milliseconds',
  labelNames: ['method', 'path', 'status'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register]
})

const logDir = '/app/logs'
const logFile = path.join(logDir, 'access.log')

// ミドルウェア: メトリクス計測 + アクセスログ記録
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    const labels = { method: req.method, path: req.path, status: res.statusCode }
    httpRequestsTotal.inc(labels)
    httpRequestDurationMs.observe(labels, duration)

    const entry = `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms\n`
    fs.appendFile(logFile, entry, err => {
      if (err) console.error('Log write failed:', err)
    })
  })
  next()
})

app.get('/', (req, res) => res.send('Hello!!!!!!'))

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType)
  res.end(await register.metrics())
})

app.listen(port, () => console.log(`Listening on port ${port}`))
