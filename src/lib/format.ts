import type { CardView, LeagueView } from './chain'

/** The one address format everywhere: first 4 + … + last 4. */
export const shortAddr = (s: string) => (s.length > 9 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s)

/** A short human label for a league: "League FrixzrH…". The phase is shown separately, in a badge. */
export const leagueName = (key: string) => `League ${key.slice(0, 7)}…`

const utc = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/** "22 Nov 2026, 06:46:17 UTC" from a unix time in seconds. */
export const fmtUtc = (unix: number) => `${utc.format(new Date(unix * 1000))} UTC`

/** "06:46:17 UTC" from a unix time in seconds. */
export const fmtClockUtc = (unix: number) => fmtUtc(unix).split(', ')[1]

/** Whether the most recently settled round was scored (a voided round leaves settleTime behind). */
export const lastRoundScored = (l: LeagueView) => l.round >= 1 && l.settleTime > 0 && l.settleTime >= l.roundStartedAt

/**
 * Rank score cards: highest rating first. When the league has finished, the winner recorded on chain
 * is placed first, so the order always agrees with the program's tie-break.
 */
export function rankCards(cards: CardView[], winner?: string): CardView[] {
  const sorted = [...cards].sort((a, b) => b.rating - a.rating || (a.player.toBase58() < b.player.toBase58() ? -1 : 1))
  if (!winner) return sorted
  const i = sorted.findIndex((c) => c.player.toBase58() === winner)
  if (i > 0) sorted.unshift(...sorted.splice(i, 1))
  return sorted
}

/** "1 scored · 1 voided", from real counts. */
export const scoredVoided = (scored: number, settled: number) => {
  const voided = Math.max(0, settled - scored)
  return `${scored} scored${voided > 0 ? ` · ${voided} voided` : ''}`
}
