import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { STATUS_LABEL } from '../lib/config'
import type { LeagueView } from '../lib/chain'
import { leagueName } from '../lib/format'
import Addr from './Addr'

const I = ({ d }: { d: string }) => (
  <svg className="icon navicon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)
const icons = {
  desk: 'M4 7h16v11H4zM8 7V4h8v3',
  standings: 'M5 20V10M12 20V4M19 20v-7',
  audit: 'M9 12l2 2 4-4M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z',
  record: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
}

/**
 * Wraps the league pages: a black sidebar on desktop, a bottom tab bar on phones. The tabs follow
 * the league being viewed; Record is the wallet's own page.
 */
export default function DeskShell({ league, children }: { league: LeagueView | null; children: ReactNode }) {
  const key = league?.key.toBase58()
  const items = [
    { to: key ? `/desk/${key}` : '/desk', label: 'Desk', icon: icons.desk },
    { to: key ? `/standings/${key}` : '/standings', label: 'Standings', icon: icons.standings },
    { to: key ? `/audit/${key}` : '/desk', label: 'Audit', icon: icons.audit },
    { to: '/record', label: 'Record', icon: icons.record },
  ]
  const links = items.map((it) => (
    <NavLink key={it.label} to={it.to} className={({ isActive }) => (isActive ? 'is-active' : '')}>
      <I d={it.icon} />
      {it.label}
    </NavLink>
  ))
  return (
    <div className="deskshell">
      <aside className="sidebar" aria-label="League">
        <div className="sidebar__league">
          <span className="caption">League</span>
          <h2>{league ? leagueName(league.key.toBase58()) : '…'}</h2>
          {league && (
            <>
              <Addr value={league.key.toBase58()} />
              <span className="small">
                {STATUS_LABEL[league.status]} · round {Math.min(league.round + 1, league.nRounds)}/{league.nRounds}
              </span>
            </>
          )}
        </div>
        <nav>{links}</nav>
      </aside>
      <div className="deskshell__body">{children}</div>
      <nav className="tabbar" aria-label="League tabs">{links}</nav>
    </div>
  )
}
