// Does the Private ER see a FRESH copy of an undelegated base-layer account after it changes?
// A League account is created on the base layer (undelegated), a TEE transaction reads it
// (probe_account logs what the TEE sees), the account is then changed on the base layer
// (join_league bumps player_count 0 -> 1) and the TEE is probed repeatedly.
//
//   KEYPAIR_DIR=/dir node scripts/e2e/03-fresh-clone.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection } from '@solana/web3.js'
import BN from 'bn.js'
import {
  BASE_RPC, decode, entryPda, explorerBase, leaguePda, loadKeypair, loadState, programFor,
  saveState, send, sleep, teeConnection,
} from './lib.mjs'

const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))
const creator = loadKeypair(join(process.env.KEYPAIR_DIR, 'shroudpit-devnet.json'))
const base = new Connection(BASE_RPC, 'confirmed')
const baseProg = programFor(idl, base, creator)
const tee = await teeConnection(creator)
const teeProg = programFor(idl, tee, creator)

const leagueId = Date.now()
const L = leaguePda(creator.publicKey, leagueId)
console.log('probe account (undelegated League):', L.toBase58())

const sig0 = await send(base, await baseProg.methods
  .createLeague(new BN(leagueId), 2, 30, 60, 4, 6).accountsPartial({ creator: creator.publicKey, league: L }).transaction(), [creator])
console.log('  create_league:', explorerBase(sig0))

async function probe(label) {
  const t = await teeProg.methods.probeAccount().accountsPartial({ probe: L }).transaction()
  let sig, line
  try {
    sig = await send(tee, t, [creator], { skipPreflight: true })
    const r = await tee.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
    line = (r?.meta?.logMessages ?? []).find((m) => m.includes('probe ')) ?? '(no probe log)'
  } catch (e) {
    line = `tx error: ${e.message}`
    sig = e.sig
  }
  const rpc = await tee.getAccountInfo(L)
  const rpcPlayers = rpc ? decode(teeProg, 'league', rpc.data).playerCount : 'absent'
  console.log(`  [${label}] TEE tx sees: ${line.replace('Program log: ', '')} | TEE getAccountInfo players=${rpcPlayers}`)
  return { line, rpcPlayers, sig }
}

const first = await probe('before change')

const entry = entryPda(L, creator.publicKey)
const joinSig = await send(base, await baseProg.methods
  .joinLeague().accountsPartial({ player: creator.publicKey, league: L, entry }).transaction(), [creator])
console.log('  base-layer change (join_league, player_count 0 -> 1):', explorerBase(joinSig))
const changedAt = Date.now()
const baseNow = decode(baseProg, 'league', (await base.getAccountInfo(L)).data)
console.log('  base layer now has players =', baseNow.playerCount)

let fresh = null
for (const wait of [0, 3, 8, 15, 30, 60, 90]) {
  const target = changedAt + wait * 1000
  if (target > Date.now()) await sleep(target - Date.now())
  const r = await probe(`+${Math.round((Date.now() - changedAt) / 1000)}s`)
  if (r.line.includes('players=1')) { fresh = Math.round((Date.now() - changedAt) / 1000); break }
}
console.log(fresh === null
  ? 'RESULT: the TEE kept serving the STALE copy for 90s after the base-layer change'
  : `RESULT: the TEE saw the updated account ~${fresh}s after the base-layer change`)
const state = loadState()
state.fresh = { account: L.toBase58(), freshAfterSeconds: fresh, firstProbe: first.line }
saveState(state)
