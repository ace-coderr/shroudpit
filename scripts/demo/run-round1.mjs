// Run round 1 of the open demo league as its creator, with a second wallet (for example Phantom)
// joining in the browser. Devnet only. Keypairs stay outside the repository.
//
//   KEYPAIR_DIR=/dir/with/devnet/keypairs [LEAGUE=<pubkey>] node scripts/demo/run-round1.mjs
//
// The creator is read from the league account, and the matching keypair
// (shroudpit-devnet.json) must be the one that created it. Steps:
//   a. delegate_league  - close joining, move league and secret to the Private ER
//   b. init_secret_permission - make the hidden close time unreadable
//   c. init_entry_permission  - seal the creator's own entry
//   d. countdown, start_round - opens a 45 s nonce window
//   e. commit_nonce (creator), then poll until every player has committed
//   f. lock_in (the Desk helper may send it first), then wait until the round is Live
//
// Safe to re-run: every step first reads the chain and does only what is still missing. A failed
// transaction has no effect, so a retry never double-applies. If the nonce window ends with fewer
// than two nonces, the script opens a new window with another start_round.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, PublicKey } from '@solana/web3.js'
import { DELEGATION_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk'
import bs58 from 'bs58'
import {
  BASE_RPC, PROGRAM_ID, TEE_VALIDATOR, decode, entryPda, explorerBase, explorerTee, loadKeypair,
  permissionPda, programFor, send, sleep, sortKeys, teeConnection, withCU,
} from '../e2e/lib.mjs'

const DEFAULT_LEAGUE = 'FrixzrHh6YDpZA9Rotr1pnLiqPCF4rNviVLiQbkfKdp6'
const DIR = process.env.KEYPAIR_DIR
if (!DIR) throw new Error('set KEYPAIR_DIR to the directory holding the devnet keypairs')
const league = new PublicKey(process.env.LEAGUE ?? DEFAULT_LEAGUE)
const COUNTDOWN_SECS = 10
const MIN_NONCES = 2 // matches the program
const GIVE_UP_MS = 15 * 60_000

const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))
const creator = loadKeypair(join(DIR, 'shroudpit-devnet.json'))
const base = new Connection(BASE_RPC, 'confirmed')
const secret = PublicKey.findProgramAddressSync([Buffer.from('secret'), league.toBuffer()], PROGRAM_ID)[0]
const myEntry = entryPda(league, creator.publicKey)
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
log(`league ${league.toBase58()}  creator ${short(creator.publicKey)}  players ${leagueBase.playerCount}/${leagueBase.maxPlayers}`)
log(`creator balance: ${((await base.getBalance(creator.publicKey)) / 1e9).toFixed(4)} SOL (devnet)`)

