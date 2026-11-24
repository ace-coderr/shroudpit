// The second player for the demo video, driven from a script while the first player (for example a
// Phantom wallet that created the league) uses the browser. Devnet only; the keypair stays outside
// the repository.
//
//   KEYPAIR_DIR=$HOME/.config/solana LEAGUE=<league address> [SIDE=short|long|flat] [LEVERAGE=1..5] \
//     node scripts/demo/second-player.mjs
//
// Signs as shroudpit-devnet.json. What it does, one short line per action:
//   1. join the league and delegate its entry (skipped if already joined)
//   2. log in to the Private ER and seal its own entry (skipped if already sealed)
//   3. commit its nonce as soon as the round opens (a 45 s window)
//   4. place its position within about 3 s of the round going LIVE
//   5. repeat 3 and 4 for every further round; stop when the league is revealing or finished
// It does not settle, reveal or finish: the open Desk in the browser does that. If that Desk is not
// open, run scripts/e2e/settle-league.mjs inside the 60 s settle window.
//
// Idempotent: every step first reads the chain and does only what is missing, so it can be stopped
// and started again at any point.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import {
  BASE_RPC, TEE_VALIDATOR, decode, entryPda, explorerBase, explorerTee, loadKeypair, permissionPda, programFor, send, sleep, teeConnection,
} from '../e2e/lib.mjs'

const DIR = process.env.KEYPAIR_DIR
if (!DIR) throw new Error('set KEYPAIR_DIR to the directory holding the devnet keypairs')
if (!process.env.LEAGUE) throw new Error('set LEAGUE=<league address>')
const league = new PublicKey(process.env.LEAGUE)
const SIDE = { long: 1, short: -1, flat: 0 }[process.env.SIDE ?? 'short']
if (SIDE === undefined) throw new Error('SIDE must be long, short or flat')
const LEVERAGE = SIDE === 0 ? 0 : Number(process.env.LEVERAGE ?? 1)

const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))
const me = loadKeypair(join(DIR, 'shroudpit-devnet.json'))
const entry = entryPda(league, me.publicKey)
const base = new Connection(BASE_RPC, 'confirmed')
const now = () => Math.floor(Date.now() / 1000)
const short = (k) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`
const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`)
const retry = async (what, fn, tries = 8) => {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= tries) throw e
      say(`(${what}: ${String(e.message).slice(0, 60)}; retrying)`)
      await sleep(2500)
    }
  }
}

// ---------------------------------------------------------------- 1. join
const baseProg = programFor(idl, base, me)
const baseLeagueInfo = await retry('read league', () => base.getAccountInfo(league))
if (!baseLeagueInfo) throw new Error(`league ${league.toBase58()} does not exist on devnet`)
say(`wallet ${short(me.publicKey)}, league ${short(league)}`)
if (await retry('read entry', () => base.getAccountInfo(entry))) {
  say('join: already joined, skipping')
} else {
  const l = decode(baseProg, 'league', baseLeagueInfo.data)
  if (l.status !== 0) throw new Error(`the league is no longer Open (status ${l.status}); joining is closed`)
  if (l.playerCount >= l.maxPlayers) throw new Error('the league is full')
  const join = await baseProg.methods.joinLeague().accountsPartial({ player: me.publicKey, league, entry }).instruction()
  const delegate = await baseProg.methods.delegateEntry().accountsPartial({ player: me.publicKey, league, entry, validator: TEE_VALIDATOR }).instruction()
  const sig = await retry('join', () => send(base, new Transaction().add(join, delegate), [me]))
  say(`joined and delegated my entry: ${explorerBase(sig)}`)
}

