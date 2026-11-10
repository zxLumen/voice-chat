import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AI_TOKEN,
  ASR_MODEL,
  MAX_ASR_BYTES,
  MAX_ASR_SECONDS,
  MODEL,
  POLISH_ENABLED,
  PORT,
  TTS_DAILY_CHARS,
  TTS_KEEPWARM_MS,
  TTS_MODE,
  VERSION,
  VOICES,
} from './lib/env.js'
import { asrReady, transcribe, warmupAsr } from './lib/asr.js'
import { streamChat } from './lib/llm.js'
import { polishStats, polishTranscript } from './lib/polish.js'
import { synthesize, ttsEnabled, ttsStats, warmupTts } from './lib/tts.js'
import { RateLimiter, clientIp, json, readBody, readJson, sseHead, sseSend, text } from './lib/util.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(ROOT, 'web')

const limits = {
  chat: new RateLimiter(40, 5 * 60_000),
  asr: new RateLimiter(60, 5 * 60_000),
  tts: new RateLimiter(300, 5 * 60_000),
}

const bjDay = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
const ttsBudget = { day: '', chars: 0 }
function chargeTts(chars) {
  const d = bjDay()
  if (ttsBudget.day !== d) {
    ttsBudget.day = d
    ttsBudget.chars = 0
  }
  if (ttsBudget.chars + chars > TTS_DAILY_CHARS) return false
  ttsBudget.chars += chars
  return true
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'microphone=(self)',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://zxlumen.cn",
}

const NO_CACHE = new Set(['index.html', 'sw.js', 'manifest.webmanifest'])

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  if (!/^[a-zA-Z0-9._-]+$/.test(rel)) return text(res, 400, 'bad path')
  const file = path.join(WEB, rel)
  if (!file.startsWith(WEB + path.sep)) return text(res, 403, 'forbidden')
  fs.readFile(file, (err, buf) => {
    if (err) return text(res, 404, 'not found')
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, {
      'content-type': type,
      'content-length': buf.length,
      'cache-control': NO_CACHE.has(rel) ? 'no-cache' : 'public, max-age=300',
      ...SECURITY_HEADERS,
    })
    res.end(buf)
  })
}

const config = {
  version: VERSION,
  model: MODEL,
  asr: { enabled: asrReady(), maxSeconds: MAX_ASR_SECONDS, model: ASR_MODEL, polish: POLISH_ENABLED },
  tts: { enabled: ttsEnabled(), mode: TTS_MODE, voices: VOICES, defaultVoice: VOICES[0].id },
  limits: { chatPer5min: 40, asrPer5min: 60, ttsPer5min: 300 },
}

async function handleChat(req, res) {
  const ip = clientIp(req)
  if (!limits.chat.take(ip)) return json(res, 429, { error: '说话太快了，歇 5 分钟。' })

  let body
  try {
    body = await readJson(req, 96 * 1024)
  } catch {
    return json(res, 400, { error: '请求体不是合法 JSON' })
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (!messages.length) return json(res, 400, { error: 'messages 不能为空' })
  if (messages.filter((m) => m?.role === 'user').length > 40) {
    return json(res, 400, { error: '对话太长了，开个新对话吧。' })
  }

  const ac = new AbortController()
  res.on('close', () => ac.abort())

  sseHead(res)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
  try {
    const { text: answer, usage } = await streamChat({
      messages,
      signal: ac.signal,
      onDelta: (t) => sseSend(res, { t }),
    })
    clearInterval(heartbeat)
    sseSend(res, { done: true, usage: usage ? { in: usage.prompt_tokens, out: usage.completion_tokens } : null, len: answer.length })
    res.end()
  } catch (e) {
    clearInterval(heartbeat)
    if (!ac.signal.aborted) {
      sseSend(res, { error: e instanceof Error ? e.message : '对话失败' })
    }
    res.end()
  }
}

/** 前端把最近几轮对话（每条 ≤160 字）base64url 编码放进 x-suikou-ctx。 */
function readCtx(req) {
  const raw = String(req.headers['x-suikou-ctx'] || '')
  if (!raw || raw.length > 4096) return []
  try {
    const arr = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (!Array.isArray(arr)) return []
    return arr
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 160) }))
  } catch {
    return []
  }
}

