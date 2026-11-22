import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PublicKey } from '@solana/web3.js'
import {
  commitNonce, finalizeWithoutVrf, finishLeague, helperConnection, helperKeypair, lockIn, revealEntries, sealEntry, setPosition, settle,
} from '../lib/actions'
import {
  baseConnection, entryPda, fetchCards, fetchEntries, fetchLiveLeague, fetchQuote, permissionPda, toEntry,
} from '../lib/chain'
import type { EntryView } from '../lib/chain'
import { STATUS_LABEL } from '../lib/config'
import { fmtUtc, rankCards, shortAddr } from '../lib/format'
import { useLeague, useNow, usePoll } from '../lib/hooks'
import { explain } from '../lib/errors'
import { teeSession } from '../lib/session'
import { useSigner } from '../lib/wallet'
import Addr from '../components/Addr'
import LoadFailed from '../components/LoadFailed'
import CloseBand from '../components/CloseBand'
import DeskShell from '../components/DeskShell'
import ResultCard from '../components/ResultCard'
import SealStamp from '../components/SealStamp'
import SettleBanner from '../components/SettleBanner'
import Seal from '../components/Seal'
import Shroud from '../components/Shroud'
import Skeleton from '../components/Skeleton'
import { Connection } from '@solana/web3.js'