// ---------------------------------------------------------------- 2. Private ER login, seal the entry
say('logging in to the Private ER (the attestation check can take up to a minute)...')
const tee = await retry('Private ER login', () => teeConnection(me), 6)
const prog = programFor(idl, tee, me)
const readLeague = async () => {
  const ai = await tee.getAccountInfo(league)
  return ai ? decode(prog, 'league', ai.data) : null
}
const readEntry = async () => {
  const ai = await tee.getAccountInfo(entry)
  return ai ? decode(prog, 'entry', ai.data) : null
}
if (await tee.getAccountInfo(permissionPda(entry)).catch(() => null)) {
  say('seal entry: already sealed, skipping')
} else {
  const sig = await retry('seal entry', async () =>
    send(tee, await prog.methods.initEntryPermission().accountsPartial({ payer: me.publicKey, entry, permission: permissionPda(entry) }).transaction(), [me], { skipPreflight: true }), 12)
  say(`sealed my entry (private to this wallet): ${explorerTee(sig)}`)
}

// ---------------------------------------------------------------- 3 to 5. follow the rounds
let lastLine = ''
const status = (line) => {
  if (line !== lastLine) {
    say(line)
    lastLine = line
  }
}
let liveSeenAt = 0
let positionedRound = -1
let errors = 0
for (;;) {
  let l
  try {
    l = await readLeague()
    errors = 0
  } catch (e) {
    if (++errors > 15) throw e
    await sleep(1000)
    continue
  }
  if (!l) {
    await sleep(1000)
    continue
  }

  try {
    if (l.status === 0) {
      status('waiting for the creator to close joining and open round 1')
    } else if (l.status === 5) {
      liveSeenAt = 0
      const e = await readEntry()
      const left = l.nonceDeadline.toNumber() - now()
      if (e && e.nonceEpoch === l.epoch) {
        status(`nonce already committed for round ${l.round + 1}; waiting for the other players (${l.nonceCount}/${l.playerCount})`)
      } else if (left > 0) {
        const sig = await send(tee, await prog.methods.commitNonce(Array.from(randomBytes(32)))
          .accountsPartial({ player: me.publicKey, league, entry, permission: permissionPda(entry) }).transaction(), [me], { skipPreflight: true })
        say(`committed my nonce for round ${l.round + 1} (${left} s were left): ${explorerTee(sig)}`)
        lastLine = ''
      } else {
        status('the nonce window ended before I could commit; the creator has to open a new one')
      }
    } else if (l.status === 1) {
      status(`round ${l.round + 1}: nonces are in, waiting for the close time to be derived`)
    } else if (l.status === 2) {
      if (!liveSeenAt) {
        liveSeenAt = Date.now()
        say(`LIVE: round ${l.round + 1} of ${l.nRounds}`)
      }
      if (positionedRound !== l.round) {
        const e = await readEntry()
        if (e && e.round === l.round && e.entryPrice > 0 && SIDE !== 0) {
          positionedRound = l.round
          say('position: already placed this round, skipping')
        } else {
          const sig = await send(tee, await prog.methods.setPosition(SIDE, LEVERAGE)
            .accountsPartial({ player: me.publicKey, league, secret: PublicKey.findProgramAddressSync([Buffer.from('secret'), league.toBuffer()], new PublicKey(idl.address))[0], entry, permission: permissionPda(entry), priceFeed: l.feed })
            .transaction(), [me], { skipPreflight: true })
          positionedRound = l.round
          say(`placed my ${SIDE === 1 ? 'long' : SIDE === -1 ? 'short' : 'flat'} position ${((Date.now() - liveSeenAt) / 1000).toFixed(1)} s after LIVE: ${explorerTee(sig)}`)
        }
      } else {
        status('waiting for the hidden close and for a desk to settle the round')
      }
    } else if (l.status === 3) {
      liveSeenAt = 0
      status(`round ${l.round} settled; waiting for the creator to open round ${l.round + 1}`)
    } else if (l.status === 6 || l.status === 4) {
      say(l.status === 6 ? 'the final round is settled; the league is revealing. Done.' : 'the league is finished. Done.')
      process.exit(0)
    }
  } catch (e) {
    const m = String(e.message)
    if (/6009/.test(m)) {
      positionedRound = l.round // the round already closed; nothing more to do for it
      say('the round closed before my position landed (RoundClosed)')
    } else {
      say(`(${m.slice(0, 90)}; will look again)`)
    }
    await sleep(1000)
  }
  await sleep(l.status === 5 || l.status === 1 || l.status === 2 ? 350 : 1200)
}
