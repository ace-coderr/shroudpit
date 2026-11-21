// Read-only: what does an entry's permission account look like inside the TEE?
//   LEAGUE=<pubkey> KEYPAIR_DIR=/dir node scripts/e2e/inspect-permission.mjs
import { join } from 'node:path'
import { PublicKey } from '@solana/web3.js'
import { entryPda, loadKeypair, permissionPda, teeConnection } from './lib.mjs'

const creator = loadKeypair(join(process.env.KEYPAIR_DIR, 'shroudpit-devnet.json'))
const league = new PublicKey(process.env.LEAGUE)
const tee = await teeConnection(creator)
const entry = entryPda(league, creator.publicKey)
const perm = permissionPda(entry)
console.log('entry     ', entry.toBase58())
console.log('permission', perm.toBase58())
const ai = await tee.getAccountInfo(perm)
if (!ai) {
  console.log('permission account: NOT FOUND (as creator)')
} else {
  console.log('owner     ', ai.owner.toBase58())
  console.log('lamports  ', ai.lamports)
  console.log('data len  ', ai.data.length, 'hex', ai.data.toString('hex').slice(0, 200))
  console.log('executable', ai.executable)
}
const e = await tee.getAccountInfo(entry)
console.log('entry exists in TEE for creator:', !!e, 'owner', e?.owner.toBase58())
