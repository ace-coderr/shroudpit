// Show recent transactions touching an account inside the Private ER, with logs (as the creator).
//   ACCOUNT=<pubkey> LIMIT=8 KEYPAIR_DIR=/dir node scripts/e2e/tx-logs.mjs
import { join } from 'node:path'
import { PublicKey } from '@solana/web3.js'
import { loadKeypair, teeConnection } from './lib.mjs'

const creator = loadKeypair(join(process.env.KEYPAIR_DIR, 'shroudpit-devnet.json'))
const tee = await teeConnection(creator)
const sigs = await tee.getSignaturesForAddress(new PublicKey(process.env.ACCOUNT), { limit: Number(process.env.LIMIT ?? 8) })
console.log(`${sigs.length} signatures`)
for (const s of sigs) {
  console.log(`- ${s.signature.slice(0, 16)}… slot=${s.slot} err=${JSON.stringify(s.err)}`)
  try {
    const t = await tee.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
    for (const l of t?.meta?.logMessages ?? []) console.log(`    ${l}`)
  } catch (e) {
    console.log(`    (no logs: ${String(e.message).slice(0, 50)})`)
  }
}
