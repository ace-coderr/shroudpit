import { Link } from 'react-router-dom'
import { fetchEntriesForPlayer, fetchLeagues } from '../lib/chain'
import { STATUS_LABEL } from '../lib/config'
import { short, usePoll } from '../lib/hooks'
import { useSigner } from '../lib/wallet'

/** The connected wallet's verifiable track record, assembled from committed on-chain entries. */
export default function Record() {
  const signer = useSigner()
  const pk = signer?.publicKey
  const rec = usePoll(
    async () => {
      if (!pk) return []
      const [entries, leagues] = await Promise.all([fetchEntriesForPlayer(pk), fetchLeagues()])
      const byKey = new Map(leagues.map((l) => [l.key.toBase58(), l]))
      return entries
        .map((e) => ({ entry: e, league: byKey.get(e.league.toBase58()) }))
        .filter((r) => r.league)
        .sort((a, b) => Number(b.league!.id) - Number(a.league!.id))
    },
    20_000,
    [pk?.toBase58()],
  )

  const rows = rec.data ?? []
  const scored = rows.filter((r) => r.entry.roundsScored > 0)
  const wins = rows.filter((r) => r.league!.status === 4 && r.league!.winner.equals(pk!)).length
  const totalRounds = scored.reduce((n, r) => n + r.entry.roundsScored, 0)

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Skill Record</p>
        <h1 className="page__title">{pk ? short(pk.toBase58(), 6, 6) : 'Your record'}</h1>
        <p className="page__lede">
          A record anyone can verify: every figure is read from committed devnet accounts, and every league
          links to its audit page.
        </p>
      </header>

      {!pk && <p className="notice">Connect a wallet to see its record.</p>}
      {pk && (
        <dl className="facts facts--big">
          <div><dt>Leagues played</dt><dd className="mono">{rows.length}</dd></div>
          <div><dt>Rounds scored</dt><dd className="mono">{totalRounds}</dd></div>
          <div><dt>Leagues won</dt><dd className="mono">{wins}</dd></div>
        </dl>
      )}
      {rec.error && <p className="notice notice--bad">{rec.error}</p>}
      {pk && rows.length === 0 && !rec.loading && <p className="empty">No leagues yet. Join one from the <Link to="/lobby">lobby</Link>.</p>}

      <ol className="table">
        {rows.map(({ entry: e, league: l }) => (
          <li key={e.key.toBase58()}>
            <span className="grow">
              <Link className="mono" to={`/audit/${l!.key.toBase58()}`}>{short(l!.key.toBase58(), 5, 5)}</Link>{' '}
              <span className="muted">· {STATUS_LABEL[l!.status]}</span>
            </span>
            <span className="mono">{e.roundsScored > 0 ? `rating ${e.rating}` : 'not scored yet'}</span>
            <span className="mono muted">{e.roundsScored > 0 ? `last ${(e.lastRetBps / 100).toFixed(2)}%` : ''}</span>
            {l!.status === 4 && l!.winner.equals(pk!) && <span className="badge badge--4">Winner</span>}
          </li>
        ))}
      </ol>
    </section>
  )
}
