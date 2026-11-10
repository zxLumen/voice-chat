import { TTS_BASE, TTS_KEY, TTS_MODE, TTS_MODEL, TTS_VOICE, VOICES } from './env.js'
import { LruCache, sha1 } from './util.js'

const cache = new LruCache({ maxItems: 120, maxBytes: 24 * 1024 * 1024 })
export const ttsEnabled = () => (TTS_MODE === 'direct' && Boolean(TTS_KEY)) || TTS_MODE === 'gateway'

export const voiceList = () => VOICES.filter((v) => v.id !== 'all')

/** 单句最长 300 字，超出直接拒绝（前端本来按句切）。 */
export function clampText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 300)
}

export function normalizeVoice(v) {
  const id = VOICES.some((x) => x.id === v) ? v : TTS_VOICE
  return id
}

/**
 * 合成语音，返回 mp3 Buffer。
 * direct  → 直连 OpenAI 兼容 /audio/speech（SiliconFlow CosyVoice2）
 * gateway → 主站网关 /audio/speech（待网关加该端点）
 */
export async function synthesize({ text, voice, speed = 1 }) {
  if (!ttsEnabled()) throw new Error('TTS 未启用')
  const input = clampText(text)
  if (!input) throw new Error('空文本')
  const v = normalizeVoice(voice)
  const sp = Math.min(1.3, Math.max(0.7, Number(speed) || 1))
  const key = sha1(`${TTS_MODE}|${TTS_MODEL}|${v}|${sp}|${input}`)
  const hit = cache.get(key)
  if (hit) return hit

  const direct = TTS_MODE === 'direct'
  const body = {
    model: TTS_MODEL,
    voice: direct ? `${TTS_MODEL}:${v}` : v,
    input,
    response_format: 'mp3',
    speed: sp,
  }
  const res = await fetch(`${TTS_BASE}${direct ? '' : ''}/audio/speech`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TTS_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`合成失败 ${res.status}：${t.slice(0, 200)}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('合成返回空音频')
  cache.set(key, buf)
  return buf
}
