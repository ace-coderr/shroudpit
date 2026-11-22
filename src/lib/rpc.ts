/**
 * Resilient RPC for a site with no backend.
 *
 * The public devnet endpoint rate-limits hard (getProgramAccounts above all), so every request
 * goes through a fetch that:
 *   - backs off exponentially on HTTP 429 / 5xx / network errors and rotates between endpoints
 *     when more than one is configured (optional build-time VITE_RPC_FALLBACK, comma-separated,
 *     public keyless URLs only: it is baked into the public bundle);
 *   - dedupes identical in-flight reads and briefly reuses a fresh answer;
 *   - remembers the last good answer for every read, in memory and in localStorage with its
 *     timestamp, and serves it (flagged as cached) when the network keeps failing, so a failed
 *     load never turns into an empty screen.
 * Only plain reads are cached. Nothing authenticated goes through here (the Private ER session
 * connection has its own fetch), so no token is ever stored.
 */
const env = (import.meta as { env?: Record<string, string | undefined> }).env
export const FALLBACK_RPCS: string[] = (env?.VITE_RPC_FALLBACK ?? '')
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean)

const MAX_ATTEMPTS = 8
const MAX_ATTEMPTS_WITH_CACHE = 3 // a cached answer exists: give up on the network sooner
const READS = new Set(['getProgramAccounts', 'getMultipleAccounts', 'getAccountInfo', 'getSignaturesForAddress', 'getTransaction'])
const FRESH_MS: Record<string, number> = { getProgramAccounts: 5_000, getMultipleAccounts: 2_000, getAccountInfo: 1_500 }
const STORAGE_PREFIX = 'shroudpit.rpc.v1.'
const MAX_STORED_CHARS = 150_000
const MAX_AGE_MS = 24 * 3_600_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- status (for the UI)

export interface RpcStatus {
  /** A request is failing and being retried right now. */
  retrying: boolean
  /** Unix ms of the oldest cached answer currently on screen in place of a live one, or null. */
  staleSince: number | null
}
let status: RpcStatus = { retrying: false, staleSince: null }
const listeners = new Set<() => void>()
const staleKeys = new Map<string, number>()
function publish(next: Partial<RpcStatus>) {
  const merged = { ...status, ...next }
  if (merged.retrying === status.retrying && merged.staleSince === status.staleSince) return
  status = merged
  listeners.forEach((l) => l())
}
const oldestStale = () => (staleKeys.size ? Math.min(...staleKeys.values()) : null)
export const getRpcStatus = () => status
export const subscribeRpcStatus = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

// ---------------------------------------------------------------- cache

interface Stored {
  t: number
  text: string
}
const memory = new Map<string, Stored>()
const inflight = new Map<string, Promise<Stored & { status: number; stale: boolean }>>()

const hash = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
function readStored(key: string): Stored | null {
  const hit = memory.get(key)
  if (hit) return hit
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + hash(key))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Stored & { k?: string }
    if (parsed.k !== key || Date.now() - parsed.t > MAX_AGE_MS) return null
    memory.set(key, parsed)
    return parsed
  } catch {
    return null
  }
}
function writeStored(key: string, value: Stored) {
  memory.set(key, value)
  if (value.text.length > MAX_STORED_CHARS) return
  const payload = JSON.stringify({ ...value, k: key })
  try {
    localStorage.setItem(STORAGE_PREFIX + hash(key), payload)
  } catch {
    // quota or blocked storage: drop our old entries once and try again, otherwise live without it
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i)
        if (k?.startsWith(STORAGE_PREFIX)) localStorage.removeItem(k)
      }
      localStorage.setItem(STORAGE_PREFIX + hash(key), payload)
    } catch {
      /* no storage */
    }
  }
}

// ---------------------------------------------------------------- fetching with backoff

async function withBackoff(urls: string[], init: RequestInit | undefined, attempts: number): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(urls[attempt % urls.length], init)
      const retryable = res.status === 429 || res.status >= 500
      if (!retryable) {
        publish({ retrying: false })
        return res
      }
      if (attempt === attempts - 1) return res
      lastError = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastError = e
    }
    publish({ retrying: true })
    // 0.4 s, 0.8 s, 1.6 s, 3.2 s, 6.4 s, then 10 s (capped), each with +/-30% jitter
    await sleep(Math.min(10_000, 400 * 2 ** attempt) * (0.7 + Math.random() * 0.6))
  }
  throw lastError
}

const withId = (text: string, id: unknown) => {
  try {
    const body = JSON.parse(text) as { id?: unknown }
    body.id = id
    return JSON.stringify(body)
  } catch {
    return text
  }
}
const asResponse = (text: string, code: number, id: unknown) =>
  new Response(withId(text, id), { status: code, headers: { 'content-type': 'application/json' } })

export function resilientFetch(primary: string, fallbacks: string[] = []): typeof fetch {
  const urls = [primary, ...fallbacks]
  return async (_input, init) => {
    let req: { id?: unknown; method?: string; params?: unknown } | null = null
    try {
      req = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    } catch {
      req = null
    }
    const cacheable = !!req && !Array.isArray(req) && !!req.method && READS.has(req.method)
    if (!cacheable || !req) return withBackoff(urls, init, MAX_ATTEMPTS)

    const key = `${primary}|${req.method}|${JSON.stringify(req.params)}`
    const recent = memory.get(key)
    const fresh = FRESH_MS[req.method!] ?? 0
    if (recent && !staleKeys.has(key) && Date.now() - recent.t < fresh) return asResponse(recent.text, 200, req.id)

    let pending = inflight.get(key)
    if (!pending) {
      pending = (async () => {
        const stored = readStored(key)
        try {
          const res = await withBackoff(urls, init, stored ? MAX_ATTEMPTS_WITH_CACHE : MAX_ATTEMPTS)
          const text = await res.text()
          if (res.ok && !text.includes('"error"')) {
            const value = { t: Date.now(), text }
            writeStored(key, value)
            staleKeys.delete(key)
            publish({ staleSince: oldestStale() })
            return { ...value, status: res.status, stale: false }
          }
          if (stored) throw new Error(`HTTP ${res.status}`)
          return { t: Date.now(), text, status: res.status, stale: false }
        } catch (e) {
          if (stored) {
            // the network keeps failing, but there is a last good answer: show it, flagged as cached
            staleKeys.set(key, stored.t)
            publish({ staleSince: oldestStale() })
            return { ...stored, status: 200, stale: true }
          }
          throw e
        }
      })().finally(() => inflight.delete(key))
      inflight.set(key, pending)
    }
    const r = await pending
    return asResponse(r.text, r.status, req.id)
  }
}

/** One raw JSON-RPC call through the same resilient fetch (used where web3.js cannot parse the reply). */
export async function rpcJson<T>(url: string, method: string, params: unknown[], fallbacks: string[] = []): Promise<T | null> {
  const res = await resilientFetch(url, fallbacks)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(body.error.message)
  return body.result ?? null
}
