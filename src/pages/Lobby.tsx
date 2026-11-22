import { useState } from 'react'
import { Link } from 'react-router-dom'
import { joinLeague } from '../lib/actions'
import { baseConnection, entryPda, priceFeedPda } from '../lib/chain'
import type { LeagueView } from '../lib/chain'
import { ASSETS, CLOSE_MODE_LABEL, STATUS_LABEL, explorerAddress } from '../lib/config'
import { useLeagues, usePoll } from '../lib/hooks'
import { useSigner } from '../lib/wallet'
import Addr from '../components/Addr'
import Shroud from '../components/Shroud'
import Skeleton from '../components/Skeleton'

const assetOf = (l: LeagueView) => ASSETS.find((a) => priceFeedPda(a.id).equals(l.feed))?.symbol ?? 'custom feed'

export default function Lobby() {
  const { data, error, loading, refresh } = useLeagues()
  const signer = useSigner()
  const me = signer?.publicKey
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // which leagues the connected wallet already joined (entry PDA exists on the base layer)
  const joined = usePoll(
    async () => {
      if (!me || !data) return new Set<string>()
      const infos = await baseConnection.getMultipleAccountsInfo(data.map((l) => entryPda(l.key, me)))
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
      setMsg({ ok: true, text: 'Joined. Your entry is now inside the Private ER.' })
      await refresh()
      await joined.refresh()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const finished = data?.find((l) => l.status === 4)

  return (
    <div className="page">
      <section className="hero">
        <div className="hero__copy">
          <span className="caption">Private trading leagues · Solana devnet</span>
          <h1>Trade in the dark. Be judged in the open.</h1>
          <p>
            Players place paper positions on live prices. Positions stay sealed, the close lands at a moment nobody can
            choose, and every result is revealed and checkable on-chain.
          </p>
          <div className="hero__cta">
            <a className="btn btn--primary" href="#leagues">Join a league</a>
            <Link className="btn" to={finished ? `/audit/${finished.key.toBase58()}` : '/create'}>Read the audit</Link>
          </div>
        </div>
        <div className="hero__frame" aria-label="Illustration: a sealed position">
          <div className="caption"><span>Position</span><span>covered</span></div>
          <Shroud revealed={false} bare caption="until the final round" />
          <div className="caption"><span>Close</span><span>hidden window</span></div>
        </div>
      </section>

      <ol className="how">
        <li className="card"><b>1. Seal</b><span className="muted">Positions live in a private rollup only you can read.</span></li>
        <li className="card"><b>2. Close</b><span className="muted">A random, hidden moment ends the round. Nobody picks it.</span></li>
        <li className="card"><b>3. Reveal</b><span className="muted">After the last round everything is published and re-verifiable.</span></li>
      </ol>

      <h2 id="leagues" className="section-title">Leagues</h2>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        Read live from Solana devnet. <Link to="/create">Start your own.</Link>
      </p>
      {error && <p className="notice notice--bad">Could not read leagues: {error}</p>}
      {msg && <p className={`notice ${msg.ok ? 'notice--ok' : 'notice--bad'}`} role="status">{msg.text}</p>}
      {loading && <Skeleton />}
      {data && data.length === 0 && (
        <p className="empty">No leagues exist yet. The first one appears here as soon as someone creates it.</p>
      )}

      <ul className="cards">
        {data?.map((l, i) => {
          const key = l.key.toBase58()
          const isOpen = l.status === 0
          const mine = joined.data?.has(key)
          return (
            <li key={key} className="card leaguecard enter" style={{ ['--i' as string]: i }}>
              <div className="card__head">
                <span className={`tag${l.status === 2 ? ' tag--live' : ''}${l.status === 5 || l.status === 1 ? ' tag--warn' : ''}`}>{STATUS_LABEL[l.status]}</span>
                <Addr value={key} href={explorerAddress(key)} />
              </div>
              <h3>{assetOf(l)}</h3>
              <dl className="facts">
                <div><dt>Players</dt><dd className="mono">{l.playerCount}/{l.maxPlayers}</dd></div>
                <div><dt>Rounds</dt><dd className="mono">{l.nRounds}</dd></div>
                <div><dt>Round length</dt><dd className="mono">{l.minSecs}–{l.maxSecs}s</dd></div>
                <div><dt>Close time</dt><dd>{CLOSE_MODE_LABEL[l.closeMode]}</dd></div>
              </dl>
              <div className="leaguecard__actions">
                {isOpen && me && !mine && (
                  <button className="btn btn--primary" disabled={busy === key || l.playerCount >= l.maxPlayers} onClick={() => void join(l)}>
                    {busy === key ? 'Waiting for signature…' : l.playerCount >= l.maxPlayers ? 'Full' : 'Join league'}
                  </button>
                )}
                {isOpen && !me && <span className="muted small">Connect a wallet to join</span>}
                {mine && <Link className="btn btn--ink" to={`/desk/${key}`}>Open my desk</Link>}
                {!isOpen && !mine && <Link className="btn" to={`/standings/${key}`}>Standings</Link>}
                <Link className="btn btn--ghost btn--small" to={`/audit/${key}`}>Audit</Link>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
