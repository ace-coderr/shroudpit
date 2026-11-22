import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PublicKey } from '@solana/web3.js'
import { fetchCards } from '../lib/chain'
import { STATUS_LABEL } from '../lib/config'
import { short, useLeague, usePoll } from '../lib/hooks'
import { useSigner } from '../lib/wallet'
import Seal from '../components/Seal'

/**
 * Rank-only standings. Ranks come from the committed base-layer copy of each entry, which changes
 * only when a round settles. Nothing here moves tick by tick, so the order cannot be used to infer
 * who is long or short while a round is live. The README has the leak analysis.
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
  const entries = usePoll(() => (key ? fetchCards(key) : Promise.resolve([])), 10_000, [key?.toBase58()])

  if (!key) return <section className="page"><p className="notice notice--bad">That league address is not valid.</p></section>

  const scored = (entries.data ?? []).filter((e) => e.roundsScored > 0)
  const ranked = [...(entries.data ?? [])].sort((a, b) => b.rating - a.rating || (a.player.toBase58() < b.player.toBase58() ? -1 : 1))
  const settledRounds = league ? Math.min(league.round, league.nRounds) : 0

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Rank-only standings</p>
        <h1 className="page__title">{league ? `${STATUS_LABEL[league.status]} · ${settledRounds} of ${league.nRounds} rounds settled` : 'Standings'}</h1>
        <p className="page__lede">
          The order below is the order at the last settled round. It does not move while a round is live, so
          it says nothing about anyone's open position.
        </p>
        <nav className="subnav">
          <Link to={`/desk/${key.toBase58()}`}>Desk</Link>
          <Link to={`/audit/${key.toBase58()}`}>Reveal &amp; audit</Link>
        </nav>
      </header>

      {entries.error && <p className="notice notice--bad">{entries.error}</p>}
      {scored.length === 0 && <p className="empty">No round has settled yet, so there is no order to show. Players are listed with their ranks hidden.</p>}

      <ol className="table">
        {ranked.map((e, i) => (
          <li key={e.key.toBase58()} className={signer && e.player.equals(signer.publicKey) ? 'me' : ''}>
            <span className="rank mono">{scored.length === 0 ? <Seal width="2ch" /> : i + 1}</span>
            <span className="mono grow">{short(e.player.toBase58(), 6, 6)}{signer && e.player.equals(signer.publicKey) && <em> you</em>}</span>
            <span className="muted">{e.roundsScored} round{e.roundsScored === 1 ? '' : 's'} scored</span>
            {league?.status === 4 && league.winner.equals(e.player) && <span className="badge badge--4">Winner</span>}
          </li>
        ))}
      </ol>
      <p className="muted small">
        Ratings and per-round returns are published on the <Link to={`/audit/${key.toBase58()}`}>Reveal &amp; audit</Link> page,
        once each round has settled.
      </p>
    </section>
  )
}
