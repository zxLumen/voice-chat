/* 随口 · 前端（无框架、无构建） */
const $ = (id) => document.getElementById(id)

const HISTORY_KEY = 'suikou.history.v1'
const SETTINGS_KEY = 'suikou.settings.v1'
const MAX_HISTORY = 20

const DEFAULTS = { engine: 'server', voice: 'anna', speed: 1, autoSend: true, speakText: false, autoListen: false }

const S = {
  cfg: null,
  phase: 'boot',
  messages: [],
  settings: loadSettings(),
  stream: null,
  micAC: null,
  analyser: null,
  rec: null,
  chunks: [],
  mime: '',
  pendingUpload: false,
  vad: { raf: 0, start: 0, speech: 0, silence: 0, voiced: false, noiseSum: 0, noiseN: 0 },
  chatAbort: null,
  replySpoken: false,
  ttsSession: 0,
  ttsQueue: [],
  pumping: false,
  ac: null,
  sources: [],
  wakeLock: null,
}

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
    return Array.isArray(arr) ? arr.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-MAX_HISTORY) : []
  } catch {
    return []
  }
}
function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(S.messages.slice(-MAX_HISTORY)))
  } catch {}
}

/* ---------------- ui helpers ---------------- */

let toastTimer = 0
function toast(msg, ms = 2600) {
  const el = $('toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), ms)
}

function setPhase(phase, statusText) {
  S.phase = phase
  document.body.dataset.phase = phase
  if (typeof statusText === 'string' && statusText) {
    $('status').textContent = statusText
  } else if (phase === 'idle') {
    $('status').textContent = S.messages.length ? '接着说，或者直接打字' : '点一下，开始说话'
  } else if (phase === 'speaking') {
    $('status').textContent = '正在说…点一下可以打断'
  }
  if (phase === 'idle') $('orb').setAttribute('aria-label', '开始说话')
  else if (phase === 'listening') $('orb').setAttribute('aria-label', '停止录音')
  else $('orb').setAttribute('aria-label', '停止')
  if (phase !== 'listening') setLevel(0)
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

/* ---------------- audio unlock ---------------- */

function ensureAC() {
  if (!S.ac) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) throw new Error('浏览器不支持音频播放')
    S.ac = new AC()
  }
  if (S.ac.state === 'suspended') S.ac.resume().catch(() => {})
  return S.ac
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

/* ---------------- speech output ---------------- */

function ttsEngine() {
  if (S.settings.engine === 'off') return 'off'
  if (S.settings.engine === 'server' && S.cfg?.tts?.enabled) return 'server'
  return 'browser'
}

function enqueueSpeech(raw) {
  if (!S.replySpoken) return
  const engine = ttsEngine()
  if (engine === 'off') return
  const text = cleanForSpeech(raw)
  if (!text) return
  S.ttsQueue.push({ text })
  pumpSpeech()
}

function cleanForSpeech(t) {
  return String(t || '')
    .replace(/[*_`#>~|]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[（(]\s*[)）]/g, '')
    .trim()
}

async function fetchTts(text) {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice: S.settings.voice, speed: S.settings.speed }),
  })
  if (!res.ok) throw new Error(`tts ${res.status}`)
  return res.arrayBuffer()
}

async function pumpSpeech() {
  if (S.pumping) return
  S.pumping = true
  const session = S.ttsSession
  try {
    while (S.ttsQueue.length && session === S.ttsSession) {
      const item = S.ttsQueue.shift()
      try {
        if (ttsEngine() === 'server') {
          // 只对当前句发起请求：先出声，再预取下一句（并发抢带宽会把第一句拖慢）
          const ab = await (item.p || fetchTts(item.text))
          if (session !== S.ttsSession) break
          const next = S.ttsQueue[0]
          if (next && !next.p) next.p = fetchTts(next.text).catch(() => null)
          if (ab) await playBuffer(ab, session)
        } else {
          await speakBrowser(item.text, session)
        }
      } catch (e) {
        console.warn('[tts]', e)
        if (session === S.ttsSession) await speakBrowser(item.text, session).catch(() => {})
      }
    }
  } finally {
    S.pumping = false
    if (session === S.ttsSession && !S.ttsQueue.length && S.phase === 'speaking') {
      setPhase('idle')
      maybeAutoListen()
    }
  }
}

async function playBuffer(ab, session) {
  const ac = ensureAC()
  const buf = await ac.decodeAudioData(ab.slice(0))
  if (session !== S.ttsSession) return
  if (!S.tFirstAudioAt) {
    S.tFirstAudioAt = performance.now()
    console.info('[tts] first audio at', Math.round(S.tFirstAudioAt - (S.tAskAt || S.tFirstAudioAt)), 'ms after ask')
  }
  const src = ac.createBufferSource()
  src.buffer = buf
  src.connect(ac.destination)
  S.sources.push(src)
  setPhase('speaking', '')
  await new Promise((resolve) => {
    src.onended = () => resolve()
    try {
      src.start()
    } catch {
      resolve()
    }
  })
  S.sources = S.sources.filter((x) => x !== src)
}

let zhVoices = []
function loadZhVoices() {
  try {
    zhVoices = (window.speechSynthesis?.getVoices() || []).filter((v) => /^zh|chinese|中文/i.test(`${v.lang} ${v.name}`))
  } catch {
    zhVoices = []
  }
}

function speakBrowser(text, session) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis
    if (!synth) return resolve()
    const u = new SpeechSynthesisUtterance(text)
    if (!zhVoices.length) loadZhVoices()
    if (zhVoices[0]) u.voice = zhVoices[0]
    u.lang = 'zh-CN'
    u.rate = Math.min(1.3, Math.max(0.7, Number(S.settings.speed) || 1))
    u.pitch = 1.02
    u.onend = () => resolve()
    u.onerror = () => resolve()
    if (session === S.ttsSession) setPhase('speaking', '')
    try {
      synth.speak(u)
    } catch {
      resolve()
    }
  })
}

function stopSpeaking() {
  S.ttsSession++
  S.ttsQueue = []
  for (const src of S.sources) {
    try {
      src.stop()
    } catch {}
  }
  S.sources = []
  try {
    window.speechSynthesis?.cancel()
  } catch {}
  if (S.phase === 'speaking') setPhase('idle', '')
}

/* ---------------- mic + recording ---------------- */

async function ensureMic() {
  if (S.stream && S.stream.getAudioTracks().some((t) => t.readyState === 'live')) return S.stream
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('这个浏览器不支持麦克风')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  })
  S.stream = stream
  const AC = window.AudioContext || window.webkitAudioContext
  const ac = new AC()
  const src = ac.createMediaStreamSource(stream)
  const analyser = ac.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.65
  src.connect(analyser)
  S.micAC = ac
  S.analyser = analyser
  return stream
}

function pickMime() {
  if (!window.MediaRecorder) return ''
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac']
  return cands.find((t) => MediaRecorder.isTypeSupported(t)) || ''
}

async function startListening() {
  if (S.phase === 'listening' || S.phase === 'transcribing' || S.phase === 'connecting') return
  if (!S.cfg?.asr?.enabled) return toast('语音识别还没配置好，先用打字吧')
  if (!window.isSecureContext) return toast('需要 https 才能用麦克风')
  if (!window.MediaRecorder) return toast('这个浏览器不支持录音，先用打字吧')

  stopSpeaking()
  if (S.chatAbort) S.chatAbort.abort()
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

  S.chunks = []
  S.pendingUpload = true
  const mime = pickMime()
  try {
    S.rec = mime ? new MediaRecorder(S.stream, { mimeType: mime, audioBitsPerSecond: 32000 }) : new MediaRecorder(S.stream)
  } catch {
    try {
      S.rec = new MediaRecorder(S.stream)
    } catch {
      setPhase('idle', '录音启动失败')
      return
    }
  }
  S.mime = S.rec.mimeType || mime || 'audio/webm'
  S.rec.ondataavailable = (e) => {
    if (e.data && e.data.size) S.chunks.push(e.data)
  }
  S.rec.onstop = () => {
    const blob = new Blob(S.chunks, { type: S.mime })
    S.chunks = []
    if (!S.pendingUpload) return
    if (blob.size < 900) {
      setPhase('idle', '没听到声音，再说一次')
      return
    }
    uploadAudio(blob)
  }
  S.rec.start(200)

  S.vad = { raf: 0, start: performance.now(), speech: 0, silence: 0, voiced: false, noiseSum: 0, noiseN: 0 }
  setPhase('listening', '我在听…')
  acquireWakeLock()
  runVad()
}

function runVad() {
  const analyser = S.analyser
  const data = new Uint8Array(analyser.fftSize)
  let last = performance.now()

  const tick = () => {
    if (S.phase !== 'listening') return
    const now = performance.now()
    const dt = Math.min(120, now - last)
    last = now

    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    setLevel(rms)

    const elapsed = now - S.vad.start
    if (elapsed < 420) {
      S.vad.noiseSum += rms
      S.vad.noiseN += 1
    }
    const noise = S.vad.noiseN ? S.vad.noiseSum / S.vad.noiseN : 0.01
    const threshold = Math.max(0.022, Math.min(0.13, noise * 2.3))

    if (rms > threshold) {
      S.vad.speech += dt
      S.vad.silence = 0
      S.vad.voiced = true
    } else if (S.vad.voiced) {
      S.vad.silence += dt
    }

    if (S.settings.autoSend && S.vad.voiced && S.vad.speech > 300 && S.vad.silence > 700) {
      return endListening('auto')
    }
    const maxMs = (S.cfg?.asr?.maxSeconds || 60) * 1000
    if (elapsed > maxMs) return endListening('max')
    S.vad.raf = requestAnimationFrame(tick)
  }
  S.vad.raf = requestAnimationFrame(tick)
}

function endListening(reason = 'tap') {
  if (S.phase !== 'listening') return
  cancelAnimationFrame(S.vad.raf)
  releaseWakeLock()
  setLevel(0)

  if (reason === 'tap' && S.vad.speech < 180) {
    S.pendingUpload = false
    setPhase('idle', '没听到声音，再说一次')
    try {
      if (S.rec && S.rec.state !== 'inactive') S.rec.stop()
    } catch {}
    return
  }
  setPhase('transcribing', '正在识别…')
  try {
    if (S.rec && S.rec.state !== 'inactive') S.rec.stop()
  } catch {
    setPhase('idle', '录音出错了')
  }
}

async function uploadAudio(blob) {
  const started = performance.now()
  try {
    const res = await fetch('/api/asr', {
      method: 'POST',
      headers: { 'content-type': blob.type || 'audio/webm' },
      body: blob,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `识别失败 ${res.status}`)
    if (!data.text) {
      setPhase('idle', '没听清，再说一次')
      return
    }
    console.info('[asr]', Math.round(performance.now() - started), 'ms', data.text)
    addMsg('user', data.text)
    await ask(data.text, true)
  } catch (e) {
    console.warn('[asr]', e)
    setPhase('idle', '识别失败，再试一次')
    toast(e instanceof Error ? e.message : '识别失败')
  }
}

/* ---------------- chat ---------------- */

async function ask(text, spoken) {
  if (S.phase === 'speaking') stopSpeaking()
  S.tAskAt = performance.now()
  S.tFirstAudioAt = 0
  S.replySpoken = spoken
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
  let tFirstToken = 0
  let tFirstAudio = 0
  let spokeAny = false

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: S.messages.map((m) => ({ role: m.role, content: m.content })),
      }),
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
              tFirstToken = performance.now() - t0
              console.info('[llm] first token', Math.round(tFirstToken), 'ms')
            }
            full += j.t
            buf += j.t
            bubble.textContent = full
            scrollChat()
            const { out, rest } = splitSentences(buf, false)
            buf = rest
            out.forEach(enqueueSpeech)
          }
          if (j.done && !full) throw new Error('模型没有返回内容')
        }
      }
    }

    const tail = splitSentences(buf, true)
    tail.out.forEach(enqueueSpeech)
    bubble.textContent = full || '（这次没说出话，再问一次？）'
    if (full) S.messages.push({ role: 'assistant', content: full })
    saveHistory()
    if (!spoken) setPhase('idle')
    else if (!S.ttsQueue.length && !S.pumping) {
      setPhase('idle')
      maybeAutoListen()
    }
  } catch (e) {
    if (controller.signal.aborted) return
    console.warn('[chat]', e)
    bubble.classList.add('err')
    bubble.textContent = full ? `${full}\n（网络断了，回复不完整）` : '这会儿连不上，稍后再试一次。'
    setPhase('idle', '')
    if (gotToken) S.messages.push({ role: 'assistant', content: full })
    saveHistory()
  } finally {
    if (S.chatAbort === controller) S.chatAbort = null
  }
}

const END_PUNCT = '。！？!?；;\n…'
function splitSentences(input, final, first = false) {
  let out = []
  let rest = String(input || '')
  for (;;) {
    let cut = -1
    for (let i = 0; i < rest.length; i++) {
      if (END_PUNCT.includes(rest[i])) {
        cut = i
        break
      }
    }
    if (cut >= 0) {
      const s = rest.slice(0, cut + 1).trim()
      rest = rest.slice(cut + 1)
      if (s) out.push(s)
      continue
    }
    // 首句优先出声：只要攒到 7 个字，就在第一个逗号处切，别等整句
    if (first && rest.length >= 7) {
      const idx = rest.search(/[，,、]/)
      if (idx >= 4) {
        out.push(rest.slice(0, idx + 1).trim())
        rest = rest.slice(idx + 1)
        continue
      }
    }
    if (rest.length > 14) {
      const idx = Math.max(rest.lastIndexOf('，'), rest.lastIndexOf(','), rest.lastIndexOf('、'))
      if (idx >= 7) {
        out.push(rest.slice(0, idx + 1).trim())
        rest = rest.slice(idx + 1)
      } else {
        out.push(rest.slice(0, 24).trim())
        rest = rest.slice(24)
      }
      continue
    }
    break
  }
  if (final && rest.trim()) out.push(rest.trim())
  return { out, rest }
}

function maybeAutoListen() {
  if (!S.settings.autoListen || !S.replySpoken) return
  if (document.visibilityState !== 'visible') return
  if (S.phase !== 'idle') return
  setTimeout(() => {
    if (S.phase === 'idle' && S.settings.autoListen) startListening()
  }, 320)
}

function newConversation() {
  if (S.chatAbort) S.chatAbort.abort()
  stopSpeaking()
  S.messages = []
  saveHistory()
  $('chat').innerHTML = ''
  document.body.classList.remove('has-chat')
  setPhase('idle', '点一下，开始说话')
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
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.phase === 'listening') acquireWakeLock()
})

/* ---------------- settings sheet ---------------- */

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
  $('engineNote').textContent = S.cfg?.tts?.enabled
    ? ''
    : '· 当前没接服务端语音，会用手机自带的系统语音朗读。'
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
  $('btnClear').addEventListener('click', () => {
    newConversation()
    closeSheet()
    toast('已清空')
  })
}

/* ---------------- init ---------------- */

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

async function boot() {
  bindSettings()

  $('orb').addEventListener('click', () => {
    unlockAudio()
    if (S.phase === 'listening') return endListening('tap')
    if (S.phase === 'transcribing') return
    if (S.phase === 'thinking' || S.phase === 'speaking') {
      if (S.chatAbort) S.chatAbort.abort()
      stopSpeaking()
      setPhase('idle', '')
    }
    startListening()
  })

  $('btnNew').addEventListener('click', newConversation)

  const input = $('textInput')
  input.addEventListener('input', () => autosize(input))
  $('textForm').addEventListener('submit', (e) => {
    e.preventDefault()
    unlockAudio()
    const v = input.value.trim()
    if (!v) return
    if (S.phase === 'listening') endListening('tap')
    if (S.phase === 'thinking') return toast('等我先说这句')
    input.value = ''
    autosize(input)
    addMsg('user', v)
    ask(v, S.settings.speakText)
  })

  for (const chip of document.querySelectorAll('#chips button')) {
    chip.addEventListener('click', () => {
      unlockAudio()
      addMsg('user', chip.textContent)
      ask(chip.textContent, S.settings.speakText)
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

  if (!S.cfg?.asr?.enabled) {
    $('hint').textContent = '语音识别暂不可用 · 先用打字'
  } else if (!window.isSecureContext) {
    $('hint').textContent = '需要 https 才能录音 · 先用打字'
  }
  if (S.cfg?.tts?.enabled) $('hint').textContent = '也可以直接打字 · 录音只在本次识别，不保存'
  setPhase('idle', S.messages.length ? '接着说，或者直接打字' : '点一下，开始说话')
}

boot()
