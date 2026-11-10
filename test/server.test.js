import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { cleanTranscript } from '../lib/asr.js'
import { trimHistory, SYSTEM_PROMPT } from '../lib/llm.js'
import { RateLimiter, LruCache } from '../lib/util.js'

const UP_PORT = 18898
const APP_PORT = 18899
let up
let app

const sse = (res, objs) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const o of objs) res.write(`data: ${JSON.stringify(o)}\n\n`)
  res.end('data: [DONE]\n\n')
}

before(async () => {
  up = http.createServer((req, res) => {
    if (req.url.endsWith('/chat/completions')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const payload = JSON.parse(body)
        assert.equal(payload.reasoning_effort, 'none')
        assert.equal(payload.stream, true)
        sse(res, [
          { choices: [{ delta: { content: '你好' } }] },
          { choices: [{ delta: { content: '，我在。' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        ])
      })
      return
    }
    if (req.url.endsWith('/audio/transcriptions')) {
      let n = 0
      req.on('data', (c) => (n += c.length))
      req.on('end', () => {
        assert.ok(n > 0)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ text: '<|zh|>你好呀<|NEUTRAL|>', seconds: 1.2 }))
      })
      return
    }
    if (req.url.endsWith('/audio/speech')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      res.end(Buffer.from('ID3fake-mp3'))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => up.listen(UP_PORT, '127.0.0.1', r))

  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  delete childEnv.NODE_OPTIONS
  app = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...childEnv,
      PORT: String(APP_PORT),
      ZX_AI_GATEWAY_URL: `http://127.0.0.1:${UP_PORT}`,
      VOICE_AI_TOKEN: 'test-token',
      VOICE_ASR_TOKEN: 'test-token',
      VOICE_TTS_MODE: 'direct',
      VOICE_TTS_BASE_URL: `http://127.0.0.1:${UP_PORT}`,
      VOICE_TTS_KEY: 'test-tts',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`))
  app.on('error', (e) => console.error('[app] spawn error', e))
  app.on('exit', (c) => console.error('[app] exited', c))
  console.error('[test] spawned pid', app.pid, 'cwd', new URL('..', import.meta.url).pathname)
  const deadline = Date.now() + 8000
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)
      if (r.ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error('app start timeout')
    await new Promise((r) => setTimeout(r, 100))
  }
})

after(() => {
  app?.kill('SIGTERM')
  up?.close()
})

const base = `http://127.0.0.1:${APP_PORT}`

test('health 报告 llm/asr/tts 就绪', async () => {
  const r = await fetch(`${base}/api/health`)
  const j = await r.json()
  assert.equal(r.status, 200)
  assert.equal(j.ok, true)
  assert.equal(j.llm, true)
  assert.equal(j.asr, true)
  assert.equal(j.tts, true)
})

test('config 暴露 4 个音色且不泄露密钥', async () => {
  const r = await fetch(`${base}/api/config`)
  const j = await r.json()
  assert.equal(j.tts.enabled, true)
  assert.equal(j.tts.voices.length, 4)
  assert.equal(JSON.stringify(j).includes('test-tts'), false)
})

test('chat 流式返回增量并收尾', async () => {
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '在吗' }] }),
  })
  assert.equal(r.status, 200)
  const text = await r.text()
  assert.match(text, /"t":"你好"/)
  assert.match(text, /"done":true/)
})

test('chat 拒绝空 messages', async () => {
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  })
  assert.equal(r.status, 400)
})

test('tts 返回 mp3 字节', async () => {
  const r = await fetch(`${base}/api/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好', voice: 'anna', speed: 1 }),
  })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') || '', /audio\/mpeg/)
  const buf = Buffer.from(await r.arrayBuffer())
  assert.ok(buf.length > 4)
})

test('首页与静态资源可访问，且带安全头', async () => {
  const r = await fetch(base + '/')
  assert.equal(r.status, 200)
  assert.match(await r.text(), /随口/)
  assert.match(r.headers.get('content-security-policy') || '', /connect-src 'self'/)
  const js = await fetch(base + '/app.js')
  assert.equal(js.status, 200)
  assert.match(js.headers.get('content-type') || '', /javascript/)
})

test('PWA：manifest 可装成独立 App（id/scope/standalone/图标齐全）', async () => {
  const r = await fetch(base + '/manifest.webmanifest')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') || '', /manifest\+json/)
  assert.equal(r.headers.get('cache-control'), 'no-cache')
  const m = await r.json()
  assert.equal(m.id, '/')
  assert.equal(m.scope, '/')
  assert.equal(m.start_url, '/')
  assert.equal(m.display, 'standalone')
  const sizes = m.icons.map((i) => i.sizes)
  for (const s of ['180x180', '192x192', '512x512']) assert.ok(sizes.includes(s), `缺 ${s}`)
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'))
})

test('PWA：iOS 桌面图标/meta 与 service worker 就绪', async () => {
  const html = await (await fetch(base + '/')).text()
  assert.match(html, /rel="apple-touch-icon"[^>]*sizes="180x180"[^>]*href="\/icon-180\.png"/)
  assert.match(html, /name="apple-mobile-web-app-capable"[^>]*content="yes"/)
  assert.match(html, /name="apple-mobile-web-app-title"/)
  assert.match(html, /name="mobile-web-app-capable"/)
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/)

  const icon = await fetch(base + '/icon-180.png')
  assert.equal(icon.status, 200)
  assert.match(icon.headers.get('content-type') || '', /image\/png/)

  const sw = await fetch(base + '/sw.js')
  assert.equal(sw.status, 200)
  assert.match(sw.headers.get('content-type') || '', /javascript/)
  assert.equal(sw.headers.get('cache-control'), 'no-cache')
  const body = await sw.text()
  assert.match(body, /voice-shell/)
  assert.match(body, /addEventListener\('fetch'/)
  assert.match(body, /pathname\.startsWith\('\/api\/'\)/)
})

test('路径穿越被拒绝', async () => {
  const r = await fetch(`${base}/..%2fserver.js`)
  assert.ok([400, 403, 404].includes(r.status))
})

test('cleanTranscript 去掉模型标签', () => {
  assert.equal(cleanTranscript('<|zh|><|NEUTRAL|>今天天气不错<|end|>'), '今天天气不错')
  assert.equal(cleanTranscript('  a  b  '), 'a b')
})

test('trimHistory 只留最近 16 条合法消息', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}` }))
  msgs.push({ role: 'system', content: 'x' })
  const out = trimHistory(msgs)
  assert.equal(out.length, 16)
  assert.equal(out[0].content, '14')
  assert.ok(SYSTEM_PROMPT.includes('随口'))
})

test('RateLimiter 到点拒绝', () => {
  const rl = new RateLimiter(2, 1000)
  assert.equal(rl.take('a'), true)
  assert.equal(rl.take('a'), true)
  assert.equal(rl.take('a'), false)
  assert.equal(rl.take('b'), true)
})

test('LruCache 按容量淘汰', () => {
  const c = new LruCache({ maxItems: 2, maxBytes: 100 })
  c.set('a', Buffer.alloc(10))
  c.set('b', Buffer.alloc(10))
  c.set('c', Buffer.alloc(10))
  assert.equal(c.get('a'), null)
  assert.ok(c.get('c'))
})
