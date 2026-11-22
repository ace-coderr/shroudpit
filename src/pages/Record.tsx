import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PublicKey } from '@solana/web3.js'
import { claimTrophy } from '../lib/actions'
import { fetchCardsForPlayer, fetchLeagues, fetchTrophies, trophyClaimed } from '../lib/chain'
import { STATUS_LABEL, explorerAddress } from '../lib/config'
import { leagueName } from '../lib/format'
import { usePoll } from '../lib/hooks'
import { useSigner } from '../lib/wallet'
import Addr from '../components/Addr'
import CopyField from '../components/CopyField'
import Shroud from '../components/Shroud'
import Skeleton from '../components/Skeleton'
import StatusBadge from '../components/StatusBadge'

const Cup = () => (
  <svg className="icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3M12 14v4M8 20h8" />
  </svg>
)

/** A wallet's verifiable track record from committed score cards. Works for any wallet: /record/<address>. */
export default function Record() {
  const { wallet: viewed } = useParams()
  const signer = useSigner()
  const pk = useMemo(() => {
    if (viewed) {
      try {
        return new PublicKey(viewed)
      } catch {
        return null
      }
    }
    return signer?.publicKey ?? null
  }, [viewed, signer?.publicKey])
  const own = !!pk && !!signer && signer.publicKey.equals(pk)

  const rec = usePoll(
    async () => {
      if (!pk) return []
      const [cards, leagues] = await Promise.all([fetchCardsForPlayer(pk), fetchLeagues()])
      const byKey = new Map(leagues.map((l) => [l.key.toBase58(), l]))
      return cards
        .map((card) => ({ card, league: byKey.get(card.league.toBase58()) }))
        .filter((r) => r.league)
        .sort((a, b) => Number(b.league!.id) - Number(a.league!.id))
    },
    20_000,
    [pk?.toBase58()],
  )
  const [claimMsg, setClaimMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [claiming, setClaiming] = useState<string | null>(null)

  // trophies the wallet really holds, and finished leagues it won but has not claimed yet
  const trophies = usePoll(
    async () => {
      if (!pk) return { held: [], claimable: [] }
      const leagues = await fetchLeagues()
      const held = await fetchTrophies(pk, leagues)
      const won = leagues.filter((l) => l.status === 4 && l.winner.equals(pk))
      const claimed = await Promise.all(won.map((l) => trophyClaimed(l.key)))
      return { held, claimable: won.filter((_, i) => !claimed[i]) }
    },
    20_000,
    [pk?.toBase58()],
  )

  async function claim(league: PublicKey) {
    if (!signer) return
    setClaiming(league.toBase58())
    setClaimMsg(null)
    try {
      await claimTrophy(signer, league)
      setClaimMsg({ ok: true, text: 'Trophy claimed. It is now in your wallet.' })
      await trophies.refresh()
    } catch (e) {
      setClaimMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setClaiming(null)
    }
  }

  const rows = rec.data ?? []
  const scored = rows.filter((r) => r.card.roundsScored > 0)
  const wins = rows.filter((r) => r.league!.status === 4 && pk && r.league!.winner.equals(pk)).length
  const totalRounds = scored.reduce((n, r) => n + r.card.roundsScored, 0)
  const best = scored.length ? Math.max(...scored.map((r) => r.card.rating)) : null
  const shareUrl = pk ? `${window.location.origin}${window.location.pathname}#/record/${pk.toBase58()}` : ''

  return (
    <section className="page">
      <header className="page__head">
        <span className="caption">Skill record</span>
        <h1>{pk ? 'Record' : 'Your record'}</h1>
        {pk && <div className="row"><Addr value={pk.toBase58()} /></div>}
        <p className="page__lede">
          A record anyone can verify: every figure is read from committed devnet score cards, and every league links to its audit page.
        </p>
      </header>

      {!pk && !viewed && <p className="notice">Connect a wallet to see its record, or open a shared record link.</p>}
      {viewed && !pk && <p className="notice notice--bad">That wallet address is not valid.</p>}

      {pk && (
        <>
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <dl className="facts facts--big">
              <div><dt>Leagues played</dt><dd>{rec.loading ? '…' : rows.length}</dd></div>
              <div><dt>Rounds scored</dt><dd>{rec.loading ? '…' : totalRounds}</dd></div>
              <div><dt>Leagues won</dt><dd>{rec.loading ? '…' : wins}</dd></div>
              <div><dt>Best rating</dt><dd>{rec.loading ? '…' : best ?? '-'}</dd></div>
            </dl>
            <div style={{ marginTop: '1rem' }}>
              <CopyField label="Shareable link" value={shareUrl} />
            </div>
          </div>

          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div className="card__head"><h3>Trophies</h3></div>
            {trophies.loading && <Skeleton count={1} height="5rem" />}
            {!trophies.loading && (trophies.data?.held.length ?? 0) === 0 && (trophies.data?.claimable.length ?? 0) === 0 && (
              <div className="stack">
                <Shroud revealed={false} bare caption="no trophy yet" />
                <p className="muted small">The winner of a finished league can claim one here.</p>
              </div>
            )}
            <div className="stack">
              {trophies.data?.held.map((h, i) => (
                <div key={h.mint.toBase58()} className="trophy enter" style={{ ['--i' as string]: i }}>
                  <span className="trophy__disc"><Cup /></span>
                  <div className="stack" style={{ gap: '0.3rem' }}>
                    <StatusBadge kind="revealed" label="Held · confirmed on-chain" />
                    <Link className="small" to={`/audit/${h.league.key.toBase58()}`}>{leagueName(h.league.key.toBase58())}</Link>
                    <span className="small">Token <Addr value={h.mint.toBase58()} href={explorerAddress(h.mint.toBase58())} /></span>
                  </div>
                </div>
              ))}
              {trophies.data?.claimable.map((l) => (
                <div key={l.key.toBase58()} className="trophy">
                  <span className="trophy__disc" style={{ background: 'var(--paper)', color: 'var(--ink)' }}><Cup /></span>
                  <div className="stack" style={{ gap: '0.4rem' }}>
                    <StatusBadge kind="sealed" label="Won · unclaimed" />
                    <span className="small">{leagueName(l.key.toBase58())}</span>
                    {own ? (
                      <button className="btn btn--primary btn--small" disabled={claiming === l.key.toBase58()} onClick={() => void claim(l.key)}>
                        {claiming === l.key.toBase58() ? 'Waiting for signature…' : 'Claim trophy (about 0.0026 SOL)'}
                      </button>
                    ) : (
                      <span className="muted small">Only this wallet can claim it.</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {claimMsg && <p className={`notice ${claimMsg.ok ? 'notice--ok' : 'notice--bad'}`} style={{ marginTop: '0.75rem' }}>{claimMsg.text}</p>}
          </div>

          {rec.error && <p className="notice notice--bad">{rec.error}</p>}
          {rec.loading && <Skeleton count={2} height="4rem" />}
          {!rec.loading && rows.length === 0 && <p className="empty">No leagues yet. Join one from the <Link to="/">lobby</Link>.</p>}

          {rows.length > 0 && (
            <table className="dtable">
              <thead><tr><th>League</th><th>State</th><th>Rating</th><th>Last return</th><th>Result</th></tr></thead>
              <tbody>
                {rows.map(({ card, league: l }) => (
                  <tr key={card.key.toBase58()}>
                    <td data-label="League"><Link to={`/audit/${l!.key.toBase58()}`}>{leagueName(l!.key.toBase58())}</Link></td>
                    <td data-label="State"><span className="tag">{STATUS_LABEL[l!.status]}</span></td>
                    <td data-label="Rating" className="mono">{card.roundsScored > 0 ? card.rating : '-'}</td>
                    <td data-label="Last return" className="mono">{card.roundsScored > 0 ? `${(card.lastRetBps / 100).toFixed(2)}%` : '-'}</td>
                    <td data-label="Result">
                      {l!.status === 4 && l!.winner.equals(pk) ? <span className="tag tag--live">winner</span> : <span className="muted small">{card.roundsScored > 0 ? 'scored' : 'not scored yet'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  )
}
