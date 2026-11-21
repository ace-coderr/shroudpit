// Simulate settle_and_reveal on a league inside the Private ER and print the result and logs.
//   LEAGUE=<pubkey> KEYPAIR_DIR=/dir node scripts/e2e/simulate-settle.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Keypair, PublicKey } from '@solana/web3.js'
import { SOL_USD_FEED, entryPda, loadKeypair, programFor, sortKeys, teeConnection } from './lib.mjs'

const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))
const creator = loadKeypair(join(process.env.KEYPAIR_DIR, 'shroudpit-devnet.json'))
const wallets = ['shroudpit-devnet.json', 'shroudpit-p2.json', 'shroudpit-p3.json'].map((f) => loadKeypair(join(process.env.KEYPAIR_DIR, f)))
const league = new PublicKey(process.env.LEAGUE)
const secret = PublicKey.findProgramAddressSync([Buffer.from('secret'), league.toBuffer()], new PublicKey(idl.address))[0]
const tee = await teeConnection(creator)
const prog = programFor(idl, tee, creator)
const remaining = sortKeys(wallets.map((w) => entryPda(league, w.publicKey))).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))

const tx = await prog.methods.settleAndReveal().accountsPartial({ league, secret, priceFeed: SOL_USD_FEED }).remainingAccounts(remaining).transaction()
tx.feePayer = creator.publicKey
tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash
tx.sign(creator)
console.log('account keys in the transaction:')
tx.compileMessage().accountKeys.forEach((k, i) => console.log(`  ${i} ${k.toBase58()}`))
const sim = await tee.simulateTransaction(tx)
console.log('simulation err:', JSON.stringify(sim.value.err))
for (const l of sim.value.logs ?? ['(no logs)']) console.log('  ', l)

// which of the accounts exist inside the rollup?
for (const [name, key] of [['league', league], ['secret', secret], ['price feed', SOL_USD_FEED], ...remaining.map((r, i) => [`entry ${i}`, r.pubkey])]) {
  const ai = await tee.getAccountInfo(key).catch((e) => ({ error: e.message }))
  console.log(`  exists in TEE: ${name.padEnd(10)} ${ai ? (ai.error ? `error ${ai.error.slice(0, 40)}` : `yes owner ${ai.owner.toBase58().slice(0, 8)}`) : 'NO'}`)
}
void Keypair
