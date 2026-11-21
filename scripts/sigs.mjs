// Read-only: list recent transactions touching an account on an ER and print logs/errors.
//   node scripts/sigs.mjs <rpc-url> <account> [limit]
import { Connection, PublicKey } from '@solana/web3.js'

const [url, account, limit = '10'] = process.argv.slice(2)
const c = new Connection(url, 'confirmed')
const sigs = await c.getSignaturesForAddress(new PublicKey(account), { limit: Number(limit) })
console.log(`${sigs.length} signatures for ${account}`)
for (const s of sigs) {
  console.log(`- ${s.signature.slice(0, 20)}… slot=${s.slot} err=${JSON.stringify(s.err)}`)
  try {
    const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
    for (const l of tx?.meta?.logMessages ?? []) console.log(`    ${l}`)
  } catch (e) {
    console.log(`    (could not fetch: ${String(e.message).slice(0, 60)})`)
  }
}
