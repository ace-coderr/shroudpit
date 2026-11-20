// Connectivity check for the public devnet endpoints, the Ephemeral Rollups and the Private ER (TEE).
// Read-only except for the optional auth-token signature, which spends nothing.
//
//   KEYPAIR=/path/to/devnet-keypair.json node scripts/connectivity.mjs
import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import nacl from 'tweetnacl'
import { getAuthToken, verifyTeeRpcIntegrity } from '@magicblock-labs/ephemeral-rollups-sdk'

const ENDPOINTS = {
  'base (solana devnet)': 'https://api.devnet.solana.com',
  'router': 'https://devnet-router.magicblock.app',
  'ER asia': 'https://devnet-as.magicblock.app',
  'ER eu': 'https://devnet-eu.magicblock.app',
  'ER us': 'https://devnet-us.magicblock.app',
  'TEE (no token)': 'https://devnet-tee.magicblock.app',
}
const TEE = 'https://devnet-tee.magicblock.app'

async function rpc(url, method, params = []) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    return { ms: Date.now() - t0, status: res.status, body: text.slice(0, 300) }
  } catch (e) {
    return { ms: Date.now() - t0, error: `${e.name}: ${e.message}${e.cause ? ` (${e.cause.code ?? e.cause.message})` : ''}` }
  }
}

function show(label, r) {
  if (r.error) return console.log(`  ${label.padEnd(22)} FAIL ${r.ms}ms  ${r.error}`)
  const ok = r.status === 200 && !r.body.includes('"error"')
  console.log(`  ${label.padEnd(22)} ${ok ? 'OK  ' : 'FAIL'} ${r.ms}ms  HTTP ${r.status}  ${r.body.replace(/\s+/g, ' ').slice(0, 160)}`)
}

console.log('1. Plain RPC reachability (getVersion, getSlot)')
for (const [name, url] of Object.entries(ENDPOINTS)) {
  show(`${name} getVersion`, await rpc(url, 'getVersion'))
  show(`${name} getSlot`, await rpc(url, 'getSlot'))
}

console.log('\n2. TEE integrity attestation')
try {
  await verifyTeeRpcIntegrity(TEE)
  console.log('  attestation OK')
} catch (e) {
  console.log(`  attestation FAIL: ${e?.message ?? e}`)
}

console.log('\n3. TEE auth token')
const keyPath = process.env.KEYPAIR
if (!keyPath) {
  console.log('  skipped: set KEYPAIR to a devnet keypair JSON file')
  process.exit(0)
}
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8'))))
console.log(`  wallet ${kp.publicKey.toBase58()}`)
let token
try {
  const out = await getAuthToken(TEE, kp.publicKey, (m) => Promise.resolve(nacl.sign.detached(m, kp.secretKey)))
  token = out.token
  console.log(`  token OK, expiresAt=${out.expiresAt} (token not printed)`)
} catch (e) {
  console.log(`  token FAIL: ${e?.message ?? e}`)
  if (e?.cause) console.log(`  cause: ${e.cause?.message ?? e.cause}`)
  process.exit(2)
}

console.log('\n4. Authenticated TEE RPC')
const url = `${TEE}?token=${token}`
show('TEE getVersion', await rpc(url, 'getVersion'))
show('TEE getSlot', await rpc(url, 'getSlot'))
show('TEE getHealth', await rpc(url, 'getHealth'))
