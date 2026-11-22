import type { LeagueView } from '../lib/chain'
import { mmss, useNow } from '../lib/hooks'

const WINDOW_SECS = 60 // the program's settlement window after the hidden close

/**
 * Settlement needs an open desk: any desk, with a throwaway key, but at least one. The close is
 * hidden, so the banner counts to the earliest moment the window can end, which is the earliest
 * possible close plus the 60 s window, and says plainly when that moment has passed.
 */
export default function SettleBanner({ league, helperOn }: { league: LeagueView; helperOn: boolean }) {
  const now = useNow(1000)
  if (league.status === 6) {
    return (
      <div className="banner" role="status">
        <strong>Keep this tab open: the reveal needs an open desk.</strong>
        <span className="small">
          {helperOn ? 'This tab is publishing the entries and finishing the league.' : 'The helper below is off. Turn it on so this tab can finish the reveal.'}
        </span>
      </div>
    )
  }
  if (league.status !== 2) return null

  const elapsed = now - league.roundStartedAt
  const opens = league.roundStartedAt + league.minSecs - now // seconds until the earliest possible close
  const earliestEnd = league.roundStartedAt + league.minSecs + WINDOW_SECS - now
  const latestEnd = league.roundStartedAt + league.maxSecs + WINDOW_SECS - now

  let timer: string
  if (opens > 0) timer = `The window can open in ${mmss(opens)}.`
  else if (earliestEnd > 0) timer = `Window open. A round that closed at the earliest moment is voided in ${mmss(earliestEnd)} if nobody settles.`
  else if (latestEnd > 0) timer = `The earliest-close window has passed. Every possible window ends in ${mmss(latestEnd)}.`
  else timer = 'Every possible window has passed. The next settle call will void this round.'

  return (
    <div className={`banner${opens <= 0 ? ' banner--hot' : ''}`} role="status" aria-live="polite" data-elapsed={Math.floor(elapsed)}>
      <strong>Keep this tab open: settlement needs an open desk.</strong>
      <span className="small">
        {helperOn ? timer : 'The helper below is off, so this tab will not settle. Turn it on. ' + timer}
      </span>
    </div>
  )
}
