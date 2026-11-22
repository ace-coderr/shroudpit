import { useSyncExternalStore } from 'react'
import { getRpcStatus, subscribeRpcStatus } from '../lib/rpc'
import { useNow } from '../lib/hooks'

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s} s ago`
  const m = Math.round(s / 60)
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

/**
 * A thin line under the navbar: shown only while devnet is rate-limiting us ("busy, retrying") or
 * while a cached answer is on screen instead of a live one ("cached", with its age).
 */
export default function RpcStatus() {
  const s = useSyncExternalStore(subscribeRpcStatus, getRpcStatus)
  const now = useNow(5000)
  if (!s.retrying && s.staleSince === null) return null
  return (
    <div className="rpcbar" role="status" aria-live="polite">
      {s.retrying && <span>Devnet is busy, retrying…</span>}
      {s.staleSince !== null && (
        <span>
          <b className="tag">cached</b> Some data is from {ago(now * 1000 - s.staleSince)}. It updates as soon as devnet answers.
        </span>
      )}
    </div>
  )
}
