// Does MagicBlock's own deployed VRF example get its callback on devnet?
// Uses the example programs that are already deployed on devnet; nothing is deployed here.
//
//   MODE=base            roll on the base layer with the base-layer queue (3iSNV84a...)
//   MODE=er VALIDATOR=router|eu|as|<pubkey>
//                        delegate the player to a public ER validator and roll there (nkPMzRtK...)
//
//   KEYPAIR_DIR=/dir IDL_DIR=/dir/with/random_dice*.json WALLET=creator|p2 node scripts/e2e/04-dice.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, PublicKey } from '@solana/web3.js'
import { ConnectionMagicRouter } from '@magicblock-labs/ephemeral-rollups-sdk'
import {
  BASE_RPC, ER_VALIDATOR, decode, explorerBase, loadKeypair, programFor, send, sleep,
} from './lib.mjs'

const MODE = process.env.MODE ?? 'base'
const wallet = loadKeypair(join(process.env.KEYPAIR_DIR, process.env.WALLET === 'p2' ? 'shroudpit-p2.json' : 'shroudpit-devnet.json'))
const BASE_QUEUE = new PublicKey('Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh')
const ER_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc')
const base = new Connection(BASE_RPC, 'confirmed')
const seed = Math.floor(Math.random() * 255)

const idlFile = MODE === 'base' ? 'random_dice.json' : 'random_dice_delegated.json'
const idl = JSON.parse(readFileSync(join(process.env.IDL_DIR, idlFile), 'utf8').replace(/^﻿/, ''))
const programId = new PublicKey(idl.address)
const SEED = Buffer.from(MODE === 'base' ? 'playerd' : 'playerd2')
const player = PublicKey.findProgramAddressSync([SEED, wallet.publicKey.toBuffer()], programId)[0]
const baseProg = programFor(idl, base, wallet)
console.log(`mode=${MODE} program=${programId.toBase58()} wallet=${wallet.publicKey.toBase58().slice(0, 6)}… player=${player.toBase58()}`)

const readPlayer = (prog, ai) => (ai ? decode(prog, 'player', ai.data) : null)

// initialise the player account on the base layer if needed
if (!(await base.getAccountInfo(player))) {
  console.log('  initialize:', explorerBase(await send(base, await baseProg.methods.initialize().accountsPartial({ payer: wallet.publicKey, player }).transaction(), [wallet])))
}

if (MODE === 'base') {
  const before = readPlayer(baseProg, await base.getAccountInfo(player))
  const t0 = Date.now()
  const sig = await send(base, await baseProg.methods.rollDice(seed).accountsPartial({ payer: wallet.publicKey, player, oracleQueue: BASE_QUEUE }).transaction(), [wallet])
  console.log('  roll_dice (VRF request on base layer):', explorerBase(sig))
  for (let i = 0; i < 90; i++) {
    const cur = readPlayer(baseProg, await base.getAccountInfo(player))
    if (cur.rollnum > before.rollnum) {
      console.log(`RESULT base layer: callback FIRED after ~${Math.round((Date.now() - t0) / 1000)}s, last_result=${cur.lastResult}, rollnum=${cur.rollnum}`)
      process.exit(0)
    }
    await sleep(2000)
  }
  console.log('RESULT base layer: callback did NOT fire within 180s')
  process.exit(3)
}

// ---- ER mode ----
let validator, fqdn
const which = process.env.VALIDATOR ?? 'router'
if (which === 'router') {
  const router = new ConnectionMagicRouter('https://devnet-router.magicblock.app', { wsEndpoint: 'wss://devnet-router.magicblock.app' })
  const r = await router.getClosestValidator()
  validator = new PublicKey(r.identity)
  fqdn = r.fqdn
  console.log(`router says closest validator: ${r.identity} ${r.fqdn}`)
} else if (ER_VALIDATOR[which]) {
  validator = ER_VALIDATOR[which]
  fqdn = `https://devnet-${which}.magicblock.app`
} else {
  validator = new PublicKey(which)
  fqdn = process.env.FQDN
}
const er = new Connection(fqdn, { wsEndpoint: fqdn.replace('https', 'wss'), commitment: 'confirmed' })
const erProg = programFor(idl, er, wallet)

const baseInfo = await base.getAccountInfo(player)
if (baseInfo.owner.toBase58() === programId.toBase58()) {
  const delSig = await send(base, await baseProg.methods.delegate().accountsPartial({ user: wallet.publicKey, player })
    .remainingAccounts([{ pubkey: validator, isSigner: false, isWritable: false }]).transaction(), [wallet])
  console.log('  delegate ->', fqdn, ':', explorerBase(delSig))
} else {
  console.log('  player already delegated; reusing')
}
for (let i = 0; i < 40; i++) {
  if (await er.getAccountInfo(player)) break
  await sleep(1500)
}
const before = readPlayer(erProg, await er.getAccountInfo(player))
const t0 = Date.now()
const sig = await send(er, await erProg.methods.rollDiceDelegated(seed).accountsPartial({ payer: wallet.publicKey, player, oracleQueue: ER_QUEUE }).transaction(), [wallet], { skipPreflight: true })
console.log(`  roll_dice_delegated (VRF request on ${fqdn}): https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(fqdn)}`)
const tx = await er.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
for (const l of tx?.meta?.logMessages ?? []) console.log('    ', l)
for (let i = 0; i < 120; i++) {
  try {
    const cur = readPlayer(erProg, await er.getAccountInfo(player))
    if (cur.rollnum > before.rollnum) {
      console.log(`RESULT ER ${fqdn}: callback FIRED after ~${Math.round((Date.now() - t0) / 1000)}s, last_result=${cur.lastResult}, rollnum=${cur.rollnum}`)
      process.exit(0)
    }
  } catch (e) {
    console.log('  read error, retrying:', String(e.message).slice(0, 60))
  }
  await sleep(1000)
}
console.log(`RESULT ER ${fqdn}: callback did NOT fire within 120s`)
process.exit(3)
