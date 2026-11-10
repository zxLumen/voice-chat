/* 随口 · 前端（无框架、无构建）
 *
 * v0.2 三件事：
 *  1. 连续对话：麦克风常开、按人声自动切句上传，不再每轮点一次圆球。
 *  2. 出声即打断：AI 说话时检测到持续人声（≥300ms）→ 立即停播 + 中断回复 + 转入听。
 *  3. 句子流水线：LLM 边出字边切句，TTS 并发预取、按顺序无缝播放，首声更早、句间不卡。
 */
const $ = (id) => document.getElementById(id)

const HISTORY_KEY = 'suikou.history.v1'
const SETTINGS_KEY = 'suikou.settings.v1'
const MAX_HISTORY = 20

const DEFAULTS = {
  engine: 'server',
  voice: 'anna',
  speed: 1,
  autoSend: true,
  speakText: false,
  autoListen: true,
  bargeIn: true,
}

const S = {
  cfg: null,
  phase: 'boot',
  messages: [],
  settings: loadSettings(),
  call: false,
  turn: 0,
  mic: { stream: null, ac: null, analyser: null, data: null, raf: 0, noise: 0.012, candMs: 0 },
  seg: null,
  chatAbort: null,
  replySpoken: false,
  streamDone: false,
  tts: { session: 0, queue: [], endAt: 0, pumping: false, sources: [], cache: new Map(), ac: null, gain: null },
  asrBusy: false,
  asrQueue: [],
  empties: 0,
  wakeLock: null,
  tAskAt: 0,
  tFirstAudioAt: 0,
  lastActivity: 0,
  installPrompt: null,
}

const speech = { zhVoices: [] }

/* ---------------- storage ---------------- */

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }
  } catch {
    return { ...DEFAULTS }
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings))
  } catch {}
}
function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    return Array.isArray(arr)
      ? arr
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-MAX_HISTORY)
      : []
  } catch {
    return []
  }
}
function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(S.messages.slice(-MAX_HISTORY)))
  } catch {}
}

/* ---------------- ui ---------------- */

let toastTimer = 0
function toast(msg, ms = 2600) {
  const el = $('toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), ms)
}

const PHASE_TEXT = {
  connecting: '正在打开麦克风…',
  transcribing: '正在识别…',
  thinking: '想着呢…',
}

function setPhase(phase, statusText) {
  S.phase = phase
  document.body.dataset.phase = phase
  const el = $('status')
  if (typeof statusText === 'string' && statusText) el.textContent = statusText
  else if (phase === 'idle') el.textContent = S.messages.length ? '点一下，就可以接着聊' : '点一下，开始说话'
  else if (phase === 'listening') el.textContent = S.call ? '我在听，直接说就行' : '我在听…'
  else if (phase === 'speaking') el.textContent = '正在说…你直接开口就能打断'
  else if (PHASE_TEXT[phase]) el.textContent = PHASE_TEXT[phase]

  const orb = $('orb')
  if (phase === 'listening') orb.setAttribute('aria-label', '结束通话')
  else if (phase === 'speaking' || phase === 'thinking') orb.setAttribute('aria-label', '打断')
  else orb.setAttribute('aria-label', '开始说话')

  document.body.classList.toggle('call-on', S.call)
  if (phase !== 'listening' && phase !== 'speaking') setLevel(0)
}

function setLevel(rms) {
  $('orbWrap').style.setProperty('--lvl', String(Math.min(1, Math.max(0, rms * 7))))
}

function scrollChat() {
  const chat = $('chat')
  chat.scrollTop = chat.scrollHeight
}

function addMsg(role, content = '') {
  const el = document.createElement('div')
  el.className = `msg ${role}`
  el.textContent = content
  $('chat').appendChild(el)
  document.body.classList.add('has-chat')
  scrollChat()
  return el
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- audio out ---------------- */

function ensureAC() {
  if (!S.tts.ac) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) throw new Error('浏览器不支持音频播放')
    S.tts.ac = new AC()
    S.tts.gain = S.tts.ac.createGain()
    S.tts.gain.connect(S.tts.ac.destination)
  }
  if (S.tts.ac.state === 'suspended') S.tts.ac.resume().catch(() => {})
  return S.tts.ac
}

function unlockAudio() {
  try {
    const ac = ensureAC()
    const b = ac.createBuffer(1, 1, 22050)
    const src = ac.createBufferSource()
    src.buffer = b
    src.connect(ac.destination)
    src.start(0)
  } catch {}
}

