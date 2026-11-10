/**
 * 朗读前的文本归一化 + 口语句子切分。
 * 目标：让 TTS 念对数字/单位/日期，别把 Markdown 符号、表情、链接念出来，
 * 并且把长句切成「一口气能念完」的短句，减少机器味和卡顿。
 */

const CN_DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const CN_UNIT = ['', '十', '百', '千']
const CN_BIG = ['', '万', '亿', '万亿']

/** 1~9999 的中文读法（不处理「一十」→「十」以外的复杂规则）。 */
function under10000(n) {
  const s = String(n)
  let out = ''
  let zero = false
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i])
    const pos = s.length - i - 1
    if (d === 0) {
      zero = true
      continue
    }
    if (zero && out) out += '零'
    zero = false
    out += CN_DIGIT[d] + CN_UNIT[pos]
  }
  return out
}

/** 整数 → 中文（支持到万亿级，够用了）。 */
export function intToChinese(input) {
  let n = Math.trunc(Math.abs(Number(input)))
  if (!Number.isFinite(n)) return String(input)
  if (n === 0) return '零'
  const groups = []
  while (n > 0) {
    groups.unshift(n % 10000)
    n = Math.floor(n / 10000)
  }
  let out = ''
  let needZero = false
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    if (g === 0) {
      needZero = true
      continue
    }
    if (out && (needZero || g < 1000)) out += '零'
    out += under10000(g) + CN_BIG[groups.length - 1 - i]
    needZero = false
  }
  return out.replace(/^一十/, '十')
}

/** 逐位读（年份、电话号码、编号）。 */
export function digitsToChinese(s) {
  return String(s).replace(/\d/g, (d) => CN_DIGIT[Number(d)])
}

/** 小数 / 负数 / 普通整数。 */
export function numberToChinese(raw) {
  let s = String(raw).replace(/,/g, '')
  let sign = ''
  if (/^[-−负]/.test(s)) {
    sign = '负'
    s = s.slice(1)
  }
  const [int, frac] = s.split('.')
  let out = intToChinese(int)
  if (frac) out += '点' + digitsToChinese(frac)
  return sign + out
}

const UNIT_MAP = [
  [/\bkm\/h\b/gi, '公里每小时'],
  [/\bkm\b/gi, '公里'],
  [/\bkg\b/gi, '公斤'],
  [/\bcm\b/gi, '厘米'],
  [/\bmm\b/gi, '毫米'],
  [/\bms\b/gi, '毫秒'],
  [/\bmin\b/gi, '分钟'],
  [/\b(?:h|hr)\b/gi, '小时'],
  [/\bs\b/gi, '秒'],
  [/\bGB\b/g, '吉字节'],
  [/\bTB\b/g, '太字节'],
  [/\bMB\b/g, '兆字节'],
  [/℃|°C/g, '摄氏度'],
  [/°F/g, '华氏度'],
]

