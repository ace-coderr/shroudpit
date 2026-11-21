import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchLeague, fetchLeagues } from './chain'
import type { LeagueView } from './chain'
import type { PublicKey } from '@solana/web3.js'

/** Run `fn` now and every `ms`, keeping the latest result. Errors are surfaced, not hidden. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const refresh = useCallback(async () => {
    try {
      setData(await fnRef.current())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      if (alive) await refresh()
    }
    void tick()
    const id = setInterval(() => void tick(), ms)
    return () => {
      alive = false
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, refresh, ...deps])

  return { data, error, loading, refresh }
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