function ttsEngine() {
  if (S.settings.engine === 'off') return 'off'
  if (S.settings.engine === 'server' && S.cfg?.tts?.enabled) return 'server'
  return 'browser'
}

function cleanForSpeech(t) {
  return String(t || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>~|]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/[（(]\s*[)）]/g, '')
    .trim()
}

/* ---------------- 句子切分（与 lib/text.js 同规则，前端只做切分） ---------------- */

const HARD_END = '。！？!?；;\n…'
const SOFT_END = '，,、：:'

function splitSpeech(input, final = false, firstMax = 12, max = 30) {
  const out = []
  let rest = String(input || '')
  for (;;) {
    const limit = out.length === 0 ? firstMax : max
    let cut = -1
    let soft = -1
    for (let i = 0; i < rest.length; i++) {
      if (HARD_END.includes(rest[i])) {
        cut = i
        break
      }
      if (SOFT_END.includes(rest[i]) && i >= 5) soft = i
      if (i >= limit) break
    }
    const preferSoft = soft >= 8 && (cut < 0 || cut - soft > 8)
    if (!preferSoft && cut >= 0 && cut <= limit) {
      out.push(rest.slice(0, cut + 1).trim())
      rest = rest.slice(cut + 1)
      continue
    }
    if (soft >= 0) {
      out.push(rest.slice(0, soft + 1).trim())
      rest = rest.slice(soft + 1)
      continue
    }
    if (cut >= 0) {
      out.push(rest.slice(0, cut + 1).trim())
      rest = rest.slice(cut + 1)
      continue
    }
    if (rest.length >= limit) {
      out.push(rest.slice(0, limit).trim())
      rest = rest.slice(limit)
      continue
    }
    break
  }
  if (final && rest.trim()) {
    out.push(rest.trim())
    rest = ''
  }
  return { out: out.filter(Boolean), rest }
}

/* ---------------- TTS 流水线 ---------------- */

function enqueueSpeech(raw) {
  if (!S.replySpoken) return
  if (ttsEngine() === 'off') return
  const text = cleanForSpeech(raw)
  if (!text) return
  S.tts.queue.push({ text, key: `${S.settings.voice}|${S.settings.speed}|${text}`, buf: null, p: null })
  dispatchTts()
  pumpSpeech()
}

function dispatchTts() {
  const session = S.tts.session
  let inFlight = 0
  for (const it of S.tts.queue) if (it.p && !it.buf) inFlight++
  let slots = 3 - inFlight
  for (const it of S.tts.queue) {
    if (slots <= 0) break
    if (it.p || it.buf) continue
    slots--
    it.p = fetchTts(it, session).catch((e) => {
      console.warn('[tts]', e)
      return null
    })
  }
}

async function fetchTts(item, session) {
  const hit = S.tts.cache.get(item.key)
  if (hit) return hit
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: item.text, voice: S.settings.voice, speed: S.settings.speed }),
  })
  if (!res.ok) throw new Error(`tts ${res.status}`)
  const ab = await res.arrayBuffer()
  if (session !== S.tts.session) return null
  const buf = await ensureAC().decodeAudioData(ab.slice(0))
  if (S.tts.cache.size > 60) S.tts.cache.delete(S.tts.cache.keys().next().value)
  S.tts.cache.set(item.key, buf)
  return buf
}

function scheduleBuffer(buf, session) {
  const ac = ensureAC()
  const t = Math.max(ac.currentTime + 0.04, S.tts.endAt || 0)
  if (S.tFirstAudioAt === 0) {
    S.tFirstAudioAt = performance.now()
    console.info('[tts] first sound at', Math.round(S.tFirstAudioAt - S.tAskAt), 'ms after ask')
  } else if (S.tts.endAt && t - S.tts.endAt > 0.12) {
    console.info('[tts] gap', Math.round((t - S.tts.endAt) * 1000), 'ms')
  }
  const src = ac.createBufferSource()
  src.buffer = buf
  src.connect(S.tts.gain || ac.destination)
  S.tts.sources.push(src)
  src.onended = () => {
    S.tts.sources = S.tts.sources.filter((x) => x !== src)
  }
  src.start(t)
  S.tts.endAt = t + buf.duration
  if (session === S.tts.session && S.phase !== 'speaking') setPhase('speaking', '')
}

