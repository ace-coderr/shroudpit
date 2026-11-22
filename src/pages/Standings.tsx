import { useLayoutEffect, useMemo, useRef } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PublicKey } from '@solana/web3.js'
import { fetchCards } from '../lib/chain'
import { STATUS_LABEL } from '../lib/config'
import { short, useLeague, usePoll } from '../lib/hooks'
import { useSigner } from '../lib/wallet'
import DeskShell from '../components/DeskShell'
import Seal from '../components/Seal'
import Skeleton from '../components/Skeleton'
import StatusBadge from '../components/StatusBadge'

/** Slide rows from their old place to their new one whenever the order changes (FLIP). */
function useFlip(order: string[]) {
  const refs = useRef(new Map<string, HTMLElement>())
  const prev = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const next = new Map<string, number>()
    refs.current.forEach((el, k) => next.set(k, el.getBoundingClientRect().top))
    if (!reduce) {
      next.forEach((top, k) => {
        const before = prev.current.get(k)
        const el = refs.current.get(k)
        if (before !== undefined && el && before !== top) {
          el.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], { duration: 500, easing: 'cubic-bezier(0.22, 0.8, 0.24, 1)' })
        }
      })
    }
    prev.current = next
  }, [order.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
  return (k: string) => (el: HTMLElement | null) => {
    if (el) refs.current.set(k, el)
    else refs.current.delete(k)
  }
}

/**
 * Rank-only standings. Ranks come from the committed score cards, which change only when a round
 * settles. Nothing here moves tick by tick, so the order cannot be used to infer who is long or
 * short during a live round.
 */
export default function Standings() {
  const { league: addr } = useParams()
  const key = useMemo(() => {
    try {
      return addr ? new PublicKey(addr) : null
    } catch {
      return null
    }
  }, [addr])
  const signer = useSigner()
  const { data: league } = useLeague(key, 5000)
  const cards = usePoll(() => (key ? fetchCards(key) : Promise.resolve([])), 10_000, [key?.toBase58()])

  const scored = (cards.data ?? []).filter((c) => c.roundsScored > 0)
  const ranked = [...(cards.data ?? [])].sort((a, b) => b.rating - a.rating || (a.player.toBase58() < b.player.toBase58() ? -1 : 1))
  const bind = useFlip(ranked.map((c) => c.key.toBase58()))

  if (!key) return <section className="page"><p className="notice notice--bad">That league address is not valid.</p></section>
  const settledRounds = league ? Math.min(league.round, league.nRounds) : 0

  return (
    <DeskShell league={league ?? null}>
      <section className="page">
        <header className="page__head">
          <span className="caption">Rank-only standings</span>
          <h1>{league ? `${settledRounds} of ${league.nRounds} rounds settled` : 'Standings'}</h1>
          <p className="page__lede">
            {league ? `${STATUS_LABEL[league.status]}. ` : ''}Ranks update only at round boundaries, never tick by tick. If they moved live, the order itself
            would tell everyone who is long and who is short. Between settlements the order is frozen.
          </p>
        </header>

        {cards.error && <p className="notice notice--bad">{cards.error}</p>}
        {cards.loading && <Skeleton count={3} height="4rem" />}
        {!cards.loading && scored.length === 0 && (
          <p className="empty">No round has settled yet, so there is no order to show. Ranks stay sealed until the first settlement.</p>
        )}

        <ol className="ranklist">
          {ranked.map((c, i) => {
            const mine = signer && c.player.equals(signer.publicKey)
            return (
              <li key={c.key.toBase58()} ref={bind(c.key.toBase58())} className={`rankrow${mine ? ' rankrow--me' : ''}`}>
                <span className="rankrow__rank mono">{scored.length === 0 ? <Seal width="2ch" /> : i + 1}</span>
                <span className="mono grow break">{short(c.player.toBase58(), 6, 6)}{mine && <span className="tag" style={{ marginLeft: '0.5rem' }}>you</span>}</span>
                <span className="mono small muted">{c.roundsScored} round{c.roundsScored === 1 ? '' : 's'} scored</span>
                <StatusBadge kind={c.roundsScored > 0 ? 'revealed' : 'sealed'} label={c.roundsScored > 0 ? 'Scored · confirmed on-chain' : 'Sealed'} />
                {league?.status === 4 && league.winner.equals(c.player) && <span className="tag tag--live">winner</span>}
              </li>
            )
          })}
        </ol>

        <p className="muted small" style={{ marginTop: '1rem' }}>
          Ratings, per-round returns and positions are published on the <Link to={`/audit/${key.toBase58()}`}>audit page</Link> once the league has finished.
        </p>
      </section>
    </DeskShell>
  )
}
