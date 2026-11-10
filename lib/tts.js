import { GATEWAY_URL, TTS_BASE, TTS_KEY, TTS_MODE, TTS_MODEL, TTS_TOKEN, TTS_VOICE, VOICES } from './env.js'
import { LruCache, sha1 } from './util.js'
import { normalizeForSpeech } from './text.js'

const cache = new LruCache({ maxItems: 400, maxBytes: 32 * 1024 * 1024 })
export const ttsEnabled = () =>
  (TTS_MODE === 'direct' && Boolean(TTS_KEY)) || (TTS_MODE === 'gateway' && Boolean(TTS_TOKEN))

export const voiceList = () => VOICES.filter((v) => v.id !== 'all')

/** 单句最长 300 字，超出截断（前端本来按句切）。 */
export function clampText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 300)
}

export function normalizeVoice(v) {
  const id = VOICES.some((x) => x.id === v) ? v : TTS_VOICE
  return id
}

/** 运行指标：给 /api/health 看，便于判断冷启动和缓存命中。 */
export const ttsStats = { calls: 0, cacheHits: 0, lastMs: 0, lastTextLen: 0, warmMs: 0, warmAt: 0, fails: 0, hedgeWins: 0 }

/**
 * 合成语音，返回 mp3 Buffer。
 * direct  → 直连 OpenAI 兼容 /audio/speech（本地调试）
 * gateway → 主站网关 /audio/speech（默认，密钥只在主站）
 *
 * fresh=true 时跳过缓存读写：保活/预热必须真的打到上游，否则永远命中缓存、
 * 模型实际没被温热（ttsStats.warmMs 会一直是 1ms）。
 */
export async function synthesize({ text, voice, speed = 1, hedge = false, fresh = false } = {}) {
  if (!ttsEnabled()) throw new Error('TTS 未启用')
  const input = clampText(normalizeForSpeech(text))
  if (!input) throw new Error('空文本')
  const v = normalizeVoice(voice)
  const sp = Math.min(1.3, Math.max(0.7, Number(speed) || 1))
  const key = sha1(`${TTS_MODE}|${TTS_MODEL}|${v}|${sp}|${input}`)
  if (!fresh) {
    const hit = cache.get(key)
    if (hit) {
      ttsStats.cacheHits++
      return hit
    }
  }

  const direct = TTS_MODE === 'direct'
  const base = direct ? TTS_BASE : GATEWAY_URL
  const token = direct ? TTS_KEY : TTS_TOKEN
  const body = direct
    ? { model: TTS_MODEL, voice: `${TTS_MODEL}:${v}`, input, response_format: 'mp3', speed: sp }
    : { voice: v, input, response_format: 'mp3', speed: sp }
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  }
  if (!direct) headers['x-zx-app-token'] = token

  const started = Date.now()
  try {
    // 上游抖动很大（同长度 1.3~8.1s，实测 2026-11-10 晚高峰）。
    // 首句/次句做「对冲」：同时发两路，谁先回用谁，另一路 abort。代价是多一次合成。
    const buf = hedge
      ? await hedgeSpeech(base, headers, body)
      : await requestSpeech(base, headers, body)
    cache.set(key, buf)
    ttsStats.calls++
    ttsStats.lastMs = Date.now() - started
    ttsStats.lastTextLen = input.length
    console.log(`[tts] len=${input.length} voice=${v} ms=${ttsStats.lastMs} bytes=${buf.length}${hedge ? ' hedge' : ''}`)
    return buf
  } catch (e) {
    ttsStats.fails++
    throw e
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function requestSpeech(base, headers, body) {
  const res = await fetch(`${base}/audio/speech`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`合成失败 ${res.status}：${t.slice(0, 200)}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('合成返回空音频')
  return buf
}

/** 两路并发（第二路晚 120ms），先成功者胜出，另一路立刻 abort。 */
async function hedgeSpeech(base, headers, body) {
  const acs = [new AbortController(), new AbortController()]
  const attempt = (i, delay) =>
    (async () => {
      if (delay) await sleep(delay)
      const res = await fetch(`${base}/audio/speech`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([acs[i].signal, AbortSignal.timeout(20_000)]),
      })
      if (!res.ok) throw new Error(`合成失败 ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) throw new Error('合成返回空音频')
      return buf
    })()
  try {
    const buf = await Promise.any([attempt(0, 0), attempt(1, 120)])
    ttsStats.hedgeWins++
    return buf
  } finally {
    for (const ac of acs) {
      try {
        ac.abort()
      } catch {}
    }
  }
}

/**
 * 保温：CosyVoice2 空闲后首包可达 13~14s（实测 2026-11-10），
 * 定时合成一小段把模型留在显存里，首句才不用等冷启动。
 */
export async function warmupTts() {
  if (!ttsEnabled()) return { ok: false, reason: 'disabled' }
  const t0 = Date.now()
  try {
    await synthesize({ text: '嗯，我在。', voice: TTS_VOICE, speed: 1, fresh: true })
    ttsStats.warmMs = Date.now() - t0
    ttsStats.warmAt = Date.now()
    return { ok: true, ms: ttsStats.warmMs }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
