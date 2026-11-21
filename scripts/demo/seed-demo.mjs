// Seed real demo data on devnet for the video. Everything here is a real transaction signed by real
// wallets; nothing is mocked.
//
//   1. runs a complete league (3 wallets, VRF mixed in) so the Audit, Standings and Record pages have
//      a finished league with revealed results and explorer links,
//   2. has the winner claim the league's trophy,
//   3. creates a second league that is left OPEN, so a wallet can be joined live on camera.
//
//   KEYPAIR_DIR=/dir/with/devnet/keypairs [ROUNDS=1] node scripts/demo/seed-demo.mjs
//
// Rounds default to 1. With more rounds, each settled round reveals its positions, so a later
// round could copy an earlier one (see "Reveal policy" in the README).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import BN from 'bn.js'
import { BASE_RPC, explorerBase, leaguePda, loadKeypair, programFor, send, entryPda, TEE_VALIDATOR } from '../e2e/lib.mjs'

const DIR = process.env.KEYPAIR_DIR
if (!DIR) throw new Error('set KEYPAIR_DIR to the directory holding the devnet keypairs')
const ROUNDS = process.env.ROUNDS ?? '1'
const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))

function run(label, script, env) {
  console.log(`\n### ${label}`)
  const r = spawnSync('node', [script], { stdio: 'inherit', env: { ...process.env, ...env } })
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`)
}

// 1. a complete league
run('Playing a complete league on devnet', 'scripts/e2e/10-round.mjs', {
  WALLETS: '3', CLOSE_MODE: '1', ROUNDS, HELPER: '1',
})
const state = JSON.parse(readFileSync('.e2e/state.json', 'utf8'))
const finished = state.round.league
console.log('\nfinished league:', finished)

// 2. the winner claims the trophy
run('Winner claims the trophy', 'scripts/e2e/claim-trophy.mjs', { LEAGUE: finished })

// 3. an open league for a live join
const creator = loadKeypair(join(DIR, 'shroudpit-devnet.json'))
const base = new Connection(BASE_RPC, 'confirmed')
const prog = programFor(idl, base, creator)
const id = Date.now()
const league = leaguePda(creator.publicKey, id)
const secret = PublicKey.findProgramAddressSync([Buffer.from('secret'), league.toBuffer()], new PublicKey(idl.address))[0]
console.log('\n### Creating an open league to join live')
const createSig = await send(base, await prog.methods
  .createLeague(new BN(id), 2, 60, 120, 4, 6, 1).accountsPartial({ creator: creator.publicKey, league, secret }).transaction(), [creator])
console.log('  create_league:', explorerBase(createSig))
const entry = entryPda(league, creator.publicKey)
const joinIx = await prog.methods.joinLeague().accountsPartial({ player: creator.publicKey, league, entry }).instruction()
const delegateIx = await prog.methods.delegateEntry().accountsPartial({ player: creator.publicKey, league, entry, validator: TEE_VALIDATOR }).instruction()
console.log('  creator joined:', explorerBase(await send(base, new Transaction().add(joinIx, delegateIx), [creator])))

console.log('\n=== demo data ready ===')
console.log('finished league :', finished, ' -> #/audit/<league>, #/standings/<league>, #/record')
console.log('open league     :', league.toBase58(), ' -> #/lobby (join with another wallet), #/desk/<league>')
