/**
 * Resilient RPC. The public devnet endpoint rate-limits getProgramAccounts hard, so every request
 * goes through a fetch that backs off exponentially on HTTP 429 and 5xx (and on network errors) and,
 * when more than one endpoint is configured, rotates to the next one between attempts.
 *
 * Extra endpoints come from the optional build-time variable VITE_RPC_FALLBACK, a comma-separated
 * list of devnet RPC URLs. Nothing is hard-coded here, and no key ever lives in the repository.
 */
const env = (import.meta as { env?: Record<string, string | undefined> }).env
export const FALLBACK_RPCS: string[] = (env?.VITE_RPC_FALLBACK ?? '')
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean)

const MAX_ATTEMPTS = 8
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function resilientFetch(primary: string, fallbacks: string[] = []): typeof fetch {
  const urls = [primary, ...fallbacks]
  return async (_input, init) => {
    let lastError: unknown = null
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(urls[attempt % urls.length], init)
        const retryable = res.status === 429 || res.status >= 500
        if (!retryable || attempt === MAX_ATTEMPTS - 1) return res
        lastError = new Error(`HTTP ${res.status}`)
      } catch (e) {
        lastError = e
      }
      // 0.4 s, 0.8 s, 1.6 s, 3.2 s, 6.4 s, then 10 s (capped), each with +/-30% jitter
      await sleep(Math.min(10_000, 400 * 2 ** attempt) * (0.7 + Math.random() * 0.6))
    }
    throw lastError
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
