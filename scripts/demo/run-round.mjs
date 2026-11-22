// Run any round of the demo league as its creator, with other wallets (for example Phantom)
// joining and playing in the browser. Devnet only. Keypairs stay outside the repository.
//
//   KEYPAIR_DIR=/dir/with/devnet/keypairs [LEAGUE=<pubkey>] [SIDE=short|long|flat] [LEVERAGE=1] \
//     node scripts/demo/run-round.mjs
//
// The creator is read from the league and the matching keypair (shroudpit-devnet.json) must be the
// one that created it. What it does, depending on where the league is:
//   Open      close joining (delegate_league), hide the close time, seal the creator's entry
//   Open or Between   countdown, start_round (a 45 s nonce window)
//   Nonces    commit the creator's nonce, wait for the others, lock_in (Desk helper first, 5 s grace)
//   Live      place the creator's position at once (target: within 3 s of LIVE)
//   Live      watch for the hidden close; if nobody has settled 20 s after it, settle from here
//   Settled   print whether the round was scored or voided, and the creator's score card
//   Finishing (after the final round) reveal entries and finish the league if no Desk has
//
// Safe to re-run: every step first reads the chain and does only what is still missing. A failed
// transaction has no effect. If a nonce window ends with fewer than two nonces, a new one opens.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, PublicKey } from '@solana/web3.js'
import { DELEGATION_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk'
import {
  BASE_RPC, PROGRAM_ID, TEE_VALIDATOR, cardPda, decode, discoverEntries as discoverRaw, entryPda, explorerBase, explorerTee,
  loadKeypair, permissionPda, programFor, send, sleep, teeConnection, withCU,
} from '../e2e/lib.mjs'

const DEFAULT_LEAGUE = 'FrixzrHh6YDpZA9Rotr1pnLiqPCF4rNviVLiQbkfKdp6'
const DIR = process.env.KEYPAIR_DIR
if (!DIR) throw new Error('set KEYPAIR_DIR to the directory holding the devnet keypairs')
const league = new PublicKey(process.env.LEAGUE ?? DEFAULT_LEAGUE)
const SIDE = { long: 1, short: -1, flat: 0 }[process.env.SIDE ?? 'short']
if (SIDE === undefined) throw new Error('SIDE must be long, short or flat')
const LEVERAGE = SIDE === 0 ? 0 : Number(process.env.LEVERAGE ?? 1)
const COUNTDOWN_SECS = 10
const MIN_NONCES = 2 // matches the program
const SETTLE_GRACE_SECS = 20 // wait this long after the close for a Desk to settle
const GIVE_UP_MS = 25 * 60_000

const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))
const creator = loadKeypair(join(DIR, 'shroudpit-devnet.json'))
const base = new Connection(BASE_RPC, 'confirmed')
const secret = PublicKey.findProgramAddressSync([Buffer.from('secret'), league.toBuffer()], PROGRAM_ID)[0]
const myEntry = entryPda(league, creator.publicKey)
const myCard = cardPda(league, creator.publicKey)
const short = (k) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`
const now = () => Math.floor(Date.now() / 1000)
const log = (m) => console.log(m)

// ---------- base layer ----------
const baseProg = programFor(idl, base, creator)
const baseInfo = await base.getAccountInfo(league)
if (!baseInfo) throw new Error(`league ${league.toBase58()} does not exist on devnet`)
const leagueBase = decode(baseProg, 'league', baseInfo.data)
if (!leagueBase.creator.equals(creator.publicKey)) {
  throw new Error(`this league was created by ${leagueBase.creator.toBase58()}, but the keypair in KEYPAIR_DIR is ${creator.publicKey.toBase58()}`)
}
log(`league ${league.toBase58()}  creator ${short(creator.publicKey)}  players ${leagueBase.playerCount}/${leagueBase.maxPlayers}  rounds ${leagueBase.nRounds}`)
log(`creator balance: ${((await base.getBalance(creator.publicKey)) / 1e9).toFixed(4)} SOL (devnet)`)

if (!baseInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
  if (leagueBase.status === 4) {
    log(`league is already Finished. Winner ${leagueBase.winner.toBase58()}. Open #/audit/${league.toBase58()} and #/standings/${league.toBase58()}.`)
    process.exit(0)
  }
  if (leagueBase.status !== 0) throw new Error(`league is not Open (status ${leagueBase.status}); cannot delegate`)
  if (leagueBase.playerCount < 2) throw new Error('need at least 2 players before closing joining')
  const sig = await send(base, await baseProg.methods
    .delegateLeague().accountsPartial({ creator: creator.publicKey, league, secret, validator: TEE_VALIDATOR }).transaction(), [creator])
  log(`delegate_league: ${explorerBase(sig)}`)
} else {
  log('delegate_league: already delegated, skipping')
}

