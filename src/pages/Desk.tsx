import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PublicKey } from '@solana/web3.js'
import {
  commitNonce, finalizeWithoutVrf, helperConnection, helperKeypair, lockIn, sealEntry, setPosition, settle,
} from '../lib/actions'
import {
  baseConnection, entryPda, fetchEntries, fetchQuote, permissionPda, toEntry,
} from '../lib/chain'
import type { EntryView } from '../lib/chain'
import { STATUS_LABEL } from '../lib/config'
import { short, useLeague, useNow, usePoll } from '../lib/hooks'
import { TxError, teeSession } from '../lib/session'
import { useSigner } from '../lib/wallet'
import Redacted from '../components/Redacted'
import RoundClock from '../components/RoundClock'
import Seal from '../components/Seal'
import { Connection } from '@solana/web3.js'

const ER_PUBLIC = 'https://devnet-eu.magicblock.app'
const SIDE = { '1': 'Long', '-1': 'Short', '0': 'Flat' } as Record<string, string>

function friendly(e: unknown): string {
  if (e instanceof TxError && e.code) {
    const map: Record<string, string> = {
      RoundClosed: 'The round has closed. The close moment was hidden until now.',
      NoncePhaseClosed: 'The nonce phase is over.',
      NonceAlreadyCommitted: 'Your nonce for this round is already sealed.',
      PermissionMissing: 'Your entry is not sealed yet. Seal it first.',
      StalePrice: 'The price was stale. Try again.',
      WrongStatus: 'The league is not in a phase that allows this.',
    }
    return map[e.code] ?? `Rejected by the program: ${e.code}`
  }
  return e instanceof Error ? e.message : String(e)
}