/** 去掉不该念出来的东西：代码块、链接、Markdown、表情、多余符号。 */
export function stripSpeechArtifacts(input) {
  let t = String(input || '')
  t = t.replace(/```[\s\S]*?```/g, ' ')
  t = t.replace(/`([^`]*)`/g, '$1')
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/https?:\/\/\S+/gi, ' ')
  t = t.replace(/[*_#>|]+/g, ' ')
  t = t.replace(/^[-·•]\s*/gm, '')
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
  t = t.replace(/[“”‘’「」『』《》]/g, '')
  t = t.replace(/[（(]\s*[)）]/g, ' ')
  t = t.replace(/\s+/g, ' ')
  return t.trim()
}

/** 数字、单位、日期、时间、百分比 → 口语读法。 */
export function normalizeNumbers(input) {
  let t = String(input || '')
  // 千分位：1,234.5 → 1234.5（不先去掉的话会被当成「一，二百三十四」）
  t = t.replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1')

  // 百分比（先处理负号，否则「-12.3%」会念成「负百分之…」中间断不开）
  t = t.replace(/([-−]?)\s*(\d+(?:\.\d+)?)\s*%/g, (_, sign, n) => `${sign ? '负' : ''}百分之${numberToChinese(n)}`)
  t = t.replace(/[¥￥]\s*(\d+(?:\.\d+)?)/g, (_, n) => `${numberToChinese(n)}元`)
  t = t.replace(/(\d+(?:\.\d+)?)\s*元/g, (_, n) => `${numberToChinese(n)}元`)

  // 日期 2026-11-10 / 2026/11/10 / 2026年11月10日（必须早于「区间」）。
  t = t.replace(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/g, (_, y, m, d) => `${digitsToChinese(y)}年${intToChinese(m)}月${intToChinese(d)}日`)
  // 年份单独出现
  t = t.replace(/(19|20)(\d{2})(?=年)/g, (_, a, b) => `${digitsToChinese(a)}${digitsToChinese(b)}`)
  // 时间 10:30 / 9:05
  t = t.replace(/(\d{1,2}):(\d{2})/g, (_, h, m) => `${intToChinese(h)}点${m === '00' ? '整' : intToChinese(m) + '分'}`)

  // 区间 3~5 / 3-5 / 3至5 → 三到五（放在日期/时间之后，避免拆坏 2026-11-10）
  t = t.replace(/(\d)\s*[-~～—–至]\s*(\d)/g, '$1到$2')

  // 剩下的负号：-12 → 负十二
  t = t.replace(/[-−]\s*(?=\d)/g, '负')

  // 长数字串（电话、编号、身份证）逐位读
  t = t.replace(/\d{7,}/g, (m) => digitsToChinese(m))

  // 普通整数 / 小数
  t = t.replace(/\d+(?:\.\d+)?/g, (m) => numberToChinese(m))

  for (const [re, to] of UNIT_MAP) t = t.replace(re, to)
  return t
}

/** 符号 → 口语（注意：要在数字换算前后都安全，所以只用明确的符号）。 */
export function normalizeSymbols(input) {
  return String(input || '')
    .replace(/[×✕]/g, '乘')
    .replace(/[÷]/g, '除以')
    .replace(/[=＝]/g, '等于')
    .replace(/[&＆]/g, '和')
    .replace(/[+＋]/g, '加')
    .replace(/[→➜]/g, '到')
    .replace(/[~～]/g, '到')
    .replace(/([A-Za-z])\/([A-Za-z])(?![A-Za-z])/g, '$1或$2')
    .replace(/(?:…+|\.{3,})/g, '，')
}

/** 完整归一化：先清符号，再读数字单位，最后收尾空白。 */
export function normalizeForSpeech(input) {
  // 符号先口语化（~ → 到、= → 等于…），再清 Markdown/链接，避免「~」被当噪音删掉
  let t = normalizeSymbols(input)
  t = stripSpeechArtifacts(t)
  // 注意：不再把大写缩写拆成单字母（SOHO 被念成「S O H O」很怪）；交给 TTS 自己读
  t = normalizeNumbers(t)
  t = t.replace(/\s*([，。！？；：、])\s*/g, '$1')
  // 中文之间不留空格（数字读法替换后会带空格），英文单词之间保留
  t = t.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
  t = t.replace(/([\u4e00-\u9fff])\s+(?=[，。！？；：、])/g, '$1')
  t = t.replace(/\s+/g, ' ').trim()
  return t
}

const HARD_END = '。！？!?；;\n…'
const SOFT_END = '，,、：:'

/**
 * 把流式文本切成适合逐句合成的片段。
 * 第一段尽量短（≤ firstMax 字，在逗号处就断），让首声更快；其余段 ≤ max 字。
 * @returns {{out: string[], rest: string}}
 */
export function splitForSpeech(input, final = false, { firstMax = 12, max = 30 } = {}) {
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
