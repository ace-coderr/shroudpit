import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  createLeague, joinLeague, openRound, sealSecret, startLeague,
} from '../lib/actions'
import { permissionPda, secretPda } from '../lib/chain'
import type { LeagueView } from '../lib/chain'
import { ASSETS, CLOSE_MODE_LABEL, STATUS_LABEL } from '../lib/config'
import { short, useLeagues, usePoll } from '../lib/hooks'
import { teeSession } from '../lib/session'
import { useSigner } from '../lib/wallet'

export default function Create() {
  const signer = useSigner()
  const leagues = useLeagues()
  const mine = leagues.data?.filter((l) => signer && l.creator.equals(signer.publicKey)) ?? []

  const [rounds, setRounds] = useState(2)
  const [minSecs, setMinSecs] = useState(60)
  const [maxSecs, setMaxSecs] = useState(120)
  const [maxPlayers, setMaxPlayers] = useState(4)
  const [feedId, setFeedId] = useState<number>(ASSETS[0].id)
  const [closeMode, setCloseMode] = useState(1)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!signer) return
    setBusy(true)
    setMsg(null)
    try {
      const { league } = await createLeague(signer, { rounds, minSecs, maxSecs, maxPlayers, feedId, closeMode })
      // the creator plays too: join straight away so the league has a first player
      await joinLeague(signer, league)
      setMsg({ ok: true, text: `League ${short(league.toBase58(), 5, 5)} created and joined.` })
      await leagues.refresh()
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Creator Console</p>
        <h1 className="page__title">Open a ledger</h1>
        <p className="page__lede">
          You choose the asset, the number of rounds and the window the hidden close falls in. You never
          learn the close time: it is derived from every player's private nonce.
        </p>
      </header>

      {!signer && <p className="notice">Connect a devnet wallet to create a league.</p>}

      <form className="form" onSubmit={submit}>
        <label>
          Asset (live oracle price)
          <select value={feedId} onChange={(e) => setFeedId(Number(e.target.value))}>
            {ASSETS.map((a) => <option key={a.id} value={a.id}>{a.symbol}</option>)}
          </select>
        </label>
        <label>
          Rounds
          <input type="number" min={1} max={8} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} />
        </label>
        <label>
          Earliest close (seconds)
          <input type="number" min={30} max={7200} value={minSecs} onChange={(e) => setMinSecs(Number(e.target.value))} />
        </label>
        <label>
          Latest close (seconds)
          <input type="number" min={minSecs} max={7200} value={maxSecs} onChange={(e) => setMaxSecs(Number(e.target.value))} />
        </label>
        <label>
          Maximum players
          <input type="number" min={2} max={8} value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))} />
        </label>
        <label>
          Close time derivation
          <select value={closeMode} onChange={(e) => setCloseMode(Number(e.target.value))}>
            <option value={0}>{CLOSE_MODE_LABEL[0]}</option>
            <option value={1}>{CLOSE_MODE_LABEL[1]} (VRF mixed in if it arrives)</option>
          </select>
        </label>
        <button className="btn btn--ink" disabled={!signer || busy || maxSecs < minSecs}>
          {busy ? 'Creating…' : 'Create league'}
        </button>
      </form>
      {msg && <p className={`notice${msg.ok ? '' : ' notice--bad'}`}>{msg.text}</p>}

      <h2 className="section__title">Your leagues</h2>
      {mine.length === 0 && <p className="empty">Leagues you create will be managed here.</p>}
      <ul className="cards">
        {mine.map((l) => <ConsoleCard key={l.key.toBase58()} league={l} />)}
      </ul>
    </section>
  )
}

/** The creator's controls follow the league's phase; only valid next steps are enabled. */
function ConsoleCard({ league }: { league: LeagueView }) {
  const signer = useSigner()
  const key = league.key
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const sealed = usePoll(
    async () => {
      if (!signer || league.status === 0) return false
      const { connection } = await teeSession(signer)
      const ai = await connection.getAccountInfo(permissionPda(secretPda(key)))
      return !!ai
    },
    6000,
    [signer?.publicKey.toBase58(), league.status],
  )

  async function run(name: string, fn: () => Promise<string>) {
    setBusy(name)
    setMsg(null)
    try {
      await fn()
      setMsg(`${name}: done`)
    } catch (e) {
      setMsg(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  if (!signer) return null
  return (
    <li className="card">
      <div className="card__top">
        <span className={`badge badge--${league.status}`}>{STATUS_LABEL[league.status]}</span>
        <span className="mono small">{short(key.toBase58(), 5, 5)}</span>
      </div>
      <h3 className="card__title">{league.playerCount}/{league.maxPlayers} players · round {Math.min(league.round + 1, league.nRounds)} of {league.nRounds}</h3>
      <div className="card__actions col">
        {league.status === 0 && !league.delegated && (
          <button className="btn btn--ink" disabled={!!busy || league.playerCount < 2} onClick={() => void run('Move to the Private ER', () => startLeague(signer, key))}>
            {league.playerCount < 2 ? 'Needs 2 players' : 'Close joining and move to the Private ER'}
          </button>
        )}
        {league.delegated && sealed.data === false && league.status === 0 && (
          <button className="btn btn--ink" disabled={!!busy} onClick={() => void run('Hide the close time', () => sealSecret(signer, key))}>
            Hide the close time
          </button>
        )}
        {league.delegated && sealed.data === true && (league.status === 0 || league.status === 3) && (
          <button className="btn btn--ink" disabled={!!busy} onClick={() => void run('Open round', () => openRound(signer, key))}>
            Open round {league.round + 1}
          </button>
        )}
        <Link className="btn btn--text" to={`/desk/${key.toBase58()}`}>Open the desk</Link>
        {msg && <p className="muted small">{msg}</p>}
      </div>
    </li>
  )
}
