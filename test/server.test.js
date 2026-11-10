import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { cleanTranscript } from '../lib/asr.js'
import { trimHistory, SYSTEM_PROMPT } from '../lib/llm.js'
import { RateLimiter, LruCache } from '../lib/util.js'
import { intToChinese, normalizeForSpeech, splitForSpeech } from '../lib/text.js'
import { acceptPolish, cleanPolishOutput, shouldPolish } from '../lib/polish.js'

const UP_PORT = 18898
const APP_PORT = 18899
let up
let app
let lastSpeech = null
let speechHits = 0
const failedOnce = new Set()

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
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          lastSpeech = JSON.parse(body)
        } catch {}
        speechHits++
        // 模拟上游 250ms 抖动，对冲逻辑才会真的发第二路
        setTimeout(() => {
          if (lastSpeech?.input?.includes('重试') && !failedOnce.has(lastSpeech.input)) {
            failedOnce.add(lastSpeech.input)
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end('{"code":50507,"message":"Request failed: Unknown error."}')
            return
          }
          res.writeHead(200, { 'content-type': 'audio/mpeg' })
          res.end(Buffer.from('ID3fake-mp3'))
        }, 250)
      })
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
      VOICE_TTS_KEEPWARM_MS: '0',
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

test('config 暴露 8 个音色且不泄露密钥', async () => {
  const r = await fetch(`${base}/api/config`)
  const j = await r.json()
  assert.equal(j.tts.enabled, true)
  assert.equal(j.tts.voices.length, 8)
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

test('数字/单位/日期口语化', () => {
  assert.equal(intToChinese(0), '零')
  assert.equal(intToChinese(10), '十')
  assert.equal(intToChinese(1234), '一千二百三十四')
  assert.equal(intToChinese(10001), '一万零一')
  assert.equal(normalizeForSpeech('答案是 37.5%'), '答案是百分之三十七点五')
  assert.equal(normalizeForSpeech('2026-11-10 见'), '二零二六年十一月十日见')
  assert.equal(normalizeForSpeech('14:30 开会'), '十四点三十分开会')
  assert.equal(normalizeForSpeech('跑了 5km'), '跑了五公里')
  assert.equal(normalizeForSpeech('电话 13800138000'), '电话一三八零零一三八零零零')
})

test('数字边界：千分位/负百分比/区间/缩写不拆字母', () => {
  assert.equal(normalizeForSpeech('回撤 -12.3%'), '回撤负百分之十二点三')
  assert.equal(normalizeForSpeech('预算 ¥1,234.5'), '预算一千二百三十四点五元')
  assert.equal(normalizeForSpeech('3~5 天'), '三到五天')
  assert.equal(normalizeForSpeech('望京SOHO 见'), '望京SOHO 见')
  assert.equal(normalizeForSpeech('A/B 两版'), 'A或B 两版')
})

test('config 暴露转写模型与上下文润色开关', async () => {
  const r = await fetch(`${base}/api/config`)
  const j = await r.json()
  assert.ok(j.asr.model, '应报告转写模型')
  assert.equal(j.asr.polish, true)
})

test('朗读前清掉 Markdown/链接/表情', () => {
  const s = normalizeForSpeech('**加粗** 和 [链接](https://a.com) 以及 🎉 https://b.com/x')
  assert.equal(s.includes('*'), false)
  assert.equal(s.includes('http'), false)
  assert.equal(s.includes('🎉'), false)
  assert.match(s, /加粗/)
  assert.match(s, /链接/)
})

test('首句切得短、碎句不丢字', () => {
  const t = '你好呀，我是随口。今天想跟你聊聊最近在忙的事情，顺便看看有没有什么能帮上忙的。'
  const { out, rest } = splitForSpeech(t, true)
  assert.ok(out.length >= 3)
  assert.ok(out[0].length <= 16)
  assert.equal(out.join(''), t)
  assert.equal(rest, '')
  assert.deepEqual(splitForSpeech('你好，我是随口', true).out, ['你好，我是随口'])
})

test('TTS 请求前会做口语化（数字/单位）', async () => {
  const r = await fetch(`${base}/api/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '2026年11月10日，气温 37.5%，跑了 5km。', voice: 'anna', speed: 1 }),
  })
  assert.equal(r.status, 200)
  assert.ok(r.headers.get('x-tts-ms'))
  assert.ok(lastSpeech, '上游应收到合成请求')
  assert.match(lastSpeech.input, /二零二六年十一月十日/)
  assert.match(lastSpeech.input, /百分之三十七点五/)
  assert.match(lastSpeech.input, /五公里/)
  assert.equal(lastSpeech.input.includes('%'), false)
})


test('润色只在值得等的时候触发（短句 0ms）', () => {
  assert.equal(shouldPolish('嗯'), false)
  assert.equal(shouldPolish('今天天气不错'), false)
  assert.equal(shouldPolish('把那个 stock app 的 holdout 再跑一遍'), true)
  assert.equal(shouldPolish('帮我看看昨天晚上部署的那一堆容器现在还有几个在跑'), true)
})

test('润色输出清洗与守卫', () => {
  assert.equal(cleanPolishOutput('“把那个 StockApp 的 holdout 再跑一遍。”'), '把那个 StockApp 的 holdout 再跑一遍。')
  assert.equal(cleanPolishOutput('输出：你好。\n多余解释'), '你好。')
  assert.equal(acceptPolish('帮我讲个冷笑话三句话以内。', '帮我讲个冷笑话，三句话以内。'), true)
  assert.equal(acceptPolish('帮我讲个冷笑话。', '抱歉，作为一个 AI 我无法…'), false)
  assert.equal(acceptPolish('短句', '一句完全不相干而且很长很长很长的回答内容'), false)
})


test('首句对冲：hedge=true 会同时发两路合成，先回者胜', async () => {
  const before = speechHits
  const r = await fetch(`${base}/api/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '这是一句只在对冲用例里出现的独特句子', voice: 'anna', speed: 1, hedge: true }),
  })
  assert.equal(r.status, 200)
  await new Promise((res) => setTimeout(res, 300))
  assert.equal(speechHits - before, 2)
})


test('上游 5xx 自动重试一次（50507 这类抖动不该丢句）', async () => {
  const before = speechHits
  const r = await fetch(`${base}/api/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '这条会先失败一次再重试成功的独特句子', voice: 'anna', speed: 1 }),
  })
  assert.equal(r.status, 200)
  assert.ok((await r.arrayBuffer()).byteLength > 4)
  await new Promise((res) => setTimeout(res, 300))
  assert.equal(speechHits - before, 2)
})