async function handleAsr(req, res) {
  const ip = clientIp(req)
  if (!limits.asr.take(ip)) return json(res, 429, { error: '识别太频繁，歇一会儿。' })
  if (!asrReady()) return json(res, 503, { error: '转写未配置' })

  const type = String(req.headers['content-type'] || 'audio/webm')
  if (!/^audio\/|^application\/octet-stream/.test(type)) {
    return json(res, 415, { error: '只接受音频请求体' })
  }
  let buf
  try {
    buf = await readBody(req, MAX_ASR_BYTES)
  } catch (e) {
    return json(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? '录音太长了' : '读取音频失败' })
  }
  if (buf.length < 1200) return json(res, 400, { error: '录音太短了' })

  try {
    const r = await transcribe(buf, { contentType: type })
    if (!r.text) return json(res, 200, { text: '', ms: r.ms })
    if (r.seconds && r.seconds > MAX_ASR_SECONDS + 2) return json(res, 413, { error: '单次录音请控制在 60 秒内' })
    // 上下文纠错：前端把最近几轮对话塞在 x-suikou-ctx（base64url JSON）里，
    // 让后处理知道「对位」「StockApp」这些词，别把专名听成同音字。
    const t1 = Date.now()
    const history = readCtx(req)
    const p = await polishTranscript({ text: r.text, history })
    console.log(
      `[asr] raw=${r.text.length}字 → ${p.polished ? '润色' : '原文'} ${p.text.length}字 ctx=${history.length} asr=${r.ms}ms polish=${Date.now() - t1}ms`,
    )
    return json(res, 200, {
      text: p.text,
      raw: r.text,
      polished: p.polished,
      seconds: r.seconds,
      ms: r.ms + p.ms,
      asrMs: r.ms,
      polishMs: p.ms,
    })
  } catch (e) {
    console.error('[asr]', e instanceof Error ? e.message : e)
    return json(res, 502, { error: '没听清，再说一次？' })
  }
}

async function handleTts(req, res) {
  const ip = clientIp(req)
  if (!limits.tts.take(ip)) return json(res, 429, { error: '合成太频繁' })
  if (!ttsEnabled()) return json(res, 503, { error: 'TTS 未启用' })

  let body
  try {
    body = await readJson(req, 8 * 1024)
  } catch {
    return json(res, 400, { error: '请求体不是合法 JSON' })
  }
  const hedge = body.hedge === true
  // 对冲会真的发两次合成，额度按实际用量记
  const chars = String(body.text || '').length * (hedge ? 2 : 1)
  if (!chargeTts(chars)) return json(res, 429, { error: '今天说得有点多，明天再聊。' })
  const t0 = Date.now()
  try {
    const buf = await synthesize({ text: body.text, voice: body.voice, speed: body.speed, hedge })
    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'content-length': buf.length,
      'cache-control': 'private, max-age=3600',
      'x-tts-ms': String(Date.now() - t0),
      ...SECURITY_HEADERS,
    })
    res.end(buf)
  } catch (e) {
    console.error('[tts]', e instanceof Error ? e.message : e)
    json(res, 502, { error: '语音合成失败' })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const p = url.pathname

  try {
    if (p === '/api/health') {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        llm: Boolean(AI_TOKEN),
        asr: asrReady(),
        tts: ttsEnabled(),
        ttsMode: TTS_MODE,
        model: MODEL,
        ttsStats: { ...ttsStats },
        asrPolish: { ...polishStats, enabled: POLISH_ENABLED },
        uptime: Math.round(process.uptime()),
      })
    }
    if (p === '/api/config') return json(res, 200, config)
    if (p === '/api/chat' && req.method === 'POST') return await handleChat(req, res)
    if (p === '/api/asr' && req.method === 'POST') return await handleAsr(req, res)
    if (p === '/api/tts' && req.method === 'POST') return await handleTts(req, res)
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' })
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p)
    return text(res, 405, 'method not allowed')
  } catch (e) {
    console.error('[server]', e)
    if (!res.headersSent) json(res, 500, { error: '服务开小差了' })
    else res.end()
  }
})

server.listen(PORT, () => {
  console.log(`[suikou] listening :${PORT} v${VERSION} asr=${asrReady()} tts=${TTS_MODE} model=${MODEL}`)
  // SenseVoice 冷启动很慢（实测 14s+），启动时先预热，之后每 4 分钟打一次 0.4s 静音保温
  const keepWarmMs = Number(process.env.VOICE_ASR_KEEPWARM_MS || 240_000)
  const warm = () =>
    warmupAsr()
      .then((r) => console.log('[suikou] asr warmup', JSON.stringify(r)))
      .catch((e) => console.error('[suikou] warmup failed', e))
  warm()
  if (keepWarmMs > 0) setInterval(warm, keepWarmMs).unref()

  // TTS 保温：CosyVoice2 空闲后首包实测 13.8s，定时喂一小句压住冷启动
  if (TTS_KEEPWARM_MS > 0 && ttsEnabled()) {
    const warmTts = () =>
      warmupTts()
        .then((r) => console.log('[suikou] tts warmup', JSON.stringify(r)))
        .catch((e) => console.error('[suikou] tts warmup failed', e))
    setTimeout(warmTts, 3000).unref?.()
    setInterval(warmTts, TTS_KEEPWARM_MS).unref()
  }
})

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[suikou] ${sig}, closing`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000)
  })
}
