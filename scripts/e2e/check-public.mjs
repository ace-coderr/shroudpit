// Keep polling public-ER VRF test leagues (resilient to transient network errors).
//   EU_LEAGUE=<pubkey> AS_LEAGUE=<pubkey> KEYPAIR_DIR=/dir node scripts/e2e/check-public.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, PublicKey } from '@solana/web3.js'
import { decode, loadKeypair, programFor, sleep } from './lib.mjs'

const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))
const creator = loadKeypair(join(process.env.KEYPAIR_DIR, 'shroudpit-devnet.json'))
const minutes = Number(process.env.MINUTES ?? 3)

const targets = [['eu', process.env.EU_LEAGUE], ['as', process.env.AS_LEAGUE]]
  .filter(([, league]) => league)
  .map(([which, league]) => ({
    which,
    league: new PublicKey(league),
    conn: new Connection(`https://devnet-${which}.magicblock.app`, 'confirmed'),
  }))
if (targets.length === 0) throw new Error('set EU_LEAGUE and/or AS_LEAGUE')
const prog = programFor(idl, targets[0].conn, creator)

const end = Date.now() + minutes * 60_000
const fired = {}
while (Date.now() < end && Object.keys(fired).length < targets.length) {
  for (const t of targets) {
    if (fired[t.which]) continue
    try {
      const ai = await t.conn.getAccountInfo(t.league)
      const l = ai && decode(prog, 'league', ai.data)
      if (l?.status === 2) {
        fired[t.which] = true
        console.log(`${t.which}: callback_close FIRED, randomness ${Buffer.from(l.randomness).toString('hex')}`)
      }
    } catch (e) {
      console.log(`${t.which}: read error (retrying): ${String(e.message).slice(0, 60)}`)
    }
  }
  await sleep(5000)
}
for (const t of targets) {
  if (fired[t.which]) continue
  try {
    const l = decode(prog, 'league', (await t.conn.getAccountInfo(t.league)).data)
    console.log(`${t.which}: NOT fired, status still ${l.status} after ${minutes} more minutes`)
  } catch (e) {
    console.log(`${t.which}: could not read: ${String(e.message).slice(0, 60)}`)
  }
}
