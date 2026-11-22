import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchLeague, fetchLeagues } from './chain'
import { loadError } from './errors'
import type { LeagueView } from './chain'
import type { PublicKey } from '@solana/web3.js'

/**
 * Run `fn` now and every `ms`, keeping the last good result on screen.
 * A failed read never clears `data`; `error` is plain language (never a raw RPC reply), `busy` says it
 * is a rate limit or outage that retrying will clear, and `failed` means there is nothing to show yet.
 * While reads fail it retries by itself with growing gaps (3 s, 6 s, 12 s … up to 30 s).
 */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<{ text: string; busy: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const run = useCallback(async (): Promise<boolean> => {
    try {
      setData(await fnRef.current())
      setError(null)
      return true
    } catch (e) {
      setError(loadError(e))
      return false
    } finally {
      setLoading(false)
    }
  }, [])
  const refresh = useCallback(async () => {
    await run()
  }, [run])

  useEffect(() => {
    let alive = true
    let fails = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (!alive) return
      const ok = await run()
      if (!alive) return
      if (ok) {
        fails = 0
      } else {
        fails += 1
        timer = setTimeout(() => void tick(), Math.min(30_000, 3000 * 2 ** (fails - 1)))
      }
    }
    void tick()
    const id = setInterval(() => {
      if (fails === 0) void tick() // while failing, the backoff timer above drives the retries
    }, ms)
    return () => {
      alive = false
      clearTimeout(timer)
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, run, ...deps])

  return { data, error: error?.text ?? null, busy: error?.busy ?? false, failed: error !== null && data === null, loading, refresh }
}

export const useLeagues = () => usePoll(() => fetchLeagues(), 15_000)

export function useLeague(key: PublicKey | null, ms = 2000) {
  return usePoll<LeagueView | null>(() => (key ? fetchLeague(key) : Promise.resolve(null)), ms, [key?.toBase58()])
}

/** Seconds since epoch, ticking every `ms`. */
export function useNow(ms = 500) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

export const short = (s: string, a = 4, b = 4) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s)
export const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('')
export const mmss = (secs: number) => {
  const s = Math.max(0, Math.floor(secs))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
