// Read-only: can leagues be discovered with no backend? Lists League accounts that are
// undelegated (owned by the program) or delegated (owned by the delegation program, data kept).
import { readFileSync } from 'node:fs'
import { Connection, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { DELEGATION_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk'

const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))
const program = new PublicKey(idl.address)
const disc = (name) => Buffer.from(idl.accounts.find((a) => a.name === name).discriminator)
const c = new Connection('https://api.devnet.solana.com', 'confirmed')

// find League account size from the IDL type
const size = (t) => {
  if (typeof t === 'string') return { u8: 1, i8: 1, u16: 2, u32: 4, i32: 4, u64: 8, i64: 8, bool: 1, pubkey: 32 }[t]
  if (t.array) return size(t.array[0]) * t.array[1]
  throw new Error('unknown type ' + JSON.stringify(t))
}
const structSize = (name) => 8 + idl.types.find((x) => x.name === name).type.fields.reduce((n, f) => n + size(f.type), 0)
const LEAGUE_SIZE = structSize('League')
console.log('League account size', LEAGUE_SIZE)

for (const [label, owner] of [['undelegated', program], ['delegated', DELEGATION_PROGRAM_ID]]) {
  const accs = await c.getProgramAccounts(owner, {
    filters: [{ dataSize: LEAGUE_SIZE }, { memcmp: { offset: 0, bytes: bs58.encode(disc('League')) } }],
  })
  console.log(`${label}: ${accs.length} leagues`)
  for (const a of accs.slice(0, 5)) console.log('  ', a.pubkey.toBase58())
}