/**
 * 按顺序播放：每句一到就排进 WebAudio 时间轴（不是 await 播放），
 * 所以句与句之间没有 JS 等待造成的静音；只有真的没赶上才会出现 gap（会打日志）。
 */
async function pumpSpeech() {
  if (S.tts.pumping) return
  S.tts.pumping = true
  const session = S.tts.session
  try {
    for (;;) {
      if (session !== S.tts.session) return
      if (S.tts.queue.length) {
        const item = S.tts.queue[0]
        if (ttsEngine() === 'browser') {
          S.tts.queue.shift()
          await speakBrowser(item.text, session)
          continue
        }
        const buf = item.buf || (await item.p)
        if (session !== S.tts.session) return
        if (!buf) {
          S.tts.queue.shift()
          continue
        }
        S.tts.queue.shift()
        scheduleBuffer(buf, session)
        dispatchTts()
        continue
      }
      if (S.streamDone) {
        const remain = (S.tts.endAt || 0) - ensureAC().currentTime
        if (remain <= 0) break
        await sleep(Math.min(150, remain * 1000 + 20))
        continue
      }
      await sleep(60)
    }
  } finally {
    S.tts.pumping = false
  }
  if (session === S.tts.session) onSpeechEnd()
}

function stopSpeaking({ silent = false } = {}) {
  S.tts.session++
  S.tts.queue = []
  S.tts.endAt = 0
  for (const src of S.tts.sources) {
    try {
      src.stop()
    } catch {}
  }
  S.tts.sources = []
  try {
    window.speechSynthesis?.cancel()
  } catch {}
  if (!silent && S.phase === 'speaking') setPhase(S.call ? 'listening' : 'idle')
}

function onSpeechEnd() {
  if (!S.call) {
    setPhase('idle')
    return
  }
  if (!S.settings.autoListen) {
    endCall('说完了，点一下继续')
    return
  }
  if (document.visibilityState !== 'visible') {
    setPhase('idle', '页面在后台，点一下继续')
    return
  }
  setPhase('listening', '我在听，直接说就行')
}

/* ---------------- 浏览器系统语音（兜底） ---------------- */

function speakBrowser(text, session) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis
    if (!synth) return resolve()
    const u = new SpeechSynthesisUtterance(text)
    if (!speech.zhVoices.length) loadZhVoices()
    if (speech.zhVoices[0]) u.voice = speech.zhVoices[0]
    u.lang = 'zh-CN'
    u.rate = Math.min(1.3, Math.max(0.7, Number(S.settings.speed) || 1))
    u.pitch = 1.02
    u.onend = () => resolve()
    u.onerror = () => resolve()
    if (session === S.tts.session) setPhase('speaking', '')
    try {
      synth.speak(u)
    } catch {
      resolve()
    }
  })
}

function loadZhVoices() {
  try {
    speech.zhVoices = (window.speechSynthesis?.getVoices() || []).filter((v) => /^zh|chinese|中文/i.test(`${v.lang} ${v.name}`))
  } catch {
    speech.zhVoices = []
  }
}

/* ---------------- 麦克风 + 常开分段录音 ---------------- */

async function ensureMic() {
  const live = S.mic.stream && S.mic.stream.getAudioTracks().some((t) => t.readyState === 'live')
  if (live) return S.mic.stream
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('这个浏览器不支持麦克风')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  })
  S.mic.stream = stream
  const AC = window.AudioContext || window.webkitAudioContext
  const ac = new AC()
  const src = ac.createMediaStreamSource(stream)
  const analyser = ac.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.6
  src.connect(analyser)
  S.mic.ac = ac
  S.mic.analyser = analyser
  S.mic.data = new Uint8Array(analyser.fftSize)
  if (ac.state === 'suspended') ac.resume().catch(() => {})
  return stream
}

function releaseMic() {
  try {
    S.mic.stream?.getTracks().forEach((t) => t.stop())
  } catch {}
  S.mic.stream = null
  S.mic.analyser = null
  S.mic.data = null
  try {
    S.mic.ac?.close()
  } catch {}
  S.mic.ac = null
}

function pickMime() {
  if (!window.MediaRecorder) return ''
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac']
  return cands.find((t) => MediaRecorder.isTypeSupported(t)) || ''
}

