import crypto from 'node:crypto'

export function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function text(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

/** 读取请求体，超限直接抛错（code=413）。 */
export async function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        const e = new Error('body too large')
        e.code = 413
        req.destroy()
        reject(e)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function readJson(req, limit = 64 * 1024) {
  const buf = await readBody(req, limit)
  if (!buf.length) return {}
  return JSON.parse(buf.toString('utf8'))
}

/** 取真实客户端 IP（Caddy 会带 X-Forwarded-For）。 */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}

/** 滑动窗口限流：key → 时间戳数组。 */
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit
    this.windowMs = windowMs
    this.hits = new Map()
  }

  take(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs)
    if (arr.length >= this.limit) {
      this.hits.set(key, arr)
      return false
    }
    arr.push(now)
    this.hits.set(key, arr)
    if (this.hits.size > 5000) {
      // 防内存膨胀：清掉整窗过期的 key
      for (const [k, list] of this.hits) {
        if (!list.length || now - list[list.length - 1] > this.windowMs) this.hits.delete(k)
      }
    }
    return true
  }
}

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex')

/** 极简 LRU（按插入顺序淘汰）。 */
export class LruCache {
  constructor({ maxItems = 80, maxBytes = 24 * 1024 * 1024 } = {}) {
    this.maxItems = maxItems
    this.maxBytes = maxBytes
    this.bytes = 0
    this.map = new Map()
  }

  get(key) {
    const hit = this.map.get(key)
    if (!hit) return null
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key, value) {
    const size = value.length || 0
    if (size > this.maxBytes) return
    if (this.map.has(key)) {
      this.bytes -= this.map.get(key).value.length || 0
      this.map.delete(key)
    }
    this.map.set(key, { value, size })
    this.bytes += size
    while (this.map.size > this.maxItems || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value
      this.bytes -= this.map.get(oldest).value.length || 0
      this.map.delete(oldest)
    }
  }
}

/** SSE 响应头。 */
export function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  if (res.flushHeaders) res.flushHeaders()
}

export const sseSend = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
