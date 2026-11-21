import type { LeagueView } from '../lib/chain'
import { mmss, useNow } from '../lib/hooks'

/**
 * The close time is random and hidden, so the clock is deliberately fuzzy: it shows how long the
 * round has run and the window the close can fall in, never the close itself. After the earliest
 * possible close the window turns into a redaction hatch and the label says "any moment".
 */
export default function RoundClock({ league }: { league: LeagueView }) {
  const now = useNow(250)
  const { status, minSecs, maxSecs, roundStartedAt } = league

  if (status === 5) {
    const left = league.nonceDeadline - now
    return (
      <div className="clock">
        <p className="clock__label">Sealing nonces</p>
        <p className="clock__big mono">{left > 0 ? mmss(left) : '00:00'}</p>
        <p className="muted">
          {league.nonceCount}/{league.playerCount} players have sealed a private nonce. The close time is
          derived from them, so none of us can choose it.
        </p>
      </div>
    )
  }
  if (status === 1) {
    return (
      <div className="clock">
        <p className="clock__label">Drawing randomness</p>
        <p className="clock__big mono">··:··</p>
        <p className="muted">The close time is being derived. It will stay hidden.</p>
      </div>
    )
  }
  if (status !== 2) {
    return (
      <div className="clock">
        <p className="clock__label">{status === 0 ? 'Not started' : status === 3 ? 'Round settled' : 'League finished'}</p>
        <p className="clock__big mono">--:--</p>
      </div>
    )
  }

  const elapsed = Math.max(0, now - roundStartedAt)
  const pct = (s: number) => `${Math.min(100, (s / maxSecs) * 100)}%`
  const hot = elapsed >= minSecs
  return (
    <div className={`clock${hot ? ' clock--hot' : ''}`} aria-live="off">
      <p className="clock__label">Round running</p>
      <p className="clock__big mono">{mmss(elapsed)}</p>
      <div className="clock__track" role="img" aria-label={`The round closes at a hidden moment between ${mmss(minSecs)} and ${mmss(maxSecs)}`}>
        <div className="clock__safe" style={{ width: pct(minSecs) }} />
        <div className="clock__fuzz" style={{ left: pct(minSecs), width: `calc(${pct(maxSecs)} - ${pct(minSecs)})` }} />
        <div className="clock__now" style={{ left: pct(Math.min(elapsed, maxSecs)) }} />
      </div>
      <div className="clock__scale mono">
        <span>00:00</span>
        <span>{mmss(minSecs)}</span>
        <span>{mmss(maxSecs)}</span>
      </div>
      <p className="muted">
        {hot
          ? 'The close can fall at any moment now. Adjust positions while you can.'
          : `The earliest possible close is ${mmss(minSecs)}; the latest is ${mmss(maxSecs)}. The real moment is hidden.`}
      </p>
    </div>
  )
}