function createSegment(voiced, now = performance.now()) {
  if (!S.mic.stream) return null
  const mime = pickMime()
  let rec
  try {
    rec = mime ? new MediaRecorder(S.mic.stream, { mimeType: mime, audioBitsPerSecond: 32000 }) : new MediaRecorder(S.mic.stream)
  } catch {
    try {
      rec = new MediaRecorder(S.mic.stream)
    } catch {
      return null
    }
  }
  const seg = { rec, chunks: [], mime: rec.mimeType || mime || 'audio/webm', voiced, startedAt: now, lastVoiceAt: now, voiceMs: 0, bytes: 0, discard: false }
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) {
      seg.chunks.push(e.data)
      seg.bytes += e.data.size
    }
  }
  rec.onstop = () => onSegmentStop(seg)
  try {
    rec.start(200)
  } catch {
    return null
  }
  return seg
}

function stopRec(seg) {
  try {
    if (seg.rec.state !== 'inactive') seg.rec.stop()
  } catch {}
}

function onSegmentStop(seg) {
  const blob = new Blob(seg.chunks, { type: seg.mime })
  seg.chunks = []
  if (seg.discard || !seg.voiced || blob.size < 1200) return
  S.asrQueue.push(blob)
  pumpAsr()
}

function rotateStandby() {
  if (S.seg && !S.seg.voiced) {
    S.seg.discard = true
    stopRec(S.seg)
    S.seg = S.call ? createSegment(false) : null
  }
}

/* ---------------- VAD ---------------- */

function startVad() {
  if (S.mic.raf) return
  if (!S.mic.analyser) return
  const data = S.mic.data || new Uint8Array(S.mic.analyser.fftSize)
  let last = performance.now()

  const tick = () => {
    S.mic.raf = 0
    if (!S.call || !S.mic.analyser) return
    const now = performance.now()
    const dt = Math.min(100, Math.max(1, now - last))
    last = now

    S.mic.analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)

    const speaking = S.phase === 'speaking' || S.phase === 'thinking'
    // 说话时扬声器回授会被 AEC 压一部分，剩下的靠抬高门限 + 更长的确认时间挡住
    const floor = Math.max(0.005, Math.min(0.06, S.mic.noise))
    const thr = speaking ? Math.max(0.03, floor * 2.6) : Math.max(0.018, floor * 2.4)
    const above = rms > thr

    if (above) S.mic.candMs += dt
    else S.mic.candMs = Math.max(0, S.mic.candMs - dt * 1.6)

    if (!S.seg?.voiced) {
      if (S.mic.candMs >= 64) beginUtterance(now)
    } else {
      if (above) {
        S.seg.lastVoiceAt = now
        S.seg.voiceMs += dt
      }
      if (S.settings.bargeIn && speaking && S.seg.voiceMs >= 300) {
        bargeIn()
      } else if (S.seg.voiceMs > 80 && now - S.seg.lastVoiceAt > 650) {
        endUtterance(now)
      }
    }

    setLevel(S.seg?.voiced || above ? rms : 0)
    if (!above) S.mic.noise = S.mic.noise * 0.9 + rms * 0.1
    if (S.seg && !S.seg.voiced && now - S.seg.startedAt > 45_000) rotateStandby()
    if (now - S.lastActivity > 300_000) {
      endCall('5 分钟没说话，麦克风先关了')
      return
    }
    S.mic.raf = requestAnimationFrame(tick)
  }
  S.mic.raf = requestAnimationFrame(tick)
}

function beginUtterance(now) {
  S.lastActivity = now
  if (S.seg) {
    S.seg.discard = true
    stopRec(S.seg)
  }
  S.seg = createSegment(true, now)
  S.mic.candMs = 0
  if (!S.seg) {
    toast('录音启动失败，刷新页面再试')
    endCall('麦克风出问题了')
    return
  }
  if (S.phase === 'idle') setPhase('listening', '我在听…')
}

function endUtterance(now) {
  const seg = S.seg
  if (!seg) return
  S.seg = null
  S.lastActivity = now
  stopRec(seg)
  if (S.call) S.seg = createSegment(false, now)
  setPhase('transcribing', '正在识别…')
}

function bargeIn() {
  if (S.phase !== 'speaking' && S.phase !== 'thinking') return
  console.info('[barge-in] 用户开口，停止播报')
  if (S.chatAbort) S.chatAbort.abort()
  stopSpeaking({ silent: true })
  setPhase('listening', '嗯，你说')
  toast('已停下，我在听', 1400)
}

/* ---------------- 通话 ---------------- */

