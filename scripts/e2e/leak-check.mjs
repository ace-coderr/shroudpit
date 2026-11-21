// What can a NON-MEMBER learn from a position transaction inside the Private ER?
//   SIG=<signature> KEYPAIR_DIR=/dir node scripts/e2e/leak-check.mjs
// Fetches the transaction with (a) the owner's token and (b) a brand-new key's token, and prints
// everything an outsider receives: accounts, instruction data, logs, balances.
import { join } from 'node:path'
import { Keypair } from '@solana/web3.js'
import { loadKeypair, teeConnection } from './lib.mjs'

const owner = loadKeypair(join(process.env.KEYPAIR_DIR, 'shroudpit-devnet.json'))
const outsider = Keypair.generate()
const sig = process.env.SIG

for (const [who, kp] of [['OWNER', owner], ['OUTSIDER (new key)', outsider]]) {
  const conn = await teeConnection(kp)
  console.log(`\n=== fetched as ${who}`)
  try {
    const raw = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
    if (!raw) {
      console.log('  -> null (nothing returned)')
      continue
    }
    const msg = raw.transaction.message
    const keys = msg.staticAccountKeys ?? msg.accountKeys
    const ixs = msg.compiledInstructions ?? msg.instructions
    console.log('  account keys:', keys.length)
    for (const ix of ixs) {
      const data = ix.data instanceof Uint8Array ? Buffer.from(ix.data) : Buffer.from(ix.data ?? '', 'base64')
      console.log(`  instruction data (${data.length} bytes): ${data.toString('hex')}`)
    }
    console.log('  logs:', raw.meta?.logMessages?.length ?? 0, 'lines')
    console.log('  pre/post balances present:', !!raw.meta?.preBalances?.length)
    console.log('  signatures:', raw.transaction.signatures.length)
  } catch (e) {
    console.log('  error:', String(e.message).slice(0, 80))
  }
}
