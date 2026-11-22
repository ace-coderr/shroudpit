import type { LeagueView } from '../lib/chain'
import { fmtUtc, lastRoundScored } from '../lib/format'
import { mmss, useNow } from '../lib/hooks'

/**
 * The close time is hidden, so no close time is ever drawn. The band shows the window the close can
 * still fall in: it is the whole minimum-to-maximum window at the start, and its left edge advances
 * with the clock, so it visibly tightens while it flickers. Once the earliest possible close has
 * passed it turns amber ("any moment").
 */
export default function CloseBand({ league }: { league: LeagueView }) {
  const now = useNow(250)
  const { status, minSecs, maxSecs, roundStartedAt } = league

  if (status === 5) {
    const left = Math.max(0, league.nonceDeadline - now)
    return (
      <div className="stack" aria-live="polite">
        <span className="caption">Sealing nonces</span>
        <div className="clockbig mono">{mmss(left)}</div>
        <p className="muted small">
          {league.nonceCount}/{league.playerCount} players have sealed a private nonce. The close time is derived from
          them, so nobody can choose it.
        </p>
      </div>
    )
  }
  if (status === 1) {
    return (
      <div className="stack">
        <span className="caption">Drawing randomness</span>
        <div className="clockbig mono">··:··</div>
        <p className="muted small">The close time is being derived. It stays hidden.</p>
      </div>
    )
  }
  if (status !== 2) {
    if (status === 3 || status === 4 || status === 6) {
      // Settled: show when. A voided round has no settlement time, so say so instead of a stale one.
      const scored = lastRoundScored(league)
      const label = status === 4 ? 'League finished' : status === 6 ? 'Final round settled, revealing' : 'Round settled'
      return (
        <div className="stack">
          <span className="caption">{label}</span>
          <div className="clockbig mono clockbig--settled">{scored ? fmtUtc(league.settleTime).split(', ')[1] : 'voided'}</div>
          <p className="muted small">
            {scored ? `Settled ${fmtUtc(league.settleTime)}.` : 'Nobody settled inside the window, so this round scored nobody.'}
          </p>
        </div>
      )
    }
    return (
      <div className="stack">
        <span className="caption">Not started</span>
        <div className="clockbig mono">--:--</div>
      </div>
    )
  }

  const elapsed = Math.max(0, now - roundStartedAt)
  const hot = elapsed >= minSecs
  const lo = Math.min(maxSecs, Math.max(elapsed, minSecs))
  const pct = (s: number) => `${(s / maxSecs) * 100}%`
  return (
    <div className={`stack band${hot ? ' band--hot' : ''}`}>
      <span className="caption">{hot ? 'Window open: any moment now' : 'Round running'}</span>
      <div className={`clockbig mono${hot ? ' clockbig--hot' : ''}`}>{mmss(elapsed)}</div>
      <div
        className="band__track"
        role="img"
        aria-label={`The round closes at a hidden moment between ${mmss(minSecs)} and ${mmss(maxSecs)}`}
      >
        <div className="band__past" style={{ width: pct(Math.min(elapsed, maxSecs)) }} />
        <div className="band__window" style={{ left: pct(lo), width: `calc(100% - ${pct(lo)})` }} />
        <div className="band__now" style={{ left: pct(Math.min(elapsed, maxSecs)) }} />
      </div>
      <div className="band__scale">
        <span>00:00</span>
        <span>{mmss(minSecs)}</span>
        <span>{mmss(maxSecs)}</span>
      </div>
      <p className="muted small">
        {hot
          ? 'The earliest possible close has passed. Adjust positions while you can.'
          : `The close falls somewhere in the dark band, between ${mmss(minSecs)} and ${mmss(maxSecs)}. The real moment is hidden.`}
      </p>
    </div>
  )
}