async function startCall() {
  if (S.call) return
  if (!S.cfg?.asr?.enabled) return toast('语音识别还没配置好，先用打字吧')
  if (!window.isSecureContext) return toast('需要 https 才能用麦克风')
  if (!window.MediaRecorder) return toast('这个浏览器不支持录音，先用打字吧')

  stopSpeaking({ silent: true })
  unlockAudio()
  setPhase('connecting', '正在打开麦克风…')
  try {
    await ensureMic()
  } catch (e) {
    console.warn('[mic]', e)
    setPhase('idle', '麦克风没打开')
    toast('需要麦克风权限，请在浏览器设置里允许后刷新')
    return
  }
  S.call = true
  S.empties = 0
  S.lastActivity = performance.now()
  acquireWakeLock()
  S.seg = createSegment(false)
  startVad()
  setPhase('listening', '我在听，直接说就行')
}

function endCall(reason) {
  const wasCall = S.call
  S.call = false
  if (S.mic.raf) cancelAnimationFrame(S.mic.raf)
  S.mic.raf = 0
  if (S.seg) {
    S.seg.discard = true
    stopRec(S.seg)
    S.seg = null
  }
  releaseWakeLock()
  stopSpeaking({ silent: true })
  if (S.chatAbort) S.chatAbort.abort()
  releaseMic()
  setLevel(0)
  if (wasCall) setPhase('idle', reason || '点一下，继续聊')
}

/* ---------------- ASR ---------------- */

/** 最近 6 条消息 → base64url，塞进请求头当纠错上下文（不带音频，不额外请求）。 */
function encodeCtx(messages) {
  try {
    const rows = (messages || []).slice(-6).map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 160) }))
    const bytes = new TextEncoder().encode(JSON.stringify(rows))
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  } catch {
    return ''
  }
}

async function pumpAsr() {
  if (S.asrBusy) return
  const blob = S.asrQueue.shift()
  if (!blob) return
  S.asrBusy = true
  const started = performance.now()
  try {
    const res = await fetch('/api/asr', {
      method: 'POST',
      headers: {
        'content-type': blob.type || 'audio/webm',
        // 最近几轮对话（base64url）给服务端做上下文纠错：专名/同音字靠它判断
        'x-suikou-ctx': encodeCtx(S.messages),
      },
      body: blob,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `识别失败 ${res.status}`)
    const text = String(data.text || '').trim()
    if (!text) {
      S.empties++
      setPhase(S.call ? 'listening' : 'idle', '没听清，再说一次')
      if (S.empties >= 3) endCall('没听到声音，点一下继续')
      return
    }
    S.empties = 0
    console.info(
      '[asr]',
      Math.round(performance.now() - started),
      'ms',
      `asr=${data.asrMs ?? '?'}ms polish=${data.polishMs ?? '?'}ms`,
      text,
      data.raw && data.raw !== text ? `(原文: ${data.raw})` : '',
    )
    addMsg('user', text)
    await ask(text, true)
  } catch (e) {
    console.warn('[asr]', e)
    setPhase(S.call ? 'listening' : 'idle', '识别失败，再试一次')
    toast(e instanceof Error ? e.message : '识别失败')
  } finally {
    S.asrBusy = false
    if (S.asrQueue.length) pumpAsr()
  }
}

/* ---------------- 对话 ---------------- */

async function ask(text, spoken) {
  stopSpeaking({ silent: true })
  S.turn++
  S.tAskAt = performance.now()
  S.tFirstAudioAt = 0
  S.streamDone = false
  S.replySpoken = spoken && ttsEngine() !== 'off'
  S.messages.push({ role: 'user', content: text })
  saveHistory()

  const bubble = addMsg('bot', '')
  const controller = new AbortController()
  S.chatAbort = controller
  setPhase('thinking', '想着呢…')

  let full = ''
  let buf = ''
  let gotToken = false
  const t0 = performance.now()

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: S.messages.map((m) => ({ role: m.role, content: m.content })) }),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new Error(`对话失败 ${res.status}`)

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let sse = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      sse += dec.decode(value, { stream: true })
      let idx
      while ((idx = sse.indexOf('\n\n')) >= 0) {
        const block = sse.slice(0, idx)
        sse = sse.slice(idx + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw) continue
          let j
          try {
            j = JSON.parse(raw)
          } catch {
            continue
          }
          if (j.error) throw new Error(j.error)
          if (typeof j.t === 'string' && j.t) {
            if (!gotToken) {
              gotToken = true
              console.info('[llm] first token', Math.round(performance.now() - t0), 'ms')
            }
            full += j.t
            buf += j.t
            bubble.textContent = full
            scrollChat()
            // 首句（第一个逗号/句号）一到就先派给 TTS，不等整段生成完
            const { out, rest } = splitSpeech(buf, false)
            buf = rest
            out.forEach(enqueueSpeech)
          }
          if (j.done && !full) throw new Error('模型没有返回内容')
        }
      }
    }

    full = full.trim()
    const tail = splitSpeech(buf, true)
    tail.out.forEach(enqueueSpeech)
    bubble.textContent = full || '（这次没说出话，再问一次？）'
    if (full) S.messages.push({ role: 'assistant', content: full })
    saveHistory()
    S.streamDone = true
    if (!S.replySpoken) onSpeechEnd()
  } catch (e) {
    if (controller.signal.aborted) {
      // 被用户打断：保留已经说出来的半句，别让它从上下文里消失
      if (full.trim()) {
        S.messages.push({ role: 'assistant', content: full.trim() })
        saveHistory()
      }
      return
    }
    console.warn('[chat]', e)
    bubble.classList.add('err')
    bubble.textContent = full ? `${full}\n（网络断了，回复不完整）` : '这会儿连不上，稍后再试一次。'
    S.streamDone = true
    if (!S.replySpoken) onSpeechEnd()
    else if (!S.tts.queue.length && !S.tts.pumping) onSpeechEnd()
    if (gotToken && full) S.messages.push({ role: 'assistant', content: full })
    saveHistory()
  } finally {
    if (S.chatAbort === controller) S.chatAbort = null
  }
}

