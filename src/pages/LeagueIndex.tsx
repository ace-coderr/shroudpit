import { useState } from 'react'
import { Link } from 'react-router-dom'
import { baseConnection, entryPda } from '../lib/chain'
import type { LeagueView } from '../lib/chain'
import { STATUS_LABEL } from '../lib/config'
import { useLeagues, usePoll } from '../lib/hooks'
import { useSigner } from '../lib/wallet'
import Addr from '../components/Addr'
import LoadFailed from '../components/LoadFailed'
import Skeleton from '../components/Skeleton'

// open, sealing nonces, drawing randomness, live, between rounds, revealing
const isActive = (l: LeagueView) => l.status !== 4

/**
 * The Desk and Standings tabs need a league. Leagues the connected wallet is in and that are still
 * running come first, then the other running leagues; finished ones sit behind a collapsed toggle.
 */
export default function LeagueIndex({ target }: { target: 'desk' | 'standings' }) {
  const { data, error, busy, loading, refresh } = useLeagues()
  const signer = useSigner()
  const me = signer?.publicKey
  const [showFinished, setShowFinished] = useState(false)
  const title = target === 'desk' ? 'Pick a desk' : 'Pick a league'

  // which leagues the connected wallet joined (its entry exists on devnet)
  const joined = usePoll(
    async () => {
      if (!me || !data) return new Set<string>()
      const infos = await baseConnection.getMultipleAccountsInfo(data.map((l) => entryPda(l.key, me)))
      return new Set(data.filter((_, i) => infos[i]).map((l) => l.key.toBase58()))
    },
    15_000,
    [me?.toBase58(), data?.length],
  )
  const mine = (l: LeagueView) => joined.data?.has(l.key.toBase58()) ?? false

  const all = data ?? []
  const active = all.filter(isActive)
  const yours = active.filter(mine)
  const others = active.filter((l) => !mine(l))
  const finished = all.filter((l) => !isActive(l))

  const card = (l: LeagueView, i: number) => (
    <li key={l.key.toBase58()} className="card enter" style={{ ['--i' as string]: i }}>
      <div className="card__head">
        <span className={`tag${l.status === 2 ? ' tag--live' : ''}`}>{STATUS_LABEL[l.status]}</span>
        <Addr value={l.key.toBase58()} />
      </div>
      <p className="muted small">
        {l.playerCount}/{l.maxPlayers} players · round {Math.min(l.round + 1, l.nRounds)} of {l.nRounds}
        {mine(l) && <span className="tag" style={{ marginLeft: 'var(--space-2)' }}>you</span>}
      </p>
      <Link className="btn btn--ink" to={`/${target}/${l.key.toBase58()}`}>
        {target === 'desk' ? 'Open desk' : 'Open standings'}
      </Link>
    </li>
  )

  return (
    <section className="page">
      <header className="page__head">
        <span className="caption">{target === 'desk' ? 'Desk' : 'Standings'}</span>
        <h1>{title}</h1>
        <p className="page__lede">
          {target === 'desk'
            ? 'Your desk is where you unlock your private position and place it. Choose a league you have joined.'
            : 'Ranks only change when a round settles. Choose a league to see its order.'}
        </p>
      </header>
      {error && <LoadFailed error={error} busy={busy} onRetry={() => void refresh()} stale={!!data} />}
      {loading && !data && !error && <Skeleton count={2} height="5rem" />}
      {data && all.length === 0 && <p className="empty">No leagues exist yet. <Link to="/create">Create the first one.</Link></p>}

      {data && !me && active.length > 0 && (
        <p className="notice small">Connect your wallet and the leagues you are in come first.</p>
      )}

      {yours.length > 0 && (
        <>
          <h2 className="section-title">Your active leagues</h2>
          <ul className="cards">{yours.map(card)}</ul>
        </>
      )}
      {others.length > 0 && (
        <>
          <h2 className="section-title">{me ? 'Other active leagues' : 'Active leagues'}</h2>
          <ul className="cards">{others.map(card)}</ul>
        </>
      )}
      {data && active.length === 0 && all.length > 0 && <p className="empty">No league is running right now.</p>}

      {finished.length > 0 && (
        <>
          <div className="row" style={{ marginTop: 'var(--space-7)' }}>
            <button
              type="button"
              className="btn btn--ghost"
              aria-expanded={showFinished}
              onClick={() => setShowFinished((v) => !v)}
            >
              {showFinished ? 'Hide' : 'Show'} finished leagues ({finished.length})
            </button>
          </div>
          {showFinished && <ul className="cards" style={{ marginTop: 'var(--space-5)' }}>{finished.map(card)}</ul>}
        </>
      )}
    </section>
  )
}
