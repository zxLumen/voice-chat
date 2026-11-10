import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import {
  ASR_TOKEN,
  ASR_MODEL,
  ASR_DIRECT_BASE,
  ASR_DIRECT_KEY,
  GATEWAY_URL,
  REQUEST_TIMEOUT_MS,
} from './env.js'

const run = promisify(execFile)

/** SenseVoice 等模型会在结果里带 <|zh|><|NEUTRAL|> 之类的标签，去掉。 */
export function cleanTranscript(raw) {
  return String(raw || '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export const asrReady = () => Boolean(ASR_DIRECT_BASE ? ASR_DIRECT_KEY : ASR_TOKEN)

/**
 * 任意浏览器录音（webm/opus、mp4/aac…）→ 16k 单声道 mp3 → 网关/直连转写。
 * @returns {{text:string, seconds:number, ms:number}}
 */
export async function transcribe(buf, { contentType = 'audio/webm', language = 'zh' } = {}) {
  const started = Date.now()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suikou-'))
  const ext = /mp4|aac|m4a/.test(contentType) ? 'm4a' : /wav/.test(contentType) ? 'wav' : 'webm'
  const src = path.join(dir, `in.${ext}`)
  const dst = path.join(dir, 'out.mp3')
  try {
    await fs.writeFile(src, buf)
    await run(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', dst],
      { timeout: 20_000 },
    )
    const ffmpegMs = Date.now() - started
    const mp3 = await fs.readFile(dst)

    const form = new FormData()
    form.set('file', new Blob([mp3], { type: 'audio/mpeg' }), 'voice.mp3')
    form.set('language', language)
    if (ASR_MODEL) form.set('model', ASR_MODEL)

    const base = ASR_DIRECT_BASE || GATEWAY_URL
    const token = ASR_DIRECT_BASE ? ASR_DIRECT_KEY : ASR_TOKEN
    const headers = { authorization: `Bearer ${token}` }
    if (!ASR_DIRECT_BASE) headers['x-zx-app-token'] = token

    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, 45_000)),
    })
    const bodyText = await res.text()
    if (!res.ok) throw new Error(`转写失败 ${res.status}：${bodyText.slice(0, 200)}`)
    const data = JSON.parse(bodyText)
    const total = Date.now() - started
    console.log(`[asr] in=${buf.length}B mp3=${mp3.length}B ffmpeg=${ffmpegMs}ms upstream=${total - ffmpegMs}ms total=${total}ms`)
    return {
      text: cleanTranscript(data.text),
      seconds: Number(data.seconds || data.usage?.seconds || 0),
      ms: total,
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 伪造一段 0.4s 静音，用于服务启动时预热转写模型（SenseVoice 冷启动可达 15s）。 */
export async function warmupAsr() {
  if (!asrReady()) return { ok: false, reason: 'no token' }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suikou-warm-'))
  const out = path.join(dir, 'silence.mp3')
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.4', '-c:a', 'libmp3lame', out], { timeout: 15_000 })
    const buf = await fs.readFile(out)
    const t0 = Date.now()
    const r = await transcribe(buf, { contentType: 'audio/mpeg' })
    return { ok: true, ms: Date.now() - t0, text: r.text }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export const tempName = () => crypto.randomBytes(6).toString('hex')
