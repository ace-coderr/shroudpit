import type { PublicKey } from '@solana/web3.js'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { claimTrophy } from '../lib/actions'
import { fetchCardsForPlayer, fetchLeagues, fetchTrophies, trophyClaimed } from '../lib/chain'
import { STATUS_LABEL, explorerAddress } from '../lib/config'
import { short, usePoll } from '../lib/hooks'
import { useSigner } from '../lib/wallet'

/** The connected wallet's verifiable track record, assembled from committed on-chain entries. */
export default function Record() {
  const signer = useSigner()
  const pk = signer?.publicKey
  const rec = usePoll(
    async () => {
      if (!pk) return []
      const [entries, leagues] = await Promise.all([fetchCardsForPlayer(pk), fetchLeagues()])
      const byKey = new Map(leagues.map((l) => [l.key.toBase58(), l]))
      return entries
        .map((card) => ({ card, league: byKey.get(card.league.toBase58()) }))
        .filter((r) => r.league)
        .sort((a, b) => Number(b.league!.id) - Number(a.league!.id))
    },
    20_000,
    [pk?.toBase58()],
  )

  const [claimMsg, setClaimMsg] = useState<string | null>(null)
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
      setClaimMsg('Trophy claimed. It is now in your wallet.')
      await trophies.refresh()
    } catch (e) {
      setClaimMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setClaiming(null)
    }
  }

  const rows = rec.data ?? []
  const scored = rows.filter((r) => r.card.roundsScored > 0)
  const wins = rows.filter((r) => r.league!.status === 4 && r.league!.winner.equals(pk!)).length
  const totalRounds = scored.reduce((n, r) => n + r.card.roundsScored, 0)

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
      {pk && (
        <div className="panel">
          <h3>Trophies</h3>
          {(trophies.data?.held.length ?? 0) === 0 && (trophies.data?.claimable.length ?? 0) === 0 && (
            <p className="empty">No trophies yet. The winner of a finished league can claim one.</p>
          )}
          <ul className="siglist">
            {trophies.data?.held.map((h) => (
              <li key={h.mint.toBase58()}>
                <span className="badge badge--4">Trophy</span>{' '}
                <Link className="mono small" to={`/audit/${h.league.key.toBase58()}`}>league {short(h.league.key.toBase58(), 5, 5)}</Link>{' '}
                <a className="mono small" href={explorerAddress(h.mint.toBase58())} target="_blank" rel="noreferrer">token {short(h.mint.toBase58(), 5, 5)}</a>
              </li>
            ))}
            {trophies.data?.claimable.map((l) => (
              <li key={l.key.toBase58()}>
                <span className="mono small">League {short(l.key.toBase58(), 5, 5)} is won and unclaimed</span>{' '}
                <button className="btn btn--ink" disabled={claiming === l.key.toBase58()} onClick={() => void claim(l.key)}>
                  {claiming === l.key.toBase58() ? 'Claiming…' : 'Claim trophy (about 0.0026 SOL)'}
                </button>
              </li>
            ))}
          </ul>
          {claimMsg && <p className="notice">{claimMsg}</p>}
        </div>
      )}      {rec.error && <p className="notice notice--bad">{rec.error}</p>}
      {pk && rows.length === 0 && !rec.loading && <p className="empty">No leagues yet. Join one from the <Link to="/lobby">lobby</Link>.</p>}

      <ol className="table">
        {rows.map(({ card: e, league: l }) => (
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
