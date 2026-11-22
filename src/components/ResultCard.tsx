import { Link } from 'react-router-dom'
import type { PublicKey } from '@solana/web3.js'
import type { CardView, EntryView, LeagueView } from '../lib/chain'
import { lastRoundScored, rankCards, scoredVoided } from '../lib/format'
import Addr from './Addr'
import SealStamp from './SealStamp'

const pct = (bps: number) => `${bps >= 0 ? '+' : ''}${(bps / 100).toFixed(2)}%`

/**
 * What the Desk shows once a league is Revealing or Finished instead of the connect/unlock/place
 * steps: the final rank, rating and per-round returns, from real score cards and revealed entries.
 */
export default function ResultCard({
  league,
  cards,
  entries,
  me,
}: {
  league: LeagueView
  cards: CardView[] | null
  entries: EntryView[]
  me: PublicKey | null
}) {
  const key = league.key.toBase58()
  const finished = league.status === 4
  if (!cards) return <div className="card"><p className="muted">Reading the final scores from devnet…</p></div>

  const winner = league.winner.toBase58()
  const ranked = rankCards(cards, winner)
  const myIndex = me ? ranked.findIndex((c) => c.player.equals(me)) : -1
  const mine = myIndex >= 0 ? ranked[myIndex] : null
  const shown = mine ?? ranked[0]
  const shownEntry = shown ? entries.find((e) => e.player.equals(shown.player)) : undefined
  const isWinner = !!shown && shown.player.toBase58() === winner
  const settled = Math.min(league.round, league.nRounds)
  const lastScored = lastRoundScored(league)

  return (
    <div className="card result">
      <div className="card__head">
        <h3>{mine ? 'Your result' : 'Final result'}</h3>
        <div className="row">
          {isWinner && <span className="tag tag--live">Winner</span>}
          <span className="tag">{finished ? 'Finished' : 'Revealing'}</span>
        </div>
      </div>

      {!shown && <p className="muted">No scores were recorded for this league.</p>}

      {shown && (
        <>
          <div className="result__hero">
            <div>
              <span className="caption">{mine ? 'Final rank' : 'Winner'}</span>
              <div className="result__big mono">{mine ? `${myIndex + 1} / ${ranked.length}` : <Addr value={shown.player.toBase58()} />}</div>
            </div>
            <div>
              <span className="caption">Rating</span>
              <div className="result__big mono">{shown.rating}</div>
            </div>
            <div>
              <span className="caption">Rounds</span>
              <div className="result__big mono">{scoredVoided(shown.roundsScored, settled)}</div>
            </div>
          </div>

          {!mine && <p className="muted small">Connect the wallet that played to see its own result.</p>}

          <h4 className="result__sub">Return per round{mine ? '' : ' (winner)'}</h4>
          {finished && shownEntry ? (
            <ul className="result__rounds">
              {Array.from({ length: settled }, (_, r) => {
                const h = shownEntry.history[r]
                return (
                  <li key={r}>
                    <span className="mono">Round {r + 1}</span>
                    {h?.scored ? <span className="mono">{pct(h.retBps)}</span> : <span className="muted">voided, nobody scored</span>}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="muted small">
              {finished ? 'Reading the revealed rounds…' : 'Each round’s return is published when the reveal finishes.'}
            </p>
          )}
          {!lastScored && settled > 0 && (
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <SealStamp voided label="Last round voided" />
            </div>
          )}
        </>
      )}

      <div className="row result__links">
        <Link className="btn btn--small" to={`/audit/${key}`}>Audit</Link>
        <Link className="btn btn--small" to={`/standings/${key}`}>Standings</Link>
        <Link className="btn btn--small" to={me && mine ? '/record' : shown ? `/record/${shown.player.toBase58()}` : '/record'}>
          Record
        </Link>
      </div>
    </div>
  )
}