// ---------- Private ER ----------
const tee = await teeConnection(creator)
const prog = programFor(idl, tee, creator)
const sendTee = (tx) => send(tee, tx, [creator], { skipPreflight: true })
const readLeague = async () => {
  const ai = await tee.getAccountInfo(league)
  return ai ? decode(prog, 'league', ai.data) : null
}
const readMyEntry = async () => {
  const ai = await tee.getAccountInfo(myEntry)
  return ai ? decode(prog, 'entry', ai.data) : null
}
const exists = async (key) => !!(await tee.getAccountInfo(key).catch(() => null))

for (const [label, perm, build] of [
  ['init_secret_permission', permissionPda(secret), () => prog.methods.initSecretPermission().accountsPartial({ payer: creator.publicKey, league, secret, permission: permissionPda(secret) }).transaction()],
  ['init_entry_permission', permissionPda(myEntry), () => prog.methods.initEntryPermission().accountsPartial({ payer: creator.publicKey, entry: myEntry, permission: permissionPda(myEntry) }).transaction()],
]) {
  for (let i = 0; ; i++) {
    if (await exists(perm)) { log(`${label}: already done, skipping`); break }
    try {
      log(`${label}: ${explorerTee(await sendTee(await build()))}`)
      break
    } catch (e) {
      if (i >= 15) throw e
      log(`   waiting for the league to reach the Private ER (${String(e.message).slice(0, 60)})`)
      await sleep(3000)
    }
  }
}

async function countdown(label) {
  log(`\nREADY: in Phantom, be on the Desk tab (#/desk/${league.toBase58()}).`)
  for (let s = COUNTDOWN_SECS; s > 0; s--) {
    process.stdout.write(`\r${label} in ${s}... `)
    await sleep(1000)
  }
  process.stdout.write('\r' + ' '.repeat(40) + '\r')
}

// The public devnet RPC rate-limits getProgramAccounts. Players cannot change after joining closes,
// so look them up once and back off on 429s instead of failing.
let entriesCache = null
async function discoverEntries(b, p, lg) {
  if (entriesCache) return entriesCache
  for (let i = 0; ; i++) {
    try {
      entriesCache = await discoverRaw(b, p, lg)
      return entriesCache
    } catch (e) {
      if (i >= 8 || !/429|Too many/i.test(String(e.message))) throw e
      log(`   devnet is rate-limiting the player lookup; waiting 8 s (try ${i + 1}/8)`)
      await sleep(8000)
    }
  }
}

const positionTx = async (l) =>
  prog.methods
    .setPosition(SIDE, LEVERAGE)
    .accountsPartial({ player: creator.publicKey, league, secret, entry: myEntry, permission: permissionPda(myEntry), priceFeed: l.feed })
    .transaction()

// Dry run: does the program still accept a position? Detects the hidden close without changing anything.
async function roundIsClosed(l) {
  const tx = await positionTx(l)
  tx.feePayer = creator.publicKey
  tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash
  tx.sign(creator)
  const sim = await tee.simulateTransaction(tx)
  if (!sim.value.err) return false
  const text = JSON.stringify(sim.value.err) + (sim.value.logs ?? []).join(' ')
  return /6009|RoundClosed/.test(text) ? true : null // null: the probe did not give a usable answer
}

async function describeResult() {
  const l = await readLeague()
  if (!l) return
  const scored = l.settleTime.toNumber() >= l.roundStartedAt.toNumber() && l.settleTime.toNumber() > 0
  log(`\nRESULT: round ${l.round} of ${l.nRounds} ${scored ? `SCORED at price ${l.settlePrice.toString()}` : 'was VOIDED: nobody settled in time, nobody is scored'}  (league status ${l.status})`)
  const ci = await base.getAccountInfo(myCard)
  if (ci) {
    const c = decode(baseProg, 'card', ci.data)
    log(`  creator card on devnet: rounds scored ${c.roundsScored}, last return ${c.lastRetBps.toString()} bps, rating ${c.rating.toString()}`)
  }
}

