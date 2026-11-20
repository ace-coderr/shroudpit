// Read-only: which endpoints serve the real-time price feed and the VRF queues, and how fresh are prices?
//   KEYPAIR=/path/to/devnet-keypair.json node scripts/probe-accounts.mjs
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import nacl from 'tweetnacl'
import { getAuthToken } from '@magicblock-labs/ephemeral-rollups-sdk'

const ORACLE = new PublicKey('PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd')
const feed = (id) =>
  PublicKey.findProgramAddressSync([Buffer.from('price_feed'), Buffer.from('pyth-lazer'), Buffer.from(id)], ORACLE)[0]

// pyth_lazer ids: 6 = SOL/USD per the docs. Others are looked up from the official feed list below.
const LIST_URL = 'https://raw.githubusercontent.com/magicblock-labs/real-time-pricing-oracle/main/pyth_lazer_list.json'
const list = await (await fetch(LIST_URL)).json()
const wanted = ['SOLUSD', 'BTCUSD', 'ETHUSD']
const feeds = wanted.map((n) => list.find((f) => f.name === n)).filter(Boolean)
console.log('feeds from official list:', feeds.map((f) => `${f.name}(id ${f.pyth_lazer_id}, exp ${f.exponent})`).join(', '))

const QUEUES = {
  'VRF base queue': 'Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh',
  'VRF ER queue': '5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc',
  'VRF program': 'Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz',
}

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.KEYPAIR, 'utf8'))))
const TEE = 'https://devnet-tee.magicblock.app'
const { token } = await getAuthToken(TEE, kp.publicKey, (m) => Promise.resolve(nacl.sign.detached(m, kp.secretKey)))

const endpoints = {
  'base devnet': 'https://api.devnet.solana.com',
  'ER eu': 'https://devnet-eu.magicblock.app',
  'ER as': 'https://devnet-as.magicblock.app',
  'ER us': 'https://devnet-us.magicblock.app',
  'TEE (token)': `${TEE}?token=${token}`,
}

function parse(data, exponent) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const price = Number(dv.getBigInt64(73, true)) * 10 ** exponent
  const publish = Number(dv.getBigInt64(93, true))
  return { price, publish }
}

for (const [name, url] of Object.entries(endpoints)) {
  console.log(`\n== ${name}`)
  const c = new Connection(url, 'confirmed')
  for (const [label, key] of Object.entries(QUEUES)) {
    try {
      const ai = await c.getAccountInfo(new PublicKey(key))
      console.log(`  ${label.padEnd(15)} ${ai ? `present owner=${ai.owner.toBase58().slice(0, 8)}… len=${ai.data.length}` : 'ABSENT'}`)
    } catch (e) {
      console.log(`  ${label.padEnd(15)} ERROR ${String(e.message).slice(0, 100)}`)
    }
  }
  for (const f of feeds) {
    const addr = feed(String(f.pyth_lazer_id))
    try {
      const a = await c.getAccountInfo(addr)
      if (!a) {
        console.log(`  ${f.name.padEnd(15)} ABSENT (${addr.toBase58().slice(0, 8)}…)`)
        continue
      }
      const p1 = parse(a.data, f.exponent)
      await new Promise((r) => setTimeout(r, 1500))
      const p2 = parse((await c.getAccountInfo(addr)).data, f.exponent)
      const age = Math.round(Date.now() / 1000 - p2.publish)
      console.log(
        `  ${f.name.padEnd(15)} owner=${a.owner.toBase58().slice(0, 8)}… price=${p2.price} age=${age}s changed_in_1.5s=${p1.publish !== p2.publish}`,
      )
    } catch (e) {
      console.log(`  ${f.name.padEnd(15)} ERROR ${String(e.message).slice(0, 100)}`)
    }
  }
}