/* ---------------- wake lock ---------------- */

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) S.wakeLock = await navigator.wakeLock.request('screen')
  } catch {}
}
function releaseWakeLock() {
  try {
    S.wakeLock?.release?.()
  } catch {}
  S.wakeLock = null
}

/* ---------------- 设置面板 ---------------- */

function openSheet() {
  syncSheet()
  $('sheet').hidden = false
  $('sheetMask').hidden = false
}
function closeSheet() {
  $('sheet').hidden = true
  $('sheetMask').hidden = true
}

function syncSheet() {
  const engine = $('selEngine')
  engine.value = S.settings.engine
  if (!S.cfg?.tts?.enabled && engine.value === 'server') engine.value = 'browser'
  $('rowVoice').hidden = engine.value === 'off'
  $('rowSpeed').hidden = engine.value === 'off'
  $('rngSpeed').value = S.settings.speed
  $('speedVal').textContent = `${Number(S.settings.speed).toFixed(2).replace(/0$/, '')}×`
  $('chkAuto').checked = S.settings.autoSend
  $('chkSpeakText').checked = S.settings.speakText
  $('chkAutoListen').checked = S.settings.autoListen
  $('chkBarge').checked = S.settings.bargeIn
  $('engineNote').textContent = S.cfg?.tts?.enabled ? '' : '· 当前没接服务端语音，会用手机自带的系统语音朗读。'
}

function fillVoices() {
  const sel = $('selVoice')
  sel.innerHTML = ''
  const list = S.cfg?.tts?.voices || [{ id: 'anna', label: '安雅' }]
  for (const v of list) {
    const o = document.createElement('option')
    o.value = v.id
    o.textContent = v.label
    sel.appendChild(o)
  }
  sel.value = list.some((v) => v.id === S.settings.voice) ? S.settings.voice : list[0].id
}

function bindSettings() {
  $('btnSettings').addEventListener('click', openSheet)
  $('btnCloseSheet').addEventListener('click', closeSheet)
  $('sheetMask').addEventListener('click', closeSheet)

  $('selEngine').addEventListener('change', (e) => {
    let v = e.target.value
    if (v === 'server' && !S.cfg?.tts?.enabled) {
      toast('服务端语音还没配置，先用系统语音')
      v = 'browser'
    }
    S.settings.engine = v
    saveSettings()
    syncSheet()
  })
  $('selVoice').addEventListener('change', (e) => {
    S.settings.voice = e.target.value
    saveSettings()
  })
  $('rngSpeed').addEventListener('input', (e) => {
    S.settings.speed = Number(e.target.value)
    $('speedVal').textContent = `${S.settings.speed.toFixed(2).replace(/0$/, '')}×`
    saveSettings()
  })
  $('chkAuto').addEventListener('change', (e) => {
    S.settings.autoSend = e.target.checked
    saveSettings()
  })
  $('chkSpeakText').addEventListener('change', (e) => {
    S.settings.speakText = e.target.checked
    saveSettings()
  })
  $('chkAutoListen').addEventListener('change', (e) => {
    S.settings.autoListen = e.target.checked
    saveSettings()
  })
  $('chkBarge').addEventListener('change', (e) => {
    S.settings.bargeIn = e.target.checked
    saveSettings()
  })
  $('btnClear').addEventListener('click', () => {
    newConversation()
    closeSheet()
    toast('已清空')
  })
}