const ER_PUBLIC = 'https://devnet-eu.magicblock.app'
const SIDE = { '1': 'Long', '-1': 'Short', '0': 'Flat' } as Record<string, string>

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
  const { data: league, error, busy: leagueBusy, failed: leagueFailed, refresh: refreshLeague } = useLeague(key, 2000)

  const [unlocked, setUnlocked] = useState(false)
  const [attested, setAttested] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; retry?: boolean } | null>(null)
  const [side, setSide] = useState<1 | -1 | 0>(1)
  const [leverage, setLeverage] = useState(2)
  const [showMine, setShowMine] = useState(false)
  const [help, setHelp] = useState(true)
  const [helpNote, setHelpNote] = useState<string | null>(null)
  const lastRun = useRef<{ name: string; fn: () => Promise<string> } | null>(null)

  // joined? (entry PDA exists on the base layer)
  const joined = usePoll(
    async () => (signer && key ? !!(await baseConnection.getAccountInfo(entryPda(key, signer.publicKey))) : false),
    8000,
    [signer?.publicKey.toBase58(), key?.toBase58()],
  )
  const players = usePoll(() => (key ? fetchEntries(key, league?.playerCount) : Promise.resolve([] as EntryView[])), 10_000, [key?.toBase58(), league?.playerCount])

  // final scores, for the result card once the league is Revealing or Finished
  const cards = usePoll(
    () => (key && (league?.status === 4 || league?.status === 6) ? fetchCards(key) : Promise.resolve(null)),
    10_000,
    [key?.toBase58(), league?.status],
  )

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
      { const x = explain(e); setMsg({ ok: false, text: x.text, retry: x.retry }) }
    } finally {
      setBusy(null)
    }
  }

  async function act(name: string, fn: () => Promise<string>) {
    lastRun.current = { name, fn }
    setBusy(name)
    setMsg(null)
    try {
      await fn()
      setMsg({ ok: true, text: `${name}: done` })
      await mine.refresh()
    } catch (e) {
      { const x = explain(e); setMsg({ ok: false, text: `${name}: ${x.text}`, retry: x.retry }) }
    } finally {
      setBusy(null)
    }
  }

  // Anyone can lock in, finalise and settle. A throwaway key does it without wallet pop-ups. While a
  // settlement window can be open it polls every second (and re-reads the league first); otherwise
  // every three.
  const inflight = useRef(false)
  const leagueRef = useRef(league)
  useEffect(() => {
    leagueRef.current = league
  })
  const delegatedLive = !!league?.delegated
  useEffect(() => {
    if (!help || !key || !delegatedLive) return
    let tick = 0
    const id = setInterval(async () => {
      tick += 1
      if (inflight.current) return
      let l = leagueRef.current
      if (!l) return
      const t = Date.now() / 1000
      const windowOpen = (l.status === 2 && t >= l.roundStartedAt + l.minSecs) || l.status === 6
      if (!windowOpen && tick % 3 !== 0) return
      inflight.current = true
      try {
        if (windowOpen) l = (await fetchLiveLeague(key).catch(() => null)) ?? l
        const need =
          (l.status === 5 && l.nonceCount >= 2 && (l.nonceCount === l.playerCount || t >= l.nonceDeadline)) ||
          (l.status === 1 && t >= l.vrfDeadline) ||
          (l.status === 2 && t >= l.roundStartedAt + l.minSecs) ||
          l.status === 6
        if (!need) return
        const conn = await helperConnection()
        const kp = helperKeypair()
        if (l.status === 5) await lockIn(kp, conn, key)
        else if (l.status === 1) await finalizeWithoutVrf(kp, conn, key)
        else if (l.status === 6) {
          if (l.revealedCount < l.playerCount) await revealEntries(kp, conn, key, l.revealedCount)
          else await finishLeague(kp, conn, key)
        } else await settle(kp, conn, key, l.feed)
        setHelpNote(null)
      } catch (e) {
        const x = explain(e)
        setHelpNote(`Automatic helper: ${x.text}${x.retry ? ' It will try again by itself.' : ''}`)
      } finally {
        inflight.current = false
      }
    }, 1000)
    return () => clearInterval(id)
  }, [help, key, delegatedLive])

  if (!key) return <section className="page"><p className="notice notice--bad">That league address is not valid.</p></section>
  // A failed poll must not blank a desk that has already loaded: only show the error when there is nothing to show.
  if (leagueFailed && error) return <section className="page"><LoadFailed error={error} busy={leagueBusy} onRetry={() => void refreshLeague()} /></section>
  if (!league) return <section className="page"><Skeleton count={2} height="10rem" /></section>

  const e = mine.data?.entry ?? null
  const sealed = mine.data?.sealed ?? false
  const nonceDone = !!e && e.nonceEpoch === league.epoch && league.epoch > 0
  const live = league.status === 2
  const wrapped = league.status === 4 || league.status === 6 // Finished or Revealing: the play steps no longer apply
  const over = league.status === 3 || league.status === 4 || league.status === 6
  // A scored round sets settleTime at or after the round start; a voided round leaves it behind.
  const lastVoided = over && league.round >= 1 && league.settleTime < league.roundStartedAt
  const unrealised =
    e && e.side !== 0 && price.data && e.entryPrice > 0
      ? Math.round((((price.data.price * 1e8 - e.entryPrice) / e.entryPrice) * 10_000 * e.side * e.leverage))
      : null
  const joinedOk = !!signer && joined.data === true
  const step = !signer ? 1 : !joinedOk ? 1 : !unlocked ? 2 : 3
  const finalCards = wrapped && cards.data ? rankCards(cards.data, league.winner.toBase58()) : null
  const advanceLabel = league.status === 5 ? 'Lock in now' : league.status === 1 ? 'Finalise now' : league.status === 6 ? 'Reveal now' : 'Settle now'

  return (
    <DeskShell league={league}>
      <section className="page">
        <header className="page__head">
          <span className="caption">{wrapped ? 'Final result' : 'Sealed desk'}</span>
          <h1 className="mono h1--addr">{shortAddr(league.key.toBase58())}</h1>
          <div className="row">
            <Addr value={league.key.toBase58()} />
            <span className={`tag${live ? ' tag--live' : ''}`}>{STATUS_LABEL[league.status]}</span>
            <span className="tag">round {Math.min(league.round + 1, league.nRounds)} of {league.nRounds}</span>
            {over && <SealStamp voided={lastVoided} label={lastVoided ? 'Voided' : league.status === 4 ? 'Finished' : league.status === 6 ? 'Revealing' : 'Settled'} />}
          </div>
        </header>

        {error && <LoadFailed error={error} busy={leagueBusy} onRetry={() => void refreshLeague()} stale />}
        <SettleBanner league={league} helperOn={help} />

        <div className="desk">
          <div className="desk__col">
            <div className="card"><CloseBand league={league} /></div>
            {wrapped ? (
              <div className="card">
                <div className="card__head"><h3>Settle price</h3><span className="tag">last scored round</span></div>
                {league.settleTime > 0 ? (
                  <>
                    <p className="price mono">${(league.settlePrice / 1e8).toFixed(4)}</p>
                    <p className="muted small">Published {fmtUtc(league.settleTime)}.</p>
                  </>
                ) : (
                  <p className="muted">No round was scored, so there is no settle price.</p>
                )}
              </div>
            ) : (
            <div className="card">
              <div className="card__head"><h3>Price</h3><span className="tag">live oracle</span></div>
              <p className="price mono">{price.data ? `${price.data.price.toFixed(4)}` : '…'}</p>
              <p className="muted small">
                Updated every second inside the rollup{price.data ? `, ${Math.max(0, Math.round(now - price.data.publishTime))}s old` : ''}.
              </p>
            </div>
            )}
            <div className="card">
              <div className="card__head"><h3>Players</h3></div>
              {wrapped && finalCards && (
                <ul className="roster">
                  {finalCards.map((c, i) => (
                    <li key={c.key.toBase58()}>
                      <span className="mono">{i + 1}</span>
                      <Addr value={c.player.toBase58()} />
                      {signer && c.player.equals(signer.publicKey) && <span className="tag">you</span>}
                      <span className="roster__pos mono small">rating {c.rating} · {c.lastRetBps >= 0 ? '+' : ''}{(c.lastRetBps / 100).toFixed(2)}%</span>
                    </li>
                  ))}
                </ul>
              )}
              {!(wrapped && finalCards) && (
              <ul className="roster">
                {players.data?.map((p: EntryView) => (
                  <li key={p.key.toBase58()}>
                    <Addr value={p.player.toBase58()} />
                    {signer && p.player.equals(signer.publicKey) && <span className="tag">you</span>}
                    <span className="roster__pos">{live || league.status === 5 ? <Seal width="7ch" /> : <span className="muted">-</span>}</span>
                  </li>
                ))}
              </ul>
              )}
              <p className="muted small">{wrapped ? 'Final rank, rating and the return of the last scored round.' : 'Other players\' positions stay sealed until the final round.'}</p>
            </div>
          </div>

          <div className="desk__col">
            {wrapped ? (
              <ResultCard league={league} cards={cards.data} entries={players.data ?? []} me={signer?.publicKey ?? null} />
            ) : (
            <ol className="steps">
              <li className={`step ${signer ? 'step--done' : step === 1 ? 'step--active' : ''}`}>
                <span className="step__n">{signer ? '✓' : '1'}</span>
                <div className="step__body">
                  <h3>Connect</h3>
                  {!signer && <p className="muted small">Connect a devnet wallet with the button at the top of the page.</p>}
                  {signer && joined.data === false && (
                    <p className="notice notice--warn">This wallet has not joined this league. <Link to="/">Back to the lobby</Link></p>
                  )}
                  {signer && joined.data !== false && <p className="small">Connected as <Addr value={signer.publicKey.toBase58()} />.</p>}
                </div>
              </li>

              <li className={`step ${unlocked ? 'step--done' : step === 2 ? 'step--active' : 'step--idle'}`}>
                <span className="step__n">{unlocked ? '✓' : '2'}</span>
                <div className="step__body">
                  <h3>Unlock Private ER</h3>
                  {!unlocked && (
                    <>
                      <p className="muted small">
                        Your position lives in a private rollup only you can read. Sign a message to unlock it; no funds move.
                      </p>
                      <button className="btn btn--primary" disabled={!joinedOk || busy === 'unlock'} onClick={() => void unlock()}>
                        {busy === 'unlock' ? 'Waiting for signature…' : 'Unlock my desk'}
                      </button>
                    </>
                  )}
                  {unlocked && attested !== null && (
                    <p className={`small ${attested ? '' : 'muted'}`}>
                      {attested
                        ? 'Enclave attestation verified in this browser.'
                        : 'Enclave attestation could not be checked from this browser (it needs a third-party certificate service). The connection is still authenticated.'}
                    </p>
                  )}
                  {unlocked && attested === null && <p className="small">Unlocked.</p>}
                </div>
              </li>

              <li className={`step ${step === 3 ? 'step--active' : 'step--idle'}`}>
                <span className="step__n">3</span>
                <div className="step__body">
                  <h3>Place position</h3>
                  {!unlocked && <p className="muted small">Unlock the desk first.</p>}
                  {unlocked && (
                    <>
                      {!sealed && (
                        <>
                          <p className="muted small">Make your entry private to your wallet before anything else.</p>
                          <button className="btn btn--primary" disabled={!!busy} onClick={() => void act('Seal entry', () => sealEntry(signer!, key))}>
                            {busy === 'Seal entry' ? 'Waiting for signature…' : 'Seal my entry'}
                          </button>
                        </>
                      )}
                      {sealed && league.status === 5 && !nonceDone && (
                        <>
                          <p className="muted small">Seal a random nonce. It helps decide the hidden close time and stays secret until the league ends.</p>
                          <button className="btn btn--primary" disabled={!!busy} onClick={() => void act('Seal nonce', () => commitNonce(signer!, key))}>
                            {busy === 'Seal nonce' ? 'Waiting for signature…' : 'Seal my nonce'}
                          </button>
                        </>
                      )}
                      {sealed && league.status === 5 && nonceDone && (
                        <p className="notice notice--ok">Nonce sealed. Waiting for the other players ({league.nonceCount}/{league.playerCount}).</p>
                      )}
                      {sealed && !live && league.status !== 5 && !over && <p className="muted small">Positions open when the round goes live.</p>}
                      {live && sealed && (
                        <div className="ticket">
                          <div className="seg" role="group" aria-label="Side">
                            {([1, -1, 0] as const).map((sd) => (
                              <button key={sd} className={side === sd ? 'on' : ''} onClick={() => setSide(sd)}>
                                {SIDE[String(sd)]}
                              </button>
                            ))}
                          </div>
                          <label className="range">
                            <span>Leverage <b>{side === 0 ? '-' : `×${leverage}`}</b></span>
                            <input type="range" min={1} max={5} value={leverage} disabled={side === 0} onChange={(ev) => setLeverage(Number(ev.target.value))} />
                          </label>
                          <button
                            className="btn btn--primary"
                            disabled={!!busy}
                            onClick={() => void act('Place position', () => setPosition(signer!, key, league.feed, side, side === 0 ? 0 : leverage))}
                          >
                            {busy === 'Place position' ? 'Waiting for signature…' : 'Place position'}
                          </button>
                        </div>
                      )}
                      {sealed && e && (
                        <div className="stack">
                          <Shroud
                            revealed={showMine}
                            side={e.side}
                            leverage={e.leverage}
                            caption={showMine && e.entryPrice > 0 ? `from $${(e.entryPrice / 1e8).toFixed(4)}` : 'your position'}
                          />
                          {showMine && unrealised !== null && live && (
                            <p className="mono small">Marked now: {unrealised >= 0 ? '+' : ''}{(unrealised / 100).toFixed(2)}%</p>
                          )}
                          <button className="btn btn--ghost btn--small" onClick={() => setShowMine((v) => !v)}>
                            {showMine ? 'Cover it' : 'Lift the cloth (only you can see this)'}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                  {msg && (
                    <div className={`notice ${msg.ok ? 'notice--ok' : 'notice--bad'}`} role="status">
                      <p>{msg.text}</p>
                      {!msg.ok && msg.retry && (
                        <button
                          className="btn btn--small"
                          style={{ marginTop: '0.5rem' }}
                          disabled={!!busy}
                          onClick={() => (lastRun.current ? void act(lastRun.current.name, lastRun.current.fn) : void unlock())}
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            </ol>
            )}

            {league.status !== 4 && (
            <div className="card">
              <div className="card__head"><h3>Settlement window</h3><span className={`tag${live ? ' tag--warn' : ''}`}>{live ? 'window open' : 'idle'}</span></div>
              <p className="muted small">
                Anyone can settle once the hidden close has passed, with a throwaway key, so no wallet pop-up and no server. It needs at least
                one open desk within 60 seconds of the close, otherwise the round is voided and nobody is scored.
              </p>
              {league.status !== 4 && (
              <label className="check">
                <input type="checkbox" checked={help} onChange={(ev) => setHelp(ev.target.checked)} />
                Help lock in, settle and reveal from this tab
              </label>
              )}
              {helpNote && <p className="notice notice--warn small">{helpNote}</p>}
              {(league.status === 5 || league.status === 1 || league.status === 2 || league.status === 6) && (
                <div className="stack">
                  <button
                    className="btn"
                    disabled={!!busy}
                    onClick={() =>
                      void act('Advance the round', async () => {
                        const conn = await helperConnection()
                        const kp = helperKeypair()
                        if (league.status === 5) return lockIn(kp, conn, key)
                        if (league.status === 1) return finalizeWithoutVrf(kp, conn, key)
                        if (league.status === 6) return league.revealedCount < league.playerCount ? revealEntries(kp, conn, key, league.revealedCount) : finishLeague(kp, conn, key)
                        return settle(kp, conn, key, league.feed)
                      })
                    }
                  >
                    {advanceLabel}
                  </button>
                  <p className="muted small">Runs the next step now instead of waiting for a desk to do it.</p>
                </div>
              )}
              {(league.status === 3 || league.status === 4) && (
                <p className="small">
                  {lastVoided ? 'This round was voided: nobody settled in time, so nobody was scored for it. ' : ''}{league.status === 4 ? 'The league has finished.' : lastVoided ? '' : 'The round settled.'}{' '}
                  <Link to={`/audit/${key.toBase58()}`}>Reveal and audit</Link> · <Link to={`/standings/${key.toBase58()}`}>Standings</Link>
                </p>
              )}
            </div>
            )}
          </div>
        </div>
      </section>
    </DeskShell>
  )
}
