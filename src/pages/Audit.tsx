import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { PublicKey } from '@solana/web3.js'
import { finishLeague, helperConnection, helperKeypair, revealEntries } from '../lib/actions'
import { baseConnection, fetchCards, fetchEntries, fetchSecretBase, secretPda } from '../lib/chain'
import type { EntryView, LeagueView, SecretView } from '../lib/chain'
import { CLOSE_MODE_LABEL, STATUS_LABEL, explorerAddress, explorerTx } from '../lib/config'
import { fmtUtc, leagueName, rankCards } from '../lib/format'
import { hex, short, useLeague, usePoll } from '../lib/hooks'
import { labelTransactions } from '../lib/settlement'
import Addr from '../components/Addr'
import LoadFailed from '../components/LoadFailed'
import CopyField from '../components/CopyField'
import DeskShell from '../components/DeskShell'
import SealStamp from '../components/SealStamp'
import Skeleton from '../components/Skeleton'
import StatusBadge from '../components/StatusBadge'

const sha256 = async (parts: Uint8Array[]) => {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const buf = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    buf.set(p, at)
    at += p.length
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
}
const le = (n: number | bigint, bytes: number) => {
  const b = new Uint8Array(bytes)
  const dv = new DataView(b.buffer)
  if (bytes === 2) dv.setUint16(0, Number(n), true)
  else dv.setBigUint64(0, BigInt(n), true)
  return b
}
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])
const keyOrder = (a: EntryView, b: EntryView) => {
  const x = a.key.toBytes()
  const y = b.key.toBytes()
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/** Recompute one round's close time exactly as the program does, from values revealed at the end. */
async function recomputeRound(league: LeagueView, secret: SecretView, entries: EntryView[], round: number) {
  const rs = secret.history[round]
  const parts: Uint8Array[] = [league.key.toBytes(), le(rs.epoch, 2), le(rs.lockSlot, 8)]
  for (const e of [...entries].sort(keyOrder)) {
    const h = e.history[round]
    if (h.committed) parts.push(e.player.toBytes(), h.nonce)
  }
  const base = await sha256(parts)
  const baseOk = eq(base, rs.baseSeed)
  const seed = rs.vrfUsed ? await sha256([rs.baseSeed, rs.randomness]) : base
  const span = BigInt(league.maxSecs - league.minSecs + 1)
  const offset = new DataView(seed.buffer, seed.byteOffset, 8).getBigUint64(0, true) % span
  const closeAt = BigInt(rs.startedAt) + BigInt(league.minSecs) + offset
  return { baseOk, closeOk: closeAt === BigInt(rs.closeAt), recomputed: hex(base), closeAt: closeAt.toString() }
}

const CHUNK = 4

export default function Audit() {
  const { league: addr } = useParams()
  const key = useMemo(() => {
    try {
      return addr ? new PublicKey(addr) : null
    } catch {
      return null
    }
  }, [addr])
  const { data: league, error: leagueError, busy: leagueBusy, failed: leagueFailed, refresh: refreshLeague } = useLeague(key, 5000)
  const cards = usePoll(() => (key ? fetchCards(key, league?.playerCount) : Promise.resolve([])), 12_000, [key?.toBase58(), league?.playerCount])
  const finished = league?.status === 4
  // positions, nonces and close times exist on the base layer only after the final reveal
  const entries = usePoll(() => (key && finished ? fetchEntries(key, league?.playerCount) : Promise.resolve([])), 15_000, [key?.toBase58(), finished, league?.playerCount])
  const secret = usePoll(() => (key && finished ? fetchSecretBase(key) : Promise.resolve(null)), 15_000, [key?.toBase58(), finished])
  const sigs = usePoll(async () => (key ? baseConnection.getSignaturesForAddress(key, { limit: 25 }) : []), 20_000, [key?.toBase58()])
  const [params] = useSearchParams()
  const focus = params.get('wallet')
  const labelled = usePoll(
    async () => {
      if (!sigs.data) return []
      const sortedForVoid = [...(entries.data ?? [])]
      const voidedRounds: number[] = []
      if (league && sortedForVoid.length > 0) {
        for (let r = 0; r < league.round; r++) if (sortedForVoid.every((e) => !e.history[r]?.scored)) voidedRounds.push(r + 1)
      }
      return labelTransactions(sigs.data, { finished: !!finished, voidedRounds })
    },
    20_000,
    [sigs.data?.[0]?.signature, sigs.data?.length, finished, entries.data?.length, league?.round],
  )
  const check = usePoll(
    async () => {
      if (!league || !secret.data || !entries.data?.length) return null
      const out = []
      for (let r = 0; r < league.round; r++) out.push({ round: r, ...(await recomputeRound(league, secret.data, entries.data, r)) })
      return out
    },
    30_000,
    [league?.round, secret.data?.history.length, entries.data?.length],
  )

  const [newestFirst, setNewestFirst] = useState(false) // default: oldest first
  const [revealBusy, setRevealBusy] = useState(false)
  const [revealErr, setRevealErr] = useState<string | null>(null)
  async function revealNext() {
    if (!key || !league) return
    setRevealBusy(true)
    setRevealErr(null)
    try {
      const conn = await helperConnection()
      const kp = helperKeypair()
      if (league.revealedCount < league.playerCount) await revealEntries(kp, conn, key, league.revealedCount)
      else await finishLeague(kp, conn, key)
    } catch (e) {
      setRevealErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRevealBusy(false)
    }
  }

  // arriving from a Standings row: bring that wallet's rating row into view
  const cardCount = cards.data?.length ?? 0
  useEffect(() => {
    if (focus && cardCount > 0) document.getElementById(`wallet-${focus}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focus, cardCount])

  if (!key) return <section className="page"><p className="notice notice--bad">That league address is not valid.</p></section>
  if (leagueFailed && leagueError) return <section className="page"><LoadFailed error={leagueError} busy={leagueBusy} onRetry={() => void refreshLeague()} /></section>
  const revealed = finished && !!secret.data && secret.data.history[0].closeAt > 0
  const ranked = rankCards(cards.data ?? [], finished && league ? league.winner.toBase58() : undefined)
  const sortedEntries = [...(entries.data ?? [])].sort(keyOrder)
  const totalChunks = league ? Math.max(1, Math.ceil(league.playerCount / CHUNK)) : 1
  const doneChunks = league ? Math.min(totalChunks, Math.floor(league.revealedCount / CHUNK) + (league.revealedCount >= league.playerCount && league.playerCount % CHUNK ? 1 : 0)) : 0
  const allVerified = !!check.data?.length && check.data.every((c) => c.baseOk && c.closeOk)

  return (
    <DeskShell league={league ?? null}>
      <section className="page">
        <header className="page__head">
          <span className="caption">Reveal and audit</span>
          <h1>{finished ? 'Final scores' : key ? leagueName(key.toBase58()) : 'Ledger'}</h1>
          <p className="page__lede">
            Scores are public after every round. Positions, nonces and close times stay sealed until the final round settles, then all of it is
            published here with the transactions that prove it. Everything on this page is read from Solana devnet.
          </p>
          <div className="row">
            {league && <span className="tag">{STATUS_LABEL[league.status]}</span>}
            <Addr value={key.toBase58()} />
            {revealed && <SealStamp label="Revealed" />}
            <a className="btn btn--small" href={explorerAddress(key.toBase58())} target="_blank" rel="noreferrer">League on Explorer</a>
            <Link className="btn btn--small btn--ghost" to={`/standings/${key.toBase58()}`}>Standings</Link>
          </div>
        </header>

        {!league && <Skeleton count={2} height="8rem" />}

        {league?.status === 6 && (
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div className="card__head"><h3>Final reveal in progress</h3><StatusBadge kind="sealed" label="Revealing" /></div>
            <p className="muted small">
              One commit can carry about 2.7 KB, so entries are published four at a time, then the league finishes. Any open desk does this
              automatically; you can also run the next step here.
            </p>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={totalChunks} aria-valuenow={doneChunks} style={{ margin: '0.75rem 0' }}>
              <i style={{ width: `${(doneChunks / totalChunks) * 100}%` }} />
            </div>
            <p className="mono small">Chunk {Math.min(doneChunks + 1, totalChunks)} of {totalChunks} · {league.revealedCount}/{league.playerCount} entries revealed</p>
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <button className="btn btn--primary" disabled={revealBusy} onClick={() => void revealNext()}>
                {revealBusy ? 'Revealing…' : league.revealedCount < league.playerCount ? 'Reveal next chunk' : 'Finish league'}
              </button>
            </div>
            {revealErr && (
              <div className="notice notice--bad" style={{ marginTop: '0.75rem' }}>
                <p>The reveal step failed: {revealErr}</p>
                <button className="btn btn--small" style={{ marginTop: '0.5rem' }} onClick={() => void revealNext()} disabled={revealBusy}>Retry</button>
              </div>
            )}
          </div>
        )}

        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="card__head"><h3>{finished ? 'Final scores' : 'Scores so far'}</h3><StatusBadge kind="revealed" label="Public each round" /></div>
          {cards.error && <LoadFailed error={cards.error} busy={cards.busy} onRetry={() => void cards.refresh()} stale={!!cards.data} />}
          {!cards.data && !cards.failed && <Skeleton count={1} height="5rem" />}
          {cards.data && ranked.every((c) => c.roundsScored === 0) && <p className="empty">No round has settled yet.</p>}
          {ranked.some((c) => c.roundsScored > 0) && (
            <table className="dtable">
              <thead><tr><th>Wallet</th><th>Rounds</th><th>Last return</th><th>Rating</th></tr></thead>
              <tbody>
                {ranked.filter((c) => c.roundsScored > 0).map((c) => (
                  <tr key={c.key.toBase58()} id={`wallet-${c.player.toBase58()}`} className={focus === c.player.toBase58() ? 'is-focus' : undefined}>
                    <td data-label="Wallet"><Addr value={c.player.toBase58()} to={`/record/${c.player.toBase58()}`} /></td>
                    <td data-label="Rounds" className="mono">{c.roundsScored}</td>
                    <td data-label="Last return" className="mono">{(c.lastRetBps / 100).toFixed(2)}%</td>
                    <td data-label="Rating" className="mono">{c.rating}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {league && league.settlePrice > 0 && (
            <p className="muted small" style={{ marginTop: '0.6rem' }}>Latest settlement price ${(league.settlePrice / 1e8).toFixed(4)}, published {fmtUtc(league.settleTime)}.</p>
          )}
        </div>

        {finished && !revealed && (
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div className="card__head"><h3>Positions and close times</h3></div>
            {(entries.failed || secret.failed) ? (
              <LoadFailed error={entries.error ?? secret.error ?? 'Could not load the reveal.'} busy={entries.busy || secret.busy} onRetry={() => { void entries.refresh(); void secret.refresh() }} />
            ) : (
              <Skeleton count={1} height="5rem" />
            )}
          </div>
        )}

        {!finished && (
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div className="card__head"><h3>Positions and close times</h3><StatusBadge kind="unverified" label="Not verified yet" /></div>
            <p className="muted">
              Sealed until the final round. Every position, nonce and close time of every round is published together when the league finishes, so
              an earlier round can never be copied while the league is running. Nothing can be verified before then, and nothing is claimed.
            </p>
          </div>
        )}

        {revealed && league && secret.data && (
          <p className={`notice ${allVerified ? 'notice--ok' : 'notice--warn'}`} role="status" style={{ marginBottom: '1.25rem' }}>
            {allVerified
              ? 'Recomputed in your browser from the revealed nonces: every round’s base seed and close time match the chain.'
              : check.data
                ? 'At least one recomputation does not match the chain. Treat this league as unverified.'
                : 'Recomputing…'}
          </p>
        )}

        {revealed && league && secret.data && Array.from({ length: league.round }, (_, r) => {
          const rs = secret.data!.history[r]
          const ok = check.data?.find((c) => c.round === r)
          const voided = sortedEntries.length > 0 && sortedEntries.every((e) => !e.history[r].scored)
          return (
            <div className="card enter" key={r} style={{ marginBottom: '1.25rem', ['--i' as string]: r }}>
              <div className="card__head">
                <h3>Round {r + 1}</h3>
                <div className="row">
                  {voided ? <StatusBadge kind="voided" /> : <StatusBadge kind="revealed" />}
                  {ok ? <StatusBadge kind={ok.baseOk && ok.closeOk ? 'revealed' : 'unverified'} label={ok.baseOk && ok.closeOk ? 'Confirmed' : 'Not verified'} /> : <StatusBadge kind="unverified" label="Not verified" />}
                </div>
              </div>
              <div className="cmp">
                <div className="cmp__side cmp__side--commit card card--flat">
                  <div className="row"><StatusBadge kind="sealed" label="Committed" /></div>
                  <CopyField label="Base seed" value={hex(rs.baseSeed)} />
                  <dl className="facts">
                    <div><dt>Derivation</dt><dd>{CLOSE_MODE_LABEL[league.closeMode]}</dd></div>
                    <div><dt>VRF mixed in</dt><dd>{rs.vrfUsed ? 'Yes' : 'No'}</dd></div>
                  </dl>
                  {rs.vrfUsed && <CopyField label="VRF output" value={hex(rs.randomness)} />}
                </div>
                <div className="cmp__side card card--flat">
                  <div className="row"><StatusBadge kind="revealed" label="Revealed" /></div>
                  <CopyField label="Recomputed base seed" value={ok?.recomputed ?? '…'} />
                  <dl className="facts">
                    <div><dt>Slot at lock-in</dt><dd className="mono">{rs.lockSlot}</dd></div>
                    <div><dt>Close time</dt><dd className="mono" title={`unix ${rs.closeAt}`}>{fmtUtc(rs.closeAt)}</dd></div>
                    <div><dt>Recomputed close</dt><dd className="mono" title={ok ? `unix ${ok.closeAt}` : undefined}>{ok ? fmtUtc(Number(ok.closeAt)) : '…'}</dd></div>
                  </dl>
                </div>
              </div>
              <table className="dtable" style={{ marginTop: '1rem' }}>
                <thead><tr><th>Wallet</th><th>Closing position</th><th>Return</th><th>Nonce</th><th>State</th></tr></thead>
                <tbody>
                  {sortedEntries.map((e) => {
                    const h = e.history[r]
                    return (
                      <tr key={e.key.toBase58()} className={focus === e.player.toBase58() ? 'is-focus' : undefined}>
                        <td data-label="Wallet"><Addr value={e.player.toBase58()} to={`/record/${e.player.toBase58()}`} /></td>
                        <td data-label="Position" className="mono">{h.side === 0 ? 'Flat' : `${h.side > 0 ? 'Long' : 'Short'} ×${h.leverage} @ $${(h.entryPrice / 1e8).toFixed(4)}`}</td>
                        <td data-label="Return" className="mono">{h.scored ? `${(h.retBps / 100).toFixed(2)}%` : '-'}</td>
                        <td data-label="Nonce" className="mono small">{h.committed ? `${hex(h.nonce).slice(0, 12)}…` : 'none'}</td>
                        <td data-label="State">{h.scored ? <StatusBadge kind="revealed" /> : <StatusBadge kind="voided" />}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        })}

        <div className="card">
          <div className="card__head">
            <h3>League transactions</h3>
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setNewestFirst((v) => !v)}>
              {newestFirst ? 'Newest first · show oldest first' : 'Oldest first · show newest first'}
            </button>
          </div>
          <p className="muted small" style={{ marginBottom: '0.6rem' }}>
            Commits from the Private ER land on devnet. Labels are derived from transaction order and program logs, not stored on chain. <a href={explorerAddress(secretPda(key).toBase58())} target="_blank" rel="noreferrer">Secret account</a>
          </p>
          {(sigs.loading || labelled.loading) && <Skeleton count={1} height="4rem" />}
          <ul className="siglist">
            {(newestFirst ? (labelled.data ?? []) : [...(labelled.data ?? [])].reverse()).map((t) => (
              <li key={t.signature}>
                <strong>{t.label}</strong>
                {t.note && <span className="tag" style={{ marginLeft: '0.4rem' }}>{t.note}</span>}
                {t.failed && <span className="tag tag--warn" style={{ marginLeft: '0.4rem' }}>failed</span>}
                <div className="small">
                  <span className="muted">{t.time ? fmtUtc(t.time) : 'time not available'} · </span>
                  <a className="mono" href={explorerTx(t.signature)} target="_blank" rel="noreferrer">{short(t.signature, 10, 8)}</a>
                </div>
              </li>
            ))}
            {sigs.data?.length === 0 && <li className="empty">No transactions yet.</li>}
          </ul>
        </div>
      </section>
    </DeskShell>
  )
}