function newConversation() {
  if (S.chatAbort) S.chatAbort.abort()
  stopSpeaking({ silent: true })
  S.messages = []
  S.tts.cache.clear()
  saveHistory()
  $('chat').innerHTML = ''
  document.body.classList.remove('has-chat')
  setPhase(S.call ? 'listening' : 'idle')
}

/* ---------------- 初始化 ---------------- */

function autosize(el) {
  el.style.height = 'auto'
  el.style.height = `${Math.min(120, el.scrollHeight)}px`
}

function restoreHistory() {
  const hist = loadHistory()
  if (!hist.length) return
  S.messages = hist
  for (const m of hist) {
    const el = document.createElement('div')
    el.className = `msg ${m.role === 'user' ? 'user' : 'bot'}`
    el.textContent = m.content
    $('chat').appendChild(el)
  }
  document.body.classList.add('has-chat')
  setTimeout(scrollChat, 30)
}

/* ---------------- 装成 App（PWA / 主屏幕） ---------------- */

const TIP_KEY = 'suikou.installTip.v1'

function isStandalone() {
  return window.navigator.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches
}

function registerSw() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

function maybeInstallTip() {
  const tip = $('installTip')
  if (!tip || isStandalone()) return
  const ua = navigator.userAgent
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const safari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
  let dismissed = false
  try {
    dismissed = localStorage.getItem(TIP_KEY) === 'off'
  } catch {}
  if (!ios || !safari || dismissed) return
  tip.hidden = false
  $('btnTipClose').addEventListener('click', () => {
    tip.hidden = true
    try {
      localStorage.setItem(TIP_KEY, 'off')
    } catch {}
  })
}

async function boot() {
  bindSettings()

  $('orb').addEventListener('click', () => {
    unlockAudio()
    if (S.phase === 'listening') return endCall()
    if (S.phase === 'transcribing') return
    if (S.phase === 'speaking' || S.phase === 'thinking') {
      if (S.chatAbort) S.chatAbort.abort()
      stopSpeaking({ silent: true })
      if (!S.call) startCall()
      else setPhase('listening', '我在听，直接说就行')
      return
    }
    startCall()
  })

  $('btnNew').addEventListener('click', newConversation)

  const input = $('textInput')
  input.addEventListener('input', () => autosize(input))
  $('textForm').addEventListener('submit', (e) => {
    e.preventDefault()
    unlockAudio()
    const v = input.value.trim()
    if (!v) return
    if (S.phase === 'thinking') return toast('等我先说这句')
    input.value = ''
    autosize(input)
    addMsg('user', v)
    ask(v, S.call || S.settings.speakText)
  })

  for (const chip of document.querySelectorAll('#chips button')) {
    chip.addEventListener('click', () => {
      unlockAudio()
      addMsg('user', chip.textContent)
      ask(chip.textContent, S.call || S.settings.speakText)
    })
  }

  document.addEventListener('pointerdown', unlockAudio, { once: true })
  try {
    window.speechSynthesis?.addEventListener?.('voiceschanged', loadZhVoices)
  } catch {}
  loadZhVoices()
  restoreHistory()

  try {
    S.cfg = await fetch('/api/config', { cache: 'no-store' }).then((r) => r.json())
  } catch {
    S.cfg = null
  }
  fillVoices()
  syncSheet()

  if (!S.cfg?.asr?.enabled) $('hint').textContent = '语音识别暂不可用 · 先用打字'
  else if (!window.isSecureContext) $('hint').textContent = '需要 https 才能录音 · 先用打字'

  setPhase('idle')
  registerSw()
  maybeInstallTip()

  // 页面回到前台时，如果还在通话，恢复 VAD（后台 rAF 会被浏览器停掉）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (S.call && !S.mic.raf) startVad()
    if (S.call) acquireWakeLock()
  })
}

boot()
