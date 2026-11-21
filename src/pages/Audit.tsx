import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PublicKey } from '@solana/web3.js'
import { baseConnection, fetchEntries, fetchSecretBase, secretPda } from '../lib/chain'
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

/** Recompute the close time exactly as the program does, from the values revealed on-chain. */
async function recompute(league: LeagueView, secret: SecretView, entries: EntryView[]) {
  const sorted = [...entries].sort((a, b) => {
    const x = a.key.toBytes()
    const y = b.key.toBytes()
    for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
  })
  const parts: Uint8Array[] = [league.key.toBytes(), le(league.epoch, 2), le(secret.lockSlot, 8)]
  for (const e of sorted) if (e.nonceEpoch === league.epoch) parts.push(e.player.toBytes(), e.nonce)
  const base = await sha256(parts)
  const baseOk = eq(base, secret.baseSeed)
  const seed = secret.vrfUsed ? await sha256([secret.baseSeed, secret.randomness]) : base
  const span = BigInt(league.maxSecs - league.minSecs + 1)
  const offset = new DataView(seed.buffer, seed.byteOffset, 8).getBigUint64(0, true) % span
  const closeAt = BigInt(league.roundStartedAt) + BigInt(league.minSecs) + offset
  return { baseOk, closeOk: closeAt === BigInt(secret.closeAt) }
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
  const entries = usePoll(() => (key ? fetchEntries(key) : Promise.resolve([])), 12_000, [key?.toBase58()])
  const secret = usePoll(() => (key ? fetchSecretBase(key) : Promise.resolve(null)), 12_000, [key?.toBase58()])
  const sigs = usePoll(
    async () => (key ? baseConnection.getSignaturesForAddress(key, { limit: 25 }) : []),
    20_000,
    [key?.toBase58()],
  )
  const check = usePoll(
    async () => {
      const s = secret.data
      const l = league
      if (!s || !l || s.closeAt === 0 || !entries.data) return null
      return recompute(l, s, entries.data)
    },
    30_000,
    [secret.data?.closeAt, league?.round, entries.data?.length],
  )

  if (!key) return <section className="page"><p className="notice notice--bad">That league address is not valid.</p></section>
  const revealed = !!secret.data && secret.data.closeAt > 0
  const rows = [...(entries.data ?? [])].sort((a, b) => b.rating - a.rating)

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Reveal &amp; audit</p>
        <h1 className="page__title">{league ? `${STATUS_LABEL[league.status]}` : 'Ledger'}</h1>
        <p className="page__lede">
          What was hidden while the round ran is published here once it settles, with the transactions that
          prove it. Everything on this page is read from Solana devnet.
        </p>
        <nav className="subnav">
          <Link to={`/desk/${key.toBase58()}`}>Desk</Link>
          <Link to={`/standings/${key.toBase58()}`}>Standings</Link>
          <a href={explorerAddress(key.toBase58())} target="_blank" rel="noreferrer">League on Explorer</a>
        </nav>
      </header>

      <div className="panel">
        <h3>How the close time was derived</h3>
        {!revealed && <p className="empty">The close time is still hidden. It is published when the round settles.</p>}
        {revealed && league && secret.data && (
          <>
            <dl className="facts facts--wide">
              <div><dt>Derivation</dt><dd>{CLOSE_MODE_LABEL[league.closeMode]}</dd></div>
              <div><dt>Slot at lock-in</dt><dd className="mono">{secret.data.lockSlot}</dd></div>
              <div><dt>Close time (unix)</dt><dd className="mono">{secret.data.closeAt}</dd></div>
              <div><dt>VRF mixed in</dt><dd>{secret.data.vrfUsed ? 'Yes' : 'No: derived from nonces and slot'}</dd></div>
              <div className="span2"><dt>Base seed</dt><dd className="mono break">{hex(secret.data.baseSeed)}</dd></div>
              {secret.data.vrfUsed && <div className="span2"><dt>VRF output</dt><dd className="mono break">{hex(secret.data.randomness)}</dd></div>}
            </dl>
            {check.data && (
              <p className={check.data.baseOk && check.data.closeOk ? 'ok' : 'warn'}>
                {check.data.baseOk && check.data.closeOk
                  ? 'Recomputed in your browser from the revealed nonces: the base seed and the close time match the chain.'
                  : 'The recomputation does not match the chain. Treat this league as unverified.'}
              </p>
            )}
            <p className="muted small">
              base seed = sha256(league, epoch, lock slot, every committed (wallet, nonce)); the close time is the
              round start plus the minimum plus (seed mod window).
            </p>
          </>
        )}
      </div>

      <div className="panel">
        <h3>Revealed entries</h3>
        {rows.every((r) => r.roundsScored === 0) && <p className="empty">No round has settled yet.</p>}
        <div className="scroll">
          <table className="grid">
            <thead>
              <tr><th>Wallet</th><th>Last position</th><th>Last return</th><th>Rounds</th><th>Rating</th><th>Nonce</th></tr>
            </thead>
            <tbody>
              {rows.filter((r) => r.roundsScored > 0).map((r) => (
                <tr key={r.key.toBase58()}>
                  <td className="mono">{short(r.player.toBase58(), 5, 5)}</td>
                  <td className="mono">{r.side === 0 ? 'Flat' : `${r.side > 0 ? 'Long' : 'Short'} ×${r.leverage} @ $${(r.entryPrice / 1e8).toFixed(4)}`}</td>
                  <td className="mono">{(r.lastRetBps / 100).toFixed(2)}%</td>
                  <td className="mono">{r.roundsScored}</td>
                  <td className="mono">{r.rating}</td>
                  <td className="mono small">{hex(r.nonce).slice(0, 12)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {league && league.settlePrice > 0 && (
          <p className="muted small">Settlement price: ${(league.settlePrice / 1e8).toFixed(4)} · published at {league.settleTime}.</p>
        )}
      </div>

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
