// Trigger settle_and_reveal on an existing league with a brand-new, never-funded key, and report
// the league's phase before and after. Entries and score cards are discovered from chain, so any
// set of players works. Used to settle late (void) rounds and rescue stuck leagues.
//   LEAGUE=<pubkey> node scripts/e2e/settle-league.mjs
// Before the hidden close this is a no-op; inside the window it scores the round; after the window
// it voids the round.
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import {
  BASE_RPC, SOL_USD_FEED, decode, discoverEntries, explorerTee, programFor, send, teeConnection, withCU,
} from './lib.mjs'

if (!process.env.LEAGUE) throw new Error('set LEAGUE=<league pubkey>')
const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))
const league = new PublicKey(process.env.LEAGUE)
const secret = PublicKey.findProgramAddressSync([Buffer.from('secret'), league.toBuffer()], new PublicKey(idl.address))[0]
const helper = Keypair.generate()
const base = new Connection(BASE_RPC, 'confirmed')
const tee = await teeConnection(helper)
const prog = programFor(idl, tee, helper)
const read = async () => {
  const ai = await tee.getAccountInfo(league)
  return ai ? decode(prog, 'league', ai.data) : null
}

const before = await read()
console.log('before: status', before?.status, 'round', before?.round, '(2 = Live, 3 = Between, 4 = Finished, 6 = Finishing)')
const { entries, pairs } = await discoverEntries(base, prog, league)
console.log(`found ${entries.length} entries on chain (league expects ${before?.playerCount})`)
const tx = await prog.methods.settleAndReveal().accountsPartial({ league, secret, priceFeed: SOL_USD_FEED }).remainingAccounts(pairs).transaction()
try {
  const sig = await send(tee, withCU(tx), [helper], { skipPreflight: true })
  console.log('settle_and_reveal by an unfunded key:', explorerTee(sig))
} catch (e) {
  console.log('settle_and_reveal FAILED:', e.message)
}
await new Promise((r) => setTimeout(r, 6000))
const after = await read()
console.log('after : status', after?.status ?? '(left the rollup: finished)', 'round', after?.round, 'settle_price', after?.settlePrice?.toString())
