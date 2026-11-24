import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PublicKey } from '@solana/web3.js'
import { claimTrophy } from '../lib/actions'
import { fetchRecord } from '../lib/chain'
import type { CardView, LeagueView } from '../lib/chain'
import { STATUS_LABEL, explorerAddress } from '../lib/config'
import { fmtUtc, leagueName } from '../lib/format'
import { usePoll } from '../lib/hooks'
import { useSigner } from '../lib/wallet'
import Addr from '../components/Addr'
import CopyField from '../components/CopyField'
import LoadFailed from '../components/LoadFailed'
import Switch from '../components/Switch'
import Shroud from '../components/Shroud'
import Skeleton from '../components/Skeleton'
import StatusBadge from '../components/StatusBadge'

const ordinal = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`)

/**
 * Placement and outcome from real data. The winner is recorded on chain, so "1st of N · won" is exact.
 * Other players' exact places need every card of the league, which this page does not read: it says
 * "2nd of 2 · lost" only when the league had two players, and "lost" otherwise.
 */
function Outcome({ card, league, pk }: { card: CardView; league: LeagueView; pk: PublicKey }) {
  if (league.status !== 4) return <span className="muted small">{card.roundsScored > 0 ? 'scored' : 'not scored yet'}</span>
  const date = league.settleTime > 0 ? fmtUtc(league.settleTime).split(', ')[0] : null
  const n = league.playerCount
  const won = league.winner.equals(pk)
  let text: string
  if (card.roundsScored === 0) text = 'voided'
  else if (won) text = `${ordinal(1)} of ${n} · won`
  else if (n === 2) text = `${ordinal(2)} of 2 · lost`
  else text = `lost · ${n} players`
  return (
    <div>
      {won && card.roundsScored > 0 ? <span className="tag tag--live">{text}</span> : <span className="small">{text}</span>}
      {date && <div className="muted small">finished {date}</div>}
    </div>
  )
}

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

  // One read for the page: cards, leagues and trophies in a small fixed burst (see fetchRecord).
  const rec = usePoll(() => (pk ? fetchRecord(pk) : Promise.resolve(null)), 20_000, [pk?.toBase58()])
  const [finishedOnly, setFinishedOnly] = useState(true)
  const [claimMsg, setClaimMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [claiming, setClaiming] = useState<string | null>(null)

  async function claim(league: PublicKey) {
    if (!signer) return
    setClaiming(league.toBase58())
    setClaimMsg(null)
    try {
      await claimTrophy(signer, league)
      setClaimMsg({ ok: true, text: 'Trophy claimed. It is now in your wallet.' })
      await rec.refresh()
    } catch (e) {
      setClaimMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setClaiming(null)
    }
  }

  const data = rec.data
  const rows = data?.rows ?? []
  // The headline stats count finished leagues only. The switch only changes the table; nothing is removed.
  const finishedRows = rows.filter((r) => r.league.status === 4)
  const shownRows = finishedOnly ? finishedRows : rows
  // never a zero or an empty state while the data is missing: a dash if the load failed, an ellipsis while loading
  const stat = (v: string | number) => (data ? v : rec.failed ? '–' : '…')
  const scored = finishedRows.filter((r) => r.card.roundsScored > 0)
  const wins = finishedRows.filter((r) => pk && r.league.winner.equals(pk)).length
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
              <div><dt>Finished leagues</dt><dd>{stat(finishedRows.length)}</dd></div>
              <div><dt>Rounds scored</dt><dd>{stat(totalRounds)}</dd></div>
              <div><dt>Leagues won</dt><dd>{stat(wins)}</dd></div>
              <div><dt>Best rating</dt><dd>{stat(best ?? '-')}</dd></div>
            </dl>
            <p className="muted small" style={{ marginTop: '0.6rem' }}>
              {data ? `${finishedRows.length} finished league${finishedRows.length === 1 ? '' : 's'}. ` : ''}These figures count finished leagues only.
            </p>
            <div style={{ marginTop: '1rem' }}>
              <CopyField label="Shareable link" value={shareUrl} />
            </div>
          </div>

          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div className="card__head"><h3>Trophies</h3></div>
            {!data && !rec.failed && <Skeleton count={1} height="5rem" />}
            {!data && rec.failed && <p className="muted small">Trophies could not be loaded yet.</p>}
            {data && data.held.length === 0 && data.claimable.length === 0 && (
              <div className="stack">
                <Shroud revealed={false} bare caption="no trophy yet" />
                <p className="muted small">The winner of a finished league can claim one here.</p>
              </div>
            )}
            <div className="stack">
              {data?.held.map((h, i) => (
                <div key={h.mint.toBase58()} className="trophy enter" style={{ ['--i' as string]: i }}>
                  <span className="trophy__disc"><Cup /></span>
                  <div className="stack" style={{ gap: '0.3rem' }}>
                    <StatusBadge kind="revealed" label="Held · confirmed on-chain" />
                    <Link className="small" to={`/audit/${h.league.key.toBase58()}`}>{leagueName(h.league.key.toBase58())}</Link>
                    <span className="small">Token <Addr value={h.mint.toBase58()} href={explorerAddress(h.mint.toBase58())} /></span>
                  </div>
                </div>
              ))}
              {data?.claimable.map((l) => (
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

          {rec.error && <LoadFailed error={rec.error} busy={rec.busy} onRetry={() => void rec.refresh()} stale={!!data} />}
          {!data && !rec.failed && <Skeleton count={2} height="4rem" />}
          {data && rows.length === 0 && <p className="empty">No leagues yet. Join one from the <Link to="/">lobby</Link>.</p>}

          {rows.length > 0 && (
            <div className="row" style={{ justifyContent: 'space-between', margin: '0 0 0.75rem' }}>
              <span className="muted small">{rows.length} league{rows.length === 1 ? '' : 's'}, {finishedRows.length} finished</span>
              <Switch
                label="Which leagues to list"
                value={finishedOnly ? 'finished' : 'all'}
                onChange={(v) => setFinishedOnly(v === 'finished')}
                options={[{ value: 'finished', label: 'Finished only' }, { value: 'all', label: 'All leagues' }]}
              />
            </div>
          )}
          {rows.length > 0 && shownRows.length === 0 && (
            <p className="empty">No finished leagues yet. Switch to "All leagues" to see the {rows.length} unfinished.</p>
          )}

          {shownRows.length > 0 && (
            <table className="dtable">
              <thead><tr><th>League</th><th>State</th><th>Rating</th><th>Last return</th><th>Result</th></tr></thead>
              <tbody>
                {shownRows.map(({ card, league: l }) => (
                  <tr key={card.key.toBase58()}>
                    <td data-label="League"><Link to={`/audit/${l!.key.toBase58()}`}>{leagueName(l!.key.toBase58())}</Link></td>
                    <td data-label="State"><span className="tag">{STATUS_LABEL[l!.status]}</span></td>
                    <td data-label="Rating" className="mono">{card.roundsScored > 0 ? card.rating : '-'}</td>
                    <td data-label="Last return" className="mono">{card.roundsScored > 0 ? `${(card.lastRetBps / 100).toFixed(2)}%` : '-'}</td>
                    <td data-label="Result">
                      <Outcome card={card} league={l!} pk={pk} />
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
