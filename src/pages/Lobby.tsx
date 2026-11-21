import { useState } from 'react'
import { Link } from 'react-router-dom'
import { joinLeague } from '../lib/actions'
import { entryPda, baseConnection } from '../lib/chain'
import type { LeagueView } from '../lib/chain'
import { ASSETS, CLOSE_MODE_LABEL, STATUS_LABEL, explorerAddress } from '../lib/config'
import { short, useLeagues, usePoll } from '../lib/hooks'
import { useSigner } from '../lib/wallet'
import { priceFeedPda } from '../lib/chain'

const assetOf = (l: LeagueView) => ASSETS.find((a) => priceFeedPda(a.id).equals(l.feed))?.symbol ?? 'custom feed'

export default function Lobby() {
  const { data, error, loading, refresh } = useLeagues()
  const signer = useSigner()
  const me = signer?.publicKey
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // which leagues the connected wallet already joined (entry PDA exists on the base layer)
  const joined = usePoll(
    async () => {
      if (!me || !data) return new Set<string>()
      const keys = data.map((l) => entryPda(l.key, me))
      const infos = await baseConnection.getMultipleAccountsInfo(keys)
      return new Set(data.filter((_, i) => infos[i]).map((l) => l.key.toBase58()))
    },
    15_000,
    [me?.toBase58(), data?.length],
  )

  async function join(l: LeagueView) {
    if (!signer) return
    setBusy(l.key.toBase58())
    setMsg(null)
    try {
      await joinLeague(signer, l.key)
      setMsg('Joined. Your entry is now inside the Private ER.')
      await refresh()
      await joined.refresh()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">League Lobby</p>
        <h1 className="page__title">Open ledgers</h1>
        <p className="page__lede">
          Every league below is read straight from Solana devnet. Join an open one, or{' '}
          <Link to="/create">start your own</Link>.
        </p>
      </header>

      {error && <p className="notice notice--bad">Could not read leagues: {error}</p>}
      {msg && <p className="notice">{msg}</p>}
      {loading && <p className="muted">Reading the chain…</p>}
      {data && data.length === 0 && (
        <p className="empty">No leagues exist yet. The first one will appear here as soon as someone creates it.</p>
      )}

      <ul className="cards">
        {data?.map((l) => {
          const key = l.key.toBase58()
          const isOpen = l.status === 0
          const mine = joined.data?.has(key)
          return (
            <li key={key} className="card">
              <div className="card__top">
                <span className={`badge badge--${l.status}`}>{STATUS_LABEL[l.status]}</span>
                <a className="mono small" href={explorerAddress(key)} target="_blank" rel="noreferrer">
                  {short(key, 5, 5)}
                </a>
              </div>
              <h3 className="card__title">
                {assetOf(l)} · {l.nRounds} round{l.nRounds > 1 ? 's' : ''}
              </h3>
              <dl className="facts">
                <div><dt>Players</dt><dd className="mono">{l.playerCount}/{l.maxPlayers}</dd></div>
                <div><dt>Round length</dt><dd className="mono">{l.minSecs}–{l.maxSecs}s</dd></div>
                <div><dt>Close time</dt><dd>{CLOSE_MODE_LABEL[l.closeMode]}</dd></div>
                <div><dt>Creator</dt><dd className="mono">{short(l.creator.toBase58())}</dd></div>
              </dl>
              <div className="card__actions">
                {isOpen && me && !mine && (
                  <button className="btn btn--ink" disabled={busy === key || l.playerCount >= l.maxPlayers} onClick={() => void join(l)}>
                    {busy === key ? 'Joining…' : l.playerCount >= l.maxPlayers ? 'Full' : 'Join league'}
                  </button>
                )}
                {isOpen && !me && <span className="muted">Connect a wallet to join</span>}
                {mine && <Link className="btn btn--ink" to={`/desk/${key}`}>Open my desk</Link>}
                {!isOpen && !mine && <Link className="btn btn--line" to={`/standings/${key}`}>Standings</Link>}
                <Link className="btn btn--text" to={`/audit/${key}`}>Audit</Link>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