export default function Desk() {
  const { league: addr } = useParams()
  const key = useMemo(() => {
    try {
      return addr ? new PublicKey(addr) : null
    } catch {
      return null
    }
  }, [addr])
  const signer = useSigner()
  const now = useNow(1000)
  const { data: league, error } = useLeague(key, 2000)

  const [unlocked, setUnlocked] = useState(false)
  const [attested, setAttested] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [side, setSide] = useState<1 | -1 | 0>(1)
  const [leverage, setLeverage] = useState(2)
  const [showMine, setShowMine] = useState(false)
  const [help, setHelp] = useState(true)
  const [helpNote, setHelpNote] = useState<string | null>(null)

  // joined? (entry PDA exists on the base layer)
  const joined = usePoll(
    async () => (signer && key ? !!(await baseConnection.getAccountInfo(entryPda(key, signer.publicKey))) : false),
    8000,
    [signer?.publicKey.toBase58(), key?.toBase58()],
  )
  const players = usePoll(() => (key ? fetchEntries(key) : Promise.resolve([] as EntryView[])), 10_000, [key?.toBase58()])

  // my live entry, readable only by me: needs the enclave's token, so it waits for an explicit unlock
  const mine = usePoll(
    async () => {
      if (!unlocked || !signer || !key || !league?.delegated) return null
      const { connection } = await teeSession(signer)
      const ek = entryPda(key, signer.publicKey)
      const [e, p] = await Promise.all([connection.getAccountInfo(ek), connection.getAccountInfo(permissionPda(ek))])
      return { entry: e ? toEntry(ek, e.data) : null, sealed: !!p }
    },
    2000,
    [unlocked, signer?.publicKey.toBase58(), league?.delegated],
  )

  // live price from the oracle, read from the rollup
  const price = usePoll(
    async () => {
      if (!league) return null
      for (const c of [new Connection(ER_PUBLIC, 'confirmed')]) {
        const q = await fetchQuote(c, league.feed).catch(() => null)
        if (q) return q
      }
      return null
    },
    1500,
    [league?.feed.toBase58()],
  )

  async function unlock() {
    if (!signer) return
    setBusy('unlock')
    try {
      const s = await teeSession(signer)
      setAttested(s.attested)
      setUnlocked(true)
    } catch (e) {
      setMsg({ ok: false, text: friendly(e) })
    } finally {
      setBusy(null)
    }
  }

  async function act(name: string, fn: () => Promise<string>) {
    setBusy(name)
    setMsg(null)
    try {
      await fn()
      setMsg({ ok: true, text: `${name}: done` })
      await mine.refresh()
    } catch (e) {
      setMsg({ ok: false, text: `${name}: ${friendly(e)}` })
    } finally {
      setBusy(null)
    }
  }

  // Anyone can lock in, finalise and settle. A throwaway key does it without wallet pop-ups.
  const inflight = useRef(false)
  useEffect(() => {
    if (!help || !league || !key || !league.delegated) return
    const id = setInterval(async () => {
      if (inflight.current) return
      const t = Date.now() / 1000
      const l = league
      const need =
        (l.status === 5 && l.nonceCount >= 2 && (l.nonceCount === l.playerCount || t >= l.nonceDeadline)) ||
        (l.status === 1 && t >= l.vrfDeadline) ||
        (l.status === 2 && t >= l.roundStartedAt + l.minSecs)
      if (!need) return
      inflight.current = true
      try {
        const conn = await helperConnection()
        const kp = helperKeypair()
        if (l.status === 5) await lockIn(kp, conn, key)
        else if (l.status === 1) await finalizeWithoutVrf(kp, conn, key)
        else await settle(kp, conn, key, l.feed)
        setHelpNote(null)
      } catch (e) {
        setHelpNote(`Automatic helper: ${e instanceof Error ? e.message.slice(0, 120) : 'failed'}`)
      } finally {
        inflight.current = false
      }
    }, 3000)
    return () => clearInterval(id)
  }, [help, league, key])

  if (!key) return <section className="page"><p className="notice notice--bad">That league address is not valid.</p></section>
  if (error) return <section className="page"><p className="notice notice--bad">{error}</p></section>
  if (!league) return <section className="page"><p className="muted">Reading the ledgerâ€¦</p></section>

  const e = mine.data?.entry ?? null
  const sealed = mine.data?.sealed ?? false
  const nonceDone = !!e && e.nonceEpoch === league.epoch && league.epoch > 0
  const live = league.status === 2
  const unrealised =
    e && e.side !== 0 && price.data && e.entryPrice > 0
      ? Math.round((((price.data.price * 1e8 - e.entryPrice) / e.entryPrice) * 10_000 * e.side * e.leverage))
      : null

  return (
    <section className="page">
      <header className="page__head">
        <p className="eyebrow">Sealed Desk</p>
        <h1 className="page__title">
          {STATUS_LABEL[league.status]} Â· round {Math.min(league.round + 1, league.nRounds)} of {league.nRounds}
        </h1>
        <p className="page__lede mono small">{league.key.toBase58()}</p>
        <nav className="subnav">
          <Link to={`/standings/${key.toBase58()}`}>Standings</Link>
          <Link to={`/audit/${key.toBase58()}`}>Reveal &amp; audit</Link>
        </nav>
      </header>

      {!signer && <p className="notice">Connect a devnet wallet to use your desk.</p>}
      {signer && joined.data === false && <p className="notice">This wallet has not joined this league. <Link to="/lobby">Back to the lobby</Link></p>}

      <div className="desk">
        <div className="desk__col">
          <RoundClock league={league} />
          <div className="panel">
            <h3>Price</h3>
            <p className="price mono">
              {price.data ? `$${price.data.price.toFixed(4)}` : 'â€¦'}
            </p>
            <p className="muted small">
              Live oracle price, updated every second inside the rollup
              {price.data ? ` Â· ${Math.max(0, Math.round(now - price.data.publishTime))}s old` : ''}.
            </p>
          </div>
          <div className="panel">
            <h3>Players</h3>
            <ul className="roster">
              {players.data?.map((p: EntryView) => (
                <li key={p.key.toBase58()}>
                  <span className="mono">{short(p.player.toBase58(), 4, 4)}</span>
                  {signer && p.player.equals(signer.publicKey) && <em> you</em>}
                  <span className="roster__pos">{live || league.status === 5 ? <Seal width="7ch" /> : <span className="muted">â€”</span>}</span>
                </li>
              ))}
            </ul>
            <p className="muted small">Other players' positions stay sealed until the round closes.</p>
          </div>
        </div>

        <div className="desk__col">
          <div className="panel">
            <h3>Your desk</h3>
            {signer && joined.data && !unlocked && (
              <>
                <p className="muted">
                  Your position lives in a Private Ephemeral Rollup and only you can read it. Unlock it by
                  signing a message with your wallet; no funds move.
                </p>
                <button className="btn btn--ink" disabled={busy === 'unlock'} onClick={() => void unlock()}>
                  {busy === 'unlock' ? 'Unlockingâ€¦' : 'Unlock my desk'}
                </button>
              </>
            )}
            {unlocked && (
              <>
                <ol className="steps2">
                  <li className="done">Joined</li>
                  <li className={sealed ? 'done' : ''}>Entry sealed to my wallet</li>
                  <li className={nonceDone ? 'done' : ''}>Nonce sealed for this round</li>
                  <li className={live ? 'done' : ''}>Round live</li>
                </ol>
                {attested !== null && (
                  <p className={`small ${attested ? 'ok' : 'warn'}`}>
                    {attested
                      ? 'Enclave attestation verified in this browser.'
                      : 'Enclave attestation could not be checked from this browser (it needs a third-party certificate service). The connection is still authenticated.'}
                  </p>
                )}

                {!sealed && (
                  <button className="btn btn--ink" disabled={!!busy} onClick={() => void act('Seal entry', () => sealEntry(signer!, key))}>
                    Seal my entry
                  </button>
                )}
                {sealed && league.status === 5 && !nonceDone && (
                  <button className="btn btn--ink" disabled={!!busy} onClick={() => void act('Seal nonce', () => commitNonce(signer!, key))}>
                    Seal my nonce
                  </button>
                )}
                {sealed && league.status === 5 && nonceDone && <p className="ok">Nonce sealed. Waiting for the other players ({league.nonceCount}/{league.playerCount}).</p>}

                {live && sealed && (
                  <div className="ticket">
                    <div className="seg" role="group" aria-label="Side">
                      {([1, -1, 0] as const).map((s) => (
                        <button key={s} className={side === s ? 'on' : ''} onClick={() => setSide(s)}>
                          {SIDE[String(s)]}
                        </button>
                      ))}
                    </div>
                    <label className="range">
                      Leverage <b className="mono">{side === 0 ? 'â€“' : `Ã—${leverage}`}</b>
                      <input type="range" min={1} max={5} value={leverage} disabled={side === 0} onChange={(ev) => setLeverage(Number(ev.target.value))} />
                    </label>
                    <button
                      className="btn btn--ink"
                      disabled={!!busy}
                      onClick={() => void act('Place position', () => setPosition(signer!, key, league.feed, side, side === 0 ? 0 : leverage))}
                    >
                      {busy === 'Place position' ? 'Sealingâ€¦' : 'Place position'}
                    </button>
                  </div>
                )}

                {e && (
                  <div className="mine">
                    <h4>My sealed position</h4>
                    <p className="mono big">
                      <Redacted revealed={showMine}>
                        {e.side === 0 ? 'Flat' : `${SIDE[String(e.side)]} Ã—${e.leverage} from $${(e.entryPrice / 1e8).toFixed(4)}`}
                      </Redacted>
                    </p>
                    {unrealised !== null && live && (
                      <p className="mono small">
                        Marked now: <Redacted revealed={showMine}>{`${unrealised >= 0 ? '+' : ''}${(unrealised / 100).toFixed(2)}%`}</Redacted>
                      </p>
                    )}
                    <button className="btn btn--text" onClick={() => setShowMine((v) => !v)}>
                      {showMine ? 'Cover it' : 'Show it to me'}
                    </button>
                  </div>
                )}
              </>
            )}
            {msg && <p className={`notice${msg.ok ? '' : ' notice--bad'}`}>{msg.text}</p>}
          </div>

          <div className="panel">
            <h3>Settlement</h3>
            <p className="muted small">
              Settlement is permissionless. It runs from any open desk using a throwaway key, so nobody has to
              approve a wallet pop-up and nobody has to run a server.
            </p>
            <label className="check">
              <input type="checkbox" checked={help} onChange={(ev) => setHelp(ev.target.checked)} />
              Help lock in and settle from this tab
            </label>
            {helpNote && <p className="warn small">{helpNote}</p>}
            {league.status === 3 || league.status === 4 ? (
              <p className="ok">
                {league.status === 4 ? 'The league has finished.' : 'The round settled.'}{' '}
                <Link to={`/audit/${key.toBase58()}`}>Reveal &amp; audit</Link> Â·{' '}
                <Link to={`/standings/${key.toBase58()}`}>Standings</Link>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