const started = Date.now()
let errors = 0
let liveSince = 0
let positionedEpoch = -1
let closeSeenAt = 0
let probeBroken = 0
let finishingSince = 0
let watchedLive = false
let described = false
log('\nreading the league state; every action below depends on it')
while (Date.now() - started < GIVE_UP_MS) {
  let l
  try {
    l = await readLeague()
    if (!l) { await sleep(2000); continue }
    errors = 0
  } catch (e) {
    if (++errors > 10) throw e
    await sleep(2000)
    continue
  }

  try {
    // Open, or Between rounds: open the next nonce window
    // (a round we watched go Live and settle falls through to the result block below instead)
    if (l.status === 0 || (l.status === 3 && !watchedLive)) {
      await countdown(`Starting round ${l.round + 1} in`)
      log(`start_round: ${explorerTee(await sendTee(await prog.methods.startRound().accountsPartial({ creator: creator.publicKey, league }).transaction()))}`)
      continue
    }

    // Nonces
    if (l.status === 5) {
      const left = l.nonceDeadline.toNumber() - now()
      const mine = await readMyEntry()
      const committed = !!mine && mine.nonceEpoch === l.epoch

      if (left <= 0 && l.nonceCount < MIN_NONCES) {
        log(`\nthe nonce window ended with ${l.nonceCount}/${MIN_NONCES} nonces. Opening a new window.`)
        await countdown('Restarting round in')
        log(`start_round (restart): ${explorerTee(await sendTee(await prog.methods.startRound().accountsPartial({ creator: creator.publicKey, league }).transaction()))}`)
        continue
      }
      if (!committed && left > 0) {
        const nonce = randomBytes(32) // stays private; not printed or stored
        log(`commit_nonce (creator): ${explorerTee(await sendTee(await prog.methods
          .commitNonce(Array.from(nonce)).accountsPartial({ player: creator.publicKey, league, entry: myEntry, permission: permissionPda(myEntry) }).transaction()))}`)
        continue
      }
      if (l.nonceCount >= l.playerCount || left <= 0) {
        log(`   nonces ${l.nonceCount}/${l.playerCount}; waiting up to 5 s for the Desk helper to lock in`)
        for (let i = 0; i < 5; i++) {
          await sleep(1000)
          const again = await readLeague().catch(() => null)
          if (again && again.status !== 5) break
        }
        if ((await readLeague()).status === 5) {
          const { entries } = await discoverEntries(base, prog, league)
          const tx = await prog.methods.lockIn().accountsPartial({ payer: creator.publicKey, league, secret })
            .remainingAccounts(entries.map((r) => ({ pubkey: r.key, isSigner: false, isWritable: false }))).transaction()
          log(`lock_in: ${explorerTee(await sendTee(withCU(tx)))}`)
        } else {
          log('lock_in: the Desk helper already did it')
        }
        continue
      }
      process.stdout.write(`\rPhantom: click Seal my nonce now, ${Math.max(left, 0)} s left   (nonces ${l.nonceCount}/${l.playerCount})   `)
      await sleep(1000)
      continue
    }

    // AwaitingVrf: poll fast so the position goes in the moment the round is Live
    if (l.status === 1) {
      const wait = l.vrfDeadline.toNumber() - now()
      if (wait > 0) {
        process.stdout.write(`\rwaiting for the VRF callback, ${wait} s before falling back   `)
        await sleep(400)
        continue
      }
      try {
        log(`\nfinalize_without_vrf: ${explorerTee(await sendTee(await prog.methods.finalizeWithoutVrf().accountsPartial({ payer: creator.publicKey, league, secret }).transaction()))}`)
      } catch {
        await sleep(400) // the Desk helper may have finalised it first
      }
      continue
    }

    // Live
    if (l.status === 2) {
      if (!liveSince) {
        liveSince = Date.now()
        watchedLive = true
        closeSeenAt = 0
        log(`\n\nLIVE  round ${l.round + 1} of ${l.nRounds} is open. Placing the creator's ${SIDE === 1 ? 'long' : SIDE === -1 ? 'short' : 'flat'} position now.`)
      }
      if (positionedEpoch !== l.epoch) {
        try {
          const sig = await sendTee(await positionTx(l))
          positionedEpoch = l.epoch
          log(`POSITION placed ${((Date.now() - liveSince) / 1000).toFixed(1)} s after LIVE: ${explorerTee(sig)}`)
        } catch (e) {
          log(`   set_position failed: ${String(e.message).slice(0, 100)}`)
          if (/6009/.test(e.message)) positionedEpoch = l.epoch // the round already closed; do not retry
        }
        continue
      }

      // The close is hidden, so detect it with a dry run once the earliest possible close has passed.
      const sinceStart = now() - l.roundStartedAt.toNumber()
      if (!closeSeenAt && sinceStart >= l.minSecs - 2 && probeBroken < 5) {
        const closed = await roundIsClosed(l).catch(() => null)
        if (closed === true) {
          closeSeenAt = now()
          log(`\nthe round has closed (seen by dry run). Waiting ${SETTLE_GRACE_SECS} s for a Desk to settle.`)
        } else if (closed === null) probeBroken++
      }
      const probeUnavailable = !closeSeenAt && probeBroken >= 5
      if (closeSeenAt && now() - closeSeenAt < SETTLE_GRACE_SECS) {
        process.stdout.write(`\rclosed; settling from here in ${SETTLE_GRACE_SECS - (now() - closeSeenAt)} s if no Desk does   `)
        await sleep(1000)
        continue
      }
      if (closeSeenAt || (probeUnavailable && sinceStart >= l.minSecs)) {
        // settling before the close is a no-op, so this is safe even if the probe was unavailable
        const { pairs } = await discoverEntries(base, prog, league)
        const tx = await prog.methods.settleAndReveal().accountsPartial({ league, secret, priceFeed: l.feed }).remainingAccounts(pairs).transaction()
        try {
          log(`\nsettle_and_reveal (fallback, no Desk settled): ${explorerTee(await sendTee(withCU(tx)))}`)
        } catch (e) {
          log(`   settle attempt failed: ${String(e.message).slice(0, 100)}`)
        }
        await sleep(2500)
        continue
      }
      process.stdout.write(`\rlive, ${sinceStart} s since lock-in; waiting for the hidden close   `)
      await sleep(1500)
      continue
    }

    // Round settled or voided
    if ((l.status === 3 && watchedLive) || l.status === 6 || l.status === 4) {
      liveSince = 0
      if (!described) { described = true; await describeResult() }
      if (l.status === 6) {
        // final round: reveal the entries and finish if no Desk does within the grace period
        finishingSince ||= now()
        if (now() - finishingSince < SETTLE_GRACE_SECS) {
          process.stdout.write(`\rfinal round settled; revealing from here in ${SETTLE_GRACE_SECS - (now() - finishingSince)} s if no Desk does   `)
          await sleep(1500)
          continue
        }
        const { entries } = await discoverEntries(base, prog, league)
        if (l.revealedCount < l.playerCount) {
          const chunk = entries.slice(l.revealedCount, l.revealedCount + 4)
          const tx = await prog.methods.revealEntries().accountsPartial({ league })
            .remainingAccounts(chunk.map((r) => ({ pubkey: r.key, isSigner: false, isWritable: true }))).transaction()
          log(`reveal_entries from ${l.revealedCount}: ${explorerTee(await sendTee(withCU(tx)))}`)
        } else {
          const tx = await prog.methods.finishLeague().accountsPartial({ league, secret })
            .remainingAccounts(entries.map((r) => ({ pubkey: cardPda(league, r.player), isSigner: false, isWritable: true }))).transaction()
          log(`finish_league: ${explorerTee(await sendTee(withCU(tx)))}`)
        }
        await sleep(3000)
        continue
      }
      log(l.status === 3 ? `\nround done. Run this script again to open round ${l.round + 1}.` : '\nleague finished.')
      process.exit(0)
    }

    log(`\nstatus ${l.status}: nothing to do.`)
    process.exit(0)
  } catch (e) {
    if (++errors > 10) throw e
    log(`\n   ${String(e.message).slice(0, 120)} - re-reading state`)
    await sleep(2500)
  }
}
throw new Error('gave up after 25 minutes; re-run to resume')
