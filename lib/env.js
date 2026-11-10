import fs from 'node:fs'
import path from 'node:path'

/** 读取项目根 .env（不覆盖已有环境变量）。 */
function loadDotEnv() {
  const file = path.join(process.cwd(), '.env')
  if (!fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(raw)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}
loadDotEnv()

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

export const PORT = num(process.env.PORT, 8795)
export const VERSION = '0.1.0'

/** AI 网关（对话 + 转写）：容器内 http://app:3000/api/ai/v1 */
export const GATEWAY_URL = (process.env.ZX_AI_GATEWAY_URL || 'https://zxlumen.cn/api/ai/v1').replace(/\/+$/, '')
/** 对话令牌（zxai_…） */
export const AI_TOKEN = process.env.VOICE_AI_TOKEN || process.env.ZX_AI_APP_TOKEN || ''
/** 转写令牌；缺省复用 AI_TOKEN */
export const ASR_TOKEN = process.env.VOICE_ASR_TOKEN || AI_TOKEN
export const ASR_MODEL = process.env.VOICE_ASR_MODEL || 'XingChenAGI/XingChenASR-V3.2'

/** ASR 直连模式（仅本地/容器缺网关音频密钥时用）：openai 兼容的 /audio/transcriptions */
export const ASR_DIRECT_BASE = (process.env.VOICE_ASR_BASE_URL || '').replace(/\/+$/, '')
export const ASR_DIRECT_KEY = process.env.VOICE_ASR_KEY || ''

/** TTS：gateway（/audio/speech，待网关支持）/ direct（OpenAI 兼容 /audio/speech）/ off */
export const TTS_MODE = (process.env.VOICE_TTS_MODE || 'off').toLowerCase()
export const TTS_BASE = (process.env.VOICE_TTS_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
export const TTS_KEY = process.env.VOICE_TTS_KEY || ''
export const TTS_MODEL = process.env.VOICE_TTS_MODEL || 'FunAudioLLM/CosyVoice2-0.5B'
export const TTS_VOICE = process.env.VOICE_TTS_VOICE || 'anna'

export const MODEL = process.env.VOICE_MODEL || 'deepseek-v4.1-flash'
export const MAX_ASR_SECONDS = num(process.env.VOICE_MAX_ASR_SECONDS, 60)
export const MAX_ASR_BYTES = num(process.env.VOICE_MAX_ASR_BYTES, 12 * 1024 * 1024)
export const REQUEST_TIMEOUT_MS = num(process.env.VOICE_UPSTREAM_TIMEOUT_MS, 60_000)
/** TTS 每日字数上限（按北京日，进程内计数；重启归零），防被人刷爆语音额度 */
export const TTS_DAILY_CHARS = num(process.env.VOICE_TTS_DAILY_CHARS, 80_000)

export const VOICES = [
  { id: 'anna', label: '安雅 · 温柔女声' },
  { id: 'bella', label: '贝拉 · 活泼女声' },
  { id: 'claire', label: '克莱尔 · 知性女声' },
  { id: 'benjamin', label: '本杰明 · 沉稳男声' },
]
