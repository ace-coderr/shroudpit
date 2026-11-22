import { Link } from 'react-router-dom'
import { STATUS_LABEL } from '../lib/config'
import { short, useLeagues } from '../lib/hooks'
import Skeleton from '../components/Skeleton'

/** The Desk and Standings tabs need a league: this lists every league so one can be picked. */
export default function LeagueIndex({ target }: { target: 'desk' | 'standings' }) {
  const { data, error, loading } = useLeagues()
  const title = target === 'desk' ? 'Pick a desk' : 'Pick a league'
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
      {error && <p className="notice notice--bad">Could not read leagues: {error}</p>}
      {loading && <Skeleton count={2} height="5rem" />}
      {data && data.length === 0 && <p className="empty">No leagues exist yet. <Link to="/create">Create the first one.</Link></p>}
      <ul className="cards">
        {data?.map((l, i) => (
          <li key={l.key.toBase58()} className="card enter" style={{ ['--i' as string]: i }}>
            <div className="card__head">
              <span className={`tag${l.status === 2 ? ' tag--live' : ''}`}>{STATUS_LABEL[l.status]}</span>
              <span className="mono small">{short(l.key.toBase58(), 5, 5)}</span>
            </div>
            <Link className="btn btn--ink" to={`/${target}/${l.key.toBase58()}`}>
              {target === 'desk' ? 'Open desk' : 'Open standings'}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
