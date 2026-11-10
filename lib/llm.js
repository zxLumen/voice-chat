import { AI_TOKEN, GATEWAY_URL, MODEL, REQUEST_TIMEOUT_MS } from './env.js'

export const SYSTEM_PROMPT = [
  '你是「随口」，一个陪人聊天的语音助手。现在是实时语音通话，你的回答会被念出来。',
  '规则：',
  '1. 口语化、短。一般 1~3 句、不超过 80 字；用户明确要求展开时才多说。',
  '2. 不用 Markdown、列表、标题、代码块、表情符号、括号补充说明。',
  '3. 不复述用户的问题，不说「好的」「收到」「根据你的描述」这类开场。',
  '4. 数字、单位、英文缩写要念得顺口，避免长串符号和公式。',
  '5. 不知道就直说不知道；天气、股价、新闻等实时信息你没有联网，别编。',
  '6. 用中文回答，除非用户全程说别的语言。',
  '7. 语气自然、有点人味，可以偶尔反问一句，但别每句都问。',
].join('\n')

export const MAX_HISTORY = 16

/** 只保留最近若干轮，并裁掉异常长的内容，防止上下文膨胀。 */
export function trimHistory(messages) {
  const clean = (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
  return clean.slice(-MAX_HISTORY)
}

/**
 * 流式对话。onDelta 收到增量文本；返回 { text, usage }。
 * 上游走主站 AI 网关（OpenAI 兼容），默认开 reasoning_effort=none，
 * 否则 deepseek-v4.1-flash 会把 token 全花在 thinking 上、正文为空。
 */
export async function streamChat({ messages, signal, onDelta, model = MODEL }) {
  if (!AI_TOKEN) throw new Error('缺少对话令牌（VOICE_AI_TOKEN）')

  const payload = {
    model,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.7,
    max_tokens: 400,
    reasoning_effort: 'none',
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...trimHistory(messages)],
  }

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout

  const res = await fetch(`${GATEWAY_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${AI_TOKEN}`,
      'x-zx-app-token': AI_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: composed,
  })

  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '')
    throw new Error(`对话失败 ${res.status}：${t.slice(0, 200)}`)
  }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  let usage = null

  const handleLine = (line) => {
    const s = line.trim()
    if (!s.startsWith('data:')) return
    const data = s.slice(5).trim()
    if (!data || data === '[DONE]') return
    let j
    try {
      j = JSON.parse(data)
    } catch {
      return
    }
    if (j.usage) usage = j.usage
    const delta = j.choices?.[0]?.delta
    const piece = delta?.content
    if (typeof piece === 'string' && piece) {
      full += piece
      onDelta(piece)
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  }
  if (buf.trim()) handleLine(buf)

  return { text: full, usage }
}
