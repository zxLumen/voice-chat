/**
 * 语音识别后处理：补标点 + 按上下文纠同音字 + 合并口头重复。
 *
 * 为什么要这一步：ASR 模型只看得到一段 3~10 秒的音频，同音字、专有名词、
 * 中英混说全靠猜；对话上下文和术语表它一无所知。所以转写之后再用一次
 * 便宜的小模型调用，把「单词识别」变成「像人写下来的一句话」。
 *
 * 失败/超时/模型开始回答问题 → 一律回退原文，绝不让说话流程卡住。
 */
import { EXTRA_HOTWORDS, GATEWAY_URL, POLISH_ENABLED, POLISH_MODEL, POLISH_TIMEOUT_MS, POLISH_TOKEN } from './env.js'

/** 常用术语：ASR 最容易听错的专名。用户可用 VOICE_HOTWORDS 追加（逗号分隔）。 */
export const HOTWORDS = [
  'zxLumen',
  'StockApp',
  'Opencode-Pocket',
  'opencode',
  'deepseek',
  'CosyVoice',
  'SiliconFlow',
  'Caddy',
  'Ray',
  'MBTI',
  'holdout',
  '夏普',
  '回测',
  '对位',
  '随口',
  '无恙',
  '光圈',
  '嘴替',
  '望京SOHO',
  '腾讯',
  '百度',
]

const SYSTEM = [
  '你是中文语音输入法的后处理器。用户给你一段 ASR（语音识别）原文，你把它改写成「可以直接当消息发出去的一句话」。',
  '只做四件事：',
  '1. 补标点：按语义断句，逗号、句号、问号该有就有，不要每句都加感叹号。',
  '2. 纠错：改掉同音字、近音字、明显错字；英文术语按术语表和常识还原正确拼写与大小写（例如 cosy voice→CosyVoice、stock app→StockApp）。',
  '3. 去赘余：删掉无意义的重复（「我我我觉得」→「我觉得」）和纯语气词（嗯、啊、呃、那个、就是说）；但「那个项目」这类有实义的「那个」必须保留。',
  '4. 合并被错误切开的词，语序和意思保持原样。',
  '硬性要求：',
  '- 不要回答、不要解释、不要总结、不要扩写；信息量与原文一致，不添加原文没有的人名、数字、结论。',
  '- 只输出处理后的一行文本，不要引号，不要「输出：」这类前缀，不要 markdown。',
  '- 原文已经通顺就原样输出，不要为了改而改。',
].join('\n')

export const polishStats = { calls: 0, ok: 0, rejected: 0, fallback: 0, lastMs: 0, lastErr: '' }

/**
 * 只在「值得等」的时候润色：中英混说（专名最容易错）或长句听写。
 * 短中文句子润色收益小、却要额外等 1.5s，直接跳过保证对话跟手。
 */
export function shouldPolish(raw) {
  const t = String(raw || '').trim()
  if (t.length < 4) return false
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(t)) return false
  const mixed = /[a-zA-Z]{2,}/.test(t)
  return mixed || t.length >= 24
}

/** 取最近几轮对话，只留很短的一截，够判断同音词即可（也省 token）。 */
export function contextLines(history, { maxTurns = 4, maxChars = 80 } = {}) {
  const rows = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-maxTurns * 2)
  return rows.map((m) => `${m.role === 'user' ? '用户' : '随口'}：${m.content.replace(/\s+/g, ' ').slice(0, maxChars)}`)
}

export function buildPolishPayload({ text, history, hotwords } = {}) {
  const lines = []
  const ctx = contextLines(history)
  if (ctx.length) lines.push('[最近对话，只用来判断同音词，不要回答它]', ...ctx, '')
  const words = Array.from(new Set([...(hotwords || []), ...EXTRA_HOTWORDS, ...HOTWORDS])).filter(Boolean)
  if (words.length) lines.push(`[术语表] ${words.join('、')}`, '')
  lines.push('[ASR 原文]', String(text || '').trim())
  return {
    model: POLISH_MODEL,
    stream: false,
    temperature: 0.1,
    max_tokens: 120,
    reasoning_effort: 'none',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: lines.join('\n') },
    ],
  }
}

const BAD_START = /^(输出|修正后|改写后|结果|答案|好的|以下是|这句话|原文[：:])/
const BAD_CONTENT = /(抱歉|作为一个?AI|我无法|我不能|无法确定|根据你的描述|希望(这|以上))/

/** 清洗模型返回：去引号/前缀，只保留一行。 */
export function cleanPolishOutput(out) {
  let t = String(out || '').trim()
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '')
  t = t.split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
  t = t.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim()
  t = t.replace(BAD_START, '').replace(/^[：:，,、\s]+/, '').trim()
  return t
}

/**
 * 守卫：模型偶尔会开始回答问题或大改内容，这种一律不用。
 * 长度允许 ±50%（补标点、纠错会变长一点），但不能再多。
 */
export function acceptPolish(raw, out) {
  const a = String(raw || '').trim()
  const b = String(out || '').trim()
  if (!b) return false
  if (badContent(b)) return false
  if (b.length < Math.max(2, a.length * 0.5)) return false
  if (b.length > a.length * 1.9 + 6) return false
  return true
}

function badContent(t) {
  return BAD_CONTENT.test(t)
}

/**
 * 转写后处理。任何异常都回退原文（返回 raw）。
 * @returns {{text:string, polished:boolean, ms:number, error?:string}}
 */
export async function polishTranscript({ text, history, hotwords, signal, timeoutMs = POLISH_TIMEOUT_MS } = {}) {
  const raw = String(text || '').trim()
  if (!POLISH_ENABLED || !POLISH_TOKEN || !shouldPolish(raw)) return { text: raw, polished: false, ms: 0 }

  const started = Date.now()
  polishStats.calls++
  const timeout = AbortSignal.timeout(Math.max(300, timeoutMs))
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const res = await fetch(`${GATEWAY_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${POLISH_TOKEN}`,
        'x-zx-app-token': POLISH_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildPolishPayload({ text: raw, history, hotwords })),
      signal: composed,
    })
    if (!res.ok) throw new Error(`润色失败 ${res.status}`)
    const data = await res.json()
    const out = cleanPolishOutput(data?.choices?.[0]?.message?.content)
    const ms = Date.now() - started
    polishStats.lastMs = ms
    if (!acceptPolish(raw, out)) {
      polishStats.rejected++
      console.warn(`[asr] polish rejected raw=${raw.length} out=${out.length || 0} ms=${ms}`)
      return { text: raw, polished: false, ms }
    }
    polishStats.ok++
    return { text: out, polished: true, ms }
  } catch (e) {
    const ms = Date.now() - started
    polishStats.fallback++
    polishStats.lastMs = ms
    polishStats.lastErr = e instanceof Error ? e.message : String(e)
    console.warn('[asr] polish fallback', polishStats.lastErr, `${ms}ms`)
    return { text: raw, polished: false, ms, error: polishStats.lastErr }
  }
}