// a. delegate_league
if (baseInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
  log('a. delegate_league: already delegated, skipping')
} else {
  if (leagueBase.status !== 0) throw new Error(`league is not Open (status ${leagueBase.status}); cannot delegate`)
  if (leagueBase.playerCount < 2) throw new Error('need at least 2 players before closing joining')
  const sig = await send(base, await baseProg.methods
    .delegateLeague().accountsPartial({ creator: creator.publicKey, league, secret, validator: TEE_VALIDATOR }).transaction(), [creator])
  log(`a. delegate_league: ${explorerBase(sig)}`)
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

async function entryKeys() {
  const disc = bs58.encode(Buffer.from(idl.accounts.find((a) => a.name === 'Entry').discriminator))
  const keys = []
  for (const owner of [PROGRAM_ID, DELEGATION_PROGRAM_ID]) {
    const accs = await base.getProgramAccounts(owner, {
      filters: [{ memcmp: { offset: 0, bytes: disc } }, { memcmp: { offset: 8, bytes: league.toBase58() } }],
      dataSlice: { offset: 0, length: 0 },
    })
    keys.push(...accs.map((a) => a.pubkey))
  }
  return sortKeys(keys)
}

// b. init_secret_permission (a no-op on-chain if it already exists)
for (let i = 0; ; i++) {
  if (await exists(permissionPda(secret))) { log('b. init_secret_permission: already done, skipping'); break }
  try {
    const sig = await sendTee(await prog.methods
      .initSecretPermission().accountsPartial({ payer: creator.publicKey, league, secret, permission: permissionPda(secret) }).transaction())
    log(`b. init_secret_permission: ${explorerTee(sig)}`)
    break
  } catch (e) {
    if (i >= 15) throw e
    process.stdout.write(`   waiting for the league to reach the Private ER (${String(e.message).slice(0, 60)})\n`)
    await sleep(3000)
  }
}

// c. seal the creator's own entry
for (let i = 0; ; i++) {
  if (await exists(permissionPda(myEntry))) { log('c. init_entry_permission: already done, skipping'); break }
  try {
    const sig = await sendTee(await prog.methods
      .initEntryPermission().accountsPartial({ payer: creator.publicKey, entry: myEntry, permission: permissionPda(myEntry) }).transaction())
    log(`c. init_entry_permission: ${explorerTee(sig)}`)
    break
  } catch (e) {
    if (i >= 8) throw e
    await sleep(3000)
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

const started = Date.now()
let errors = 0
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
    // Open: the first round has not been opened yet
    if (l.status === 0) {
      await countdown('Starting round in')
      const sig = await sendTee(await prog.methods.startRound().accountsPartial({ creator: creator.publicKey, league }).transaction())
      log(`d. start_round: ${explorerTee(sig)}`)
      continue
    }

    // Nonces
    if (l.status === 5) {
      const deadline = l.nonceDeadline.toNumber()
      const left = deadline - now()
      const mine = await readMyEntry()
      const committed = !!mine && mine.nonceEpoch === l.epoch

      if (left <= 0 && l.nonceCount < MIN_NONCES) {
        log(`\nthe nonce window ended with ${l.nonceCount}/${MIN_NONCES} nonces. Opening a new window.`)
        await countdown('Restarting round in')
        const sig = await sendTee(await prog.methods.startRound().accountsPartial({ creator: creator.publicKey, league }).transaction())
        log(`   start_round (restart): ${explorerTee(sig)}`)
        continue
      }

      if (!committed && left > 0) {
        const nonce = randomBytes(32) // stays private; it is not printed or stored
        const sig = await sendTee(await prog.methods
          .commitNonce(Array.from(nonce)).accountsPartial({ player: creator.publicKey, league, entry: myEntry, permission: permissionPda(myEntry) }).transaction())
        log(`e. commit_nonce (creator): ${explorerTee(sig)}`)
        continue
      }

      if (l.nonceCount >= l.playerCount || left <= 0) {
        // everyone is in (or the window is over with enough nonces): lock in. Give the Desk helper 5 s first.
        log(`   nonces ${l.nonceCount}/${l.playerCount}; waiting up to 5 s for the Desk helper to lock in`)
        for (let i = 0; i < 5; i++) {
          await sleep(1000)
          const again = await readLeague().catch(() => null)
          if (again && again.status !== 5) break
        }
        const check = await readLeague()
        if (check.status === 5) {
          const entries = await entryKeys()
          const tx = await prog.methods
            .lockIn().accountsPartial({ payer: creator.publicKey, league, secret })
            .remainingAccounts(entries.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))).transaction()
          const sig = await sendTee(withCU(tx))
          log(`f. lock_in: ${explorerTee(sig)}`)
        } else {
          log('f. lock_in: the Desk helper already did it')
        }
        continue
      }

      // window open, our nonce is in, waiting for the others
      process.stdout.write(`\rPhantom: click Seal my nonce now, ${Math.max(left, 0)} s left   (nonces ${l.nonceCount}/${l.playerCount})   `)
      await sleep(1000)
      continue
    }

    // AwaitingVrf: wait for the callback; after the deadline derive without it
    if (l.status === 1) {
      const wait = l.vrfDeadline.toNumber() - now()
      if (wait > 0) {
        process.stdout.write(`\rwaiting for the VRF callback, ${wait} s before falling back   `)
        await sleep(1500)
        continue
      }
      try {
        const sig = await sendTee(await prog.methods
          .finalizeWithoutVrf().accountsPartial({ payer: creator.publicKey, league, secret }).transaction())
        log(`\n   finalize_without_vrf: ${explorerTee(sig)}`)
      } catch (e) {
        await sleep(1500) // the Desk helper may have finalised it first; the next read tells us
      }
      continue
    }

    if (l.status === 2) {
      log(`\n\nLIVE  round ${l.round + 1} of ${l.nRounds} is open. Place positions on the Desk now.`)
      process.exit(0)
    }

    log(`\nstatus ${l.status} (round ${l.round}, epoch ${l.epoch}): round 1 is already past the Live phase. Nothing to do.`)
    process.exit(0)
  } catch (e) {
    // a failed transaction has no effect; re-read the state and decide again
    if (++errors > 10) throw e
    log(`\n   ${String(e.message).slice(0, 120)} - re-reading state`)
    await sleep(2500)
  }
}
throw new Error('gave up after 15 minutes without reaching Live; re-run to resume')
