import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PublicKey } from '@solana/web3.js'
import { baseConnection, fetchCards, fetchEntries, fetchSecretBase, secretPda } from '../lib/chain'
import type { EntryView, LeagueView, SecretView } from '../lib/chain'
import { CLOSE_MODE_LABEL, STATUS_LABEL, explorerAddress, explorerTx } from '../lib/config'
import { hex, short, useLeague, usePoll } from '../lib/hooks'

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
  return { baseOk, closeOk: closeAt === BigInt(rs.closeAt) }
}

export default function Audit() {
  const { league: addr } = useParams()
  const key = useMemo(() => {
    try {
      return addr ? new PublicKey(addr) : null
    } catch {
      return null
    }
  }, [addr])
  const { data: league } = useLeague(key, 8000)
  const cards = usePoll(() => (key ? fetchCards(key) : Promise.resolve([])), 12_000, [key?.toBase58()])
  const finished = league?.status === 4
  // positions, nonces and close times exist on the base layer only after the final round commits
  const entries = usePoll(() => (key && finished ? fetchEntries(key) : Promise.resolve([])), 15_000, [key?.toBase58(), finished])
  const secret = usePoll(() => (key && finished ? fetchSecretBase(key) : Promise.resolve(null)), 15_000, [key?.toBase58(), finished])
  const sigs = usePoll(
    async () => (key ? baseConnection.getSignaturesForAddress(key, { limit: 25 }) : []),
    20_000,
    [key?.toBase58()],
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

  if (!key) return <section className="page"><p className="notice notice--bad">That league address is not valid.</p></section>
  const revealed = finished && !!secret.data && secret.data.history[0].closeAt > 0
  const ranked = [...(cards.data ?? [])].sort((a, b) => b.rating - a.rating)
  const sortedEntries = [...(entries.data ?? [])].sort(keyOrder)

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Reveal &amp; audit</p>
        <h1 className="page__title">{league ? `${STATUS_LABEL[league.status]}` : 'Ledger'}</h1>
        <p className="page__lede">
          Scores are public after every round. Positions, nonces and close times stay sealed until the final
          round settles, then everything is published here with the transactions that prove it. Everything on
          this page is read from Solana devnet.
        </p>
        <nav className="subnav">
          <Link to={`/desk/${key.toBase58()}`}>Desk</Link>
          <Link to={`/standings/${key.toBase58()}`}>Standings</Link>
          <a href={explorerAddress(key.toBase58())} target="_blank" rel="noreferrer">League on Explorer</a>
        </nav>
      </header>

      <div className="panel">
        <h3>Scores so far (public each round)</h3>
        {ranked.every((c) => c.roundsScored === 0) && <p className="empty">No round has settled yet.</p>}
        <div className="scroll">
          <table className="grid">
            <thead><tr><th>Wallet</th><th>Rounds</th><th>Last return</th><th>Rating</th></tr></thead>
            <tbody>
              {ranked.filter((c) => c.roundsScored > 0).map((c) => (
                <tr key={c.key.toBase58()}>
                  <td className="mono">{short(c.player.toBase58(), 5, 5)}</td>
                  <td className="mono">{c.roundsScored}</td>
                  <td className="mono">{(c.lastRetBps / 100).toFixed(2)}%</td>
                  <td className="mono">{c.rating}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {league && league.settlePrice > 0 && (
          <p className="muted small">Latest settlement price: ${(league.settlePrice / 1e8).toFixed(4)} · published at {league.settleTime}.</p>
        )}
      </div>

      {!revealed && (
        <div className="panel">
          <h3>Positions and close times</h3>
          <p className="empty">
            Sealed until the final round. Every position, nonce and close time of every round is published
            together when the league finishes, so an earlier round can never be copied while the league is running.
          </p>
        </div>
      )}

      {revealed && league && secret.data && check.data && check.data.length > 0 && (
        <p className={check.data.every((c) => c.baseOk && c.closeOk) ? 'ok' : 'warn'}>
          {check.data.every((c) => c.baseOk && c.closeOk)
            ? 'Recomputed in your browser from the revealed nonces: every round’s base seed and close time match the chain.'
            : 'A recomputation does not match the chain. Treat this league as unverified.'}
        </p>
      )}

      {revealed && league && secret.data && Array.from({ length: league.round }, (_, r) => {
        const rs = secret.data!.history[r]
        const ok = check.data?.find((c) => c.round === r)
        return (
          <div className="panel" key={r}>
            <h3>Round {r + 1}</h3>
            <dl className="facts facts--wide">
              <div><dt>Derivation</dt><dd>{CLOSE_MODE_LABEL[league.closeMode]}</dd></div>
              <div><dt>Slot at lock-in</dt><dd className="mono">{rs.lockSlot}</dd></div>
              <div><dt>Close time (unix)</dt><dd className="mono">{rs.closeAt}</dd></div>
              <div><dt>VRF mixed in</dt><dd>{rs.vrfUsed ? 'Yes' : 'No: nonces and slot only'}</dd></div>
              <div className="span2"><dt>Base seed</dt><dd className="mono break">{hex(rs.baseSeed)}</dd></div>
              {rs.vrfUsed && <div className="span2"><dt>VRF output</dt><dd className="mono break">{hex(rs.randomness)}</dd></div>}
            </dl>
            {ok && <p className={ok.baseOk && ok.closeOk ? 'ok small' : 'warn small'}>{ok.baseOk && ok.closeOk ? 'Matches the chain' : 'Does not match the chain'}</p>}
            <div className="scroll">
              <table className="grid">
                <thead><tr><th>Wallet</th><th>Closing position</th><th>Return</th><th>Nonce</th></tr></thead>
                <tbody>
                  {sortedEntries.map((e) => {
                    const h = e.history[r]
                    return (
                      <tr key={e.key.toBase58()}>
                        <td className="mono">{short(e.player.toBase58(), 5, 5)}</td>
                        <td className="mono">{h.side === 0 ? 'Flat' : `${h.side > 0 ? 'Long' : 'Short'} ×${h.leverage} @ $${(h.entryPrice / 1e8).toFixed(4)}`}</td>
                        <td className="mono">{h.scored ? `${(h.retBps / 100).toFixed(2)}%` : 'voided'}</td>
                        <td className="mono small">{h.committed ? `${hex(h.nonce).slice(0, 12)}…` : 'none'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      <div className="panel">
        <h3>Settlement transactions</h3>
        <p className="muted small">
          Commits from the Private ER land on devnet. Each link opens Solana Explorer.{' '}
          <a href={explorerAddress(secretPda(key).toBase58())} target="_blank" rel="noreferrer">Secret account</a>
        </p>
        <ul className="siglist">
          {(sigs.data ?? []).map((s) => (
            <li key={s.signature}>
              <a className="mono small" href={explorerTx(s.signature)} target="_blank" rel="noreferrer">{short(s.signature, 10, 8)}</a>
              <span className="muted small"> slot {s.slot}{s.err ? ' · failed' : ''}</span>
            </li>
          ))}
          {sigs.data?.length === 0 && <li className="empty">No transactions yet.</li>}
        </ul>
      </div>
    </section>
  )
}
