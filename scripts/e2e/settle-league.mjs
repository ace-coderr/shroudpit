// Trigger settle_and_reveal on an existing league with a brand-new, never-funded key, and report
// the league's phase before and after. Used to test late triggers and rescue stuck test leagues.
//   LEAGUE=<pubkey> WALLETS=3 KEYPAIR_DIR=/dir node scripts/e2e/settle-league.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  SOL_USD_FEED, decode, entryPda, explorerTee, loadKeypair, programFor, send, sortKeys, teeConnection,
} from './lib.mjs'

const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))
const files = ['shroudpit-devnet.json', 'shroudpit-p2.json', 'shroudpit-p3.json', 'shroudpit-p4.json'].slice(0, Number(process.env.WALLETS ?? 3))
const wallets = files.map((f) => loadKeypair(join(process.env.KEYPAIR_DIR, f)))
const league = new PublicKey(process.env.LEAGUE)
const secret = PublicKey.findProgramAddressSync([Buffer.from('secret'), league.toBuffer()], new PublicKey(idl.address))[0]
const helper = Keypair.generate()
const tee = await teeConnection(helper)
const prog = programFor(idl, tee, helper)
const read = async () => {
  const ai = await tee.getAccountInfo(league)
  return ai ? decode(prog, 'league', ai.data) : null
}

const before = await read()
console.log('before: status', before?.status, 'round', before?.round, '(2 = Live, 3 = Between, 4 = Finished)')
const remaining = sortKeys(wallets.map((w) => entryPda(league, w.publicKey))).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))
const tx = await prog.methods.settleAndReveal().accountsPartial({ league, secret, priceFeed: SOL_USD_FEED }).remainingAccounts(remaining).transaction()
try {
  const sig = await send(tee, tx, [helper], { skipPreflight: true })
  console.log('settle_and_reveal by an unfunded key:', explorerTee(sig))
} catch (e) {
  console.log('settle_and_reveal FAILED:', e.message)
}
await new Promise((r) => setTimeout(r, 6000))
const after = await read()
console.log('after : status', after?.status ?? '(left the rollup: finished)', 'round', after?.round, 'settle_price', after?.settlePrice?.toString())
