// Read-only: which validator is the VRF ER queue (and the price feed) delegated to?
import { Connection, PublicKey } from '@solana/web3.js'
import { delegationRecordPdaFromDelegatedAccount, parseDelegationRecordAccount } from '@magicblock-labs/ephemeral-rollups-sdk'

const base = new Connection('https://api.devnet.solana.com', 'confirmed')
const NAMES = {
  MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57: 'devnet-as',
  MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e: 'devnet-eu',
  MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd: 'devnet-us',
  MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo: 'devnet-tee',
}
const targets = {
  'VRF ER queue': '5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc',
  'price feed SOL/USD': 'ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu',
  'VRF base queue': 'Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh',
}
for (const [label, key] of Object.entries(targets)) {
  const pk = new PublicKey(key)
  const acc = await base.getAccountInfo(pk)
  const rec = await base.getAccountInfo(delegationRecordPdaFromDelegatedAccount(pk))
  if (!rec) {
    console.log(`${label}: owner ${acc?.owner.toBase58()} | no delegation record (not delegated)`)
    continue
  }
  const parsed = parseDelegationRecordAccount(rec)
  const v = (parsed.validator ?? parsed.authority)?.toBase58?.() ?? JSON.stringify(Object.keys(parsed ?? {}))
  console.log(`${label}: delegated to ${v} ${NAMES[v] ? `(${NAMES[v]})` : '(unknown validator)'}`)
}
