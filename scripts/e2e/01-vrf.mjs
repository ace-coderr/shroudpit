// Stage 1: is a VRF request fulfilled INSIDE the Private ER, and does callback_close run there?
// Creates a 2-player league on devnet, delegates it to the TEE validator, requests a round and
// waits for the VRF callback to flip the league to Live. The league is deliberately left publicly
// readable in this stage (no permission) so the result can be observed.
//
//   KEYPAIR_DIR=/dir/with/keypairs node scripts/e2e/01-vrf.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL, Connection } from '@solana/web3.js'
import BN from 'bn.js'
import {
  BASE_RPC, TEE_VALIDATOR, SOL_USD_FEED, decode, entryPda, explorerBase, explorerTee, leaguePda, loadKeypair,
  loadState, permissionPda, programFor, saveState, send, sleep, teeConnection,
} from './lib.mjs'

const DIR = process.env.KEYPAIR_DIR
if (!DIR) throw new Error('set KEYPAIR_DIR')
const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))

const creator = loadKeypair(join(DIR, 'shroudpit-devnet.json'))
const p2Path = join(DIR, 'shroudpit-p2.json')
if (!existsSync(p2Path)) writeFileSync(p2Path, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 })
const p2 = loadKeypair(p2Path)

const base = new Connection(BASE_RPC, 'confirmed')
const prog = programFor(idl, base, creator)
const state = loadState()
state.links = state.links ?? []
const log = (label, sig, tee) => {
  const url = tee ? explorerTee(sig) : explorerBase(sig)
  state.links.push({ label, sig, tee: !!tee })
  console.log(`  ${label}: ${url}`)
}

console.log('creator', creator.publicKey.toBase58(), '| player2', p2.publicKey.toBase58())
console.log('balances (SOL):', (await base.getBalance(creator.publicKey)) / LAMPORTS_PER_SOL, (await base.getBalance(p2.publicKey)) / LAMPORTS_PER_SOL)

// Fund player 2 with a small amount (devnet SOL) so it can pay rent for its entry.
if ((await base.getBalance(p2.publicKey)) < 0.02 * LAMPORTS_PER_SOL) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: p2.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL }))
  log('fund player2 0.03 SOL', await send(base, tx, [creator]))
}

// ---------- base layer ----------
const leagueId = Date.now()
const league = leaguePda(creator.publicKey, leagueId)
const e1 = entryPda(league, creator.publicKey)
const e2 = entryPda(league, p2.publicKey)
Object.assign(state, { leagueId, league: league.toBase58(), e1: e1.toBase58(), e2: e2.toBase58(), p2: p2.publicKey.toBase58() })
saveState(state)
console.log('\nleague', league.toBase58(), 'id', leagueId)

log('create_league', await send(base, await prog.methods
  .createLeague(new BN(leagueId), 2, 30, 60, 4, 6)
  .accountsPartial({ creator: creator.publicKey, league }).transaction(), [creator]))

for (const [who, entry] of [[creator, e1], [p2, e2]]) {
  const join = await prog.methods.joinLeague().accountsPartial({ player: who.publicKey, league, entry }).instruction()
  const del = await prog.methods.delegateEntry().accountsPartial({ player: who.publicKey, league, entry, validator: TEE_VALIDATOR }).instruction()
  log(`join+delegate_entry (${who.publicKey.toBase58().slice(0, 6)})`, await send(base, new Transaction().add(join, del), [who]))
}
log('delegate_league', await send(base, await prog.methods
  .delegateLeague().accountsPartial({ creator: creator.publicKey, league, validator: TEE_VALIDATOR }).transaction(), [creator]))

// ---------- Private ER ----------
const tee = await teeConnection(creator)
const teeP2 = await teeConnection(p2)
const teeProg = programFor(idl, tee, creator)
process.stdout.write('waiting for the league to appear in the TEE')
for (let i = 0; i < 40; i++) {
  const ai = await tee.getAccountInfo(league)
  if (ai) break
  process.stdout.write('.')
  await sleep(1500)
}
console.log()

for (const [who, entry, conn] of [[creator, e1, tee], [p2, e2, teeP2]]) {
  const tx = await teeProg.methods.initEntryPermission().accountsPartial({ payer: who.publicKey, entry, permission: permissionPda(entry) }).transaction()
  log(`init_entry_permission (${who.publicKey.toBase58().slice(0, 6)})`, await send(conn, tx, [who], { skipPreflight: true }), true)
}

console.log('\nrequesting the round (VRF request inside the TEE)...')
const t0 = Date.now()
let startSig
try {
  startSig = await send(tee, await teeProg.methods.startRound().accountsPartial({ payer: creator.publicKey, league }).transaction(), [creator], { skipPreflight: true })
  log('start_round', startSig, true)
} catch (e) {
  console.log('start_round FAILED:', e.message)
  if (e.sig) console.log('  sig', e.sig)
  state.vrf = { ok: false, error: e.message }
  saveState(state)
  process.exit(2)
}

let live = null
for (let i = 0; i < 60; i++) {
  const ai = await tee.getAccountInfo(league)
  if (ai) {
    const l = decode(teeProg, 'league', ai.data)
    if (l.status === 2) { live = l; break }
    if (i % 5 === 0) console.log(`  t+${Math.round((Date.now() - t0) / 1000)}s status=${l.status}`)
  }
  await sleep(1000)
}
if (!live) {
  console.log('RESULT: VRF callback did NOT run within 60s')
  state.vrf = { ok: false, error: 'timeout' }
  saveState(state)
  process.exit(3)
}
const now = Math.floor(Date.now() / 1000)
console.log(`\nRESULT: callback_close ran inside the TEE after ~${Math.round((Date.now() - t0) / 1000)}s`)
console.log('  status      ', live.status, '(2 = Live)')
console.log('  close_at    ', live.closeAt.toString(), `(in ${live.closeAt.toNumber() - now}s)`)
console.log('  randomness  ', Buffer.from(live.randomness).toString('hex'))
state.vrf = { ok: true, closeAt: live.closeAt.toString(), randomness: Buffer.from(live.randomness).toString('hex') }
saveState(state)
