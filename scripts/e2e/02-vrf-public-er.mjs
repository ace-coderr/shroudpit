// Same VRF test as 01-vrf.mjs, but on a PUBLIC ephemeral rollup (devnet-eu or devnet-as).
// Needs the program built with the `er-test` feature (delegate_league then accepts public ER
// validators). Uses the documented ER queue constant that start_round already pins.
//
//   ER=eu KEYPAIR_DIR=/dir node scripts/e2e/02-vrf-public-er.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, Transaction } from '@solana/web3.js'
import BN from 'bn.js'
import {
  BASE_RPC, ER_VALIDATOR, decode, entryPda, explorerBase, leaguePda, loadKeypair, loadState, programFor,
  saveState, send, sleep,
} from './lib.mjs'

const which = process.env.ER ?? 'eu'
const ER_RPC = `https://devnet-${which}.magicblock.app`
const DIR = process.env.KEYPAIR_DIR
const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))
const creator = loadKeypair(join(DIR, 'shroudpit-devnet.json'))
const p2 = loadKeypair(join(DIR, 'shroudpit-p2.json'))

const base = new Connection(BASE_RPC, 'confirmed')
const er = new Connection(ER_RPC, { wsEndpoint: ER_RPC.replace('https', 'wss'), commitment: 'confirmed' })
const baseProg = programFor(idl, base, creator)
const erProg = programFor(idl, er, creator)
const state = loadState()
state.public = state.public ?? {}
const links = []
const log = (label, sig, onEr) => {
  const url = onEr
    ? `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(ER_RPC)}`
    : explorerBase(sig)
  links.push({ label, sig, onEr: !!onEr })
  console.log(`  ${label}: ${url}`)
}

console.log(`public ER: ${ER_RPC}`)
const leagueId = Date.now()
const league = leaguePda(creator.publicKey, leagueId)
console.log('league', league.toBase58(), 'id', leagueId)

log('create_league', await send(base, await baseProg.methods
  .createLeague(new BN(leagueId), 2, 30, 60, 4, 6).accountsPartial({ creator: creator.publicKey, league }).transaction(), [creator]))
for (const who of [creator, p2]) {
  const entry = entryPda(league, who.publicKey)
  log(`join_league (${who.publicKey.toBase58().slice(0, 6)})`, await send(base, await baseProg.methods
    .joinLeague().accountsPartial({ player: who.publicKey, league, entry }).transaction(), [who]))
}
log('delegate_league -> public ER', await send(base, await baseProg.methods
  .delegateLeague().accountsPartial({ creator: creator.publicKey, league, validator: ER_VALIDATOR[which] }).transaction(), [creator]))

process.stdout.write('waiting for the league on the public ER')
for (let i = 0; i < 40; i++) {
  if (await er.getAccountInfo(league)) break
  process.stdout.write('.')
  await sleep(1500)
}
console.log()

const t0 = Date.now()
let sig
try {
  sig = await send(er, await erProg.methods.startRound().accountsPartial({ payer: creator.publicKey, league }).transaction(), [creator], { skipPreflight: true })
  log('start_round (VRF request on public ER)', sig, true)
} catch (e) {
  console.log('start_round FAILED:', e.message)
  state.public[which] = { ok: false, error: e.message }
  saveState(state)
  process.exit(2)
}
const tx = await er.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
for (const l of tx?.meta?.logMessages ?? []) console.log('   ', l)

let live = null
for (let i = 0; i < 90; i++) {
  const ai = await er.getAccountInfo(league)
  const l = ai && decode(erProg, 'league', ai.data)
  if (l && l.status === 2) { live = l; break }
  if (i % 10 === 0) console.log(`  t+${Math.round((Date.now() - t0) / 1000)}s status=${l?.status}`)
  await sleep(1000)
}
if (!live) {
  console.log(`RESULT (${which}): callback_close did NOT fire within 90s`)
  state.public[which] = { ok: false, error: 'timeout', league: league.toBase58(), links }
} else {
  console.log(`RESULT (${which}): callback_close FIRED after ~${Math.round((Date.now() - t0) / 1000)}s`)
  console.log('  status', live.status, '| close_at', live.closeAt.toString(), '| randomness', Buffer.from(live.randomness).toString('hex'))
  state.public[which] = { ok: true, league: league.toBase58(), randomness: Buffer.from(live.randomness).toString('hex'), links }
}
saveState(state)
