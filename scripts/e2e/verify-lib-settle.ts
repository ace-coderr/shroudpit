// Runs the REAL front-end functions (src/lib/actions.ts, the same code the Desk and Audit pages
// call) against a throwaway league on devnet, and checks what settle does at each moment:
//   (a) before the hidden close      -> no-op, the round stays Live
//   (b) inside the settlement window -> scores the round
//   (c) after the window             -> voids the round (no scores)
//   (d) the final round              -> settle, chunked reveal_entries, finish_league
//
//   KEYPAIR_DIR=/dir npx tsx scripts/e2e/verify-lib-settle.ts
//
// Uses two wallets from KEYPAIR_DIR (shroudpit-devnet.json, shroudpit-p2.json). Close mode 0
// (nonces + slot) keeps each round short. About 8 minutes end to end.
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import nacl from 'tweetnacl'
import * as lib from '../../src/lib/actions'
import { baseConnection, fetchCards, fetchLeague, priceFeedPda } from '../../src/lib/chain'
import type { LeagueView } from '../../src/lib/chain'
import { sendBase } from '../../src/lib/session'
import type { Signer } from '../../src/lib/session'

const DIR = process.env.KEYPAIR_DIR
if (!DIR) throw new Error('set KEYPAIR_DIR')
const load = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(DIR, f), 'utf8'))))
const asSigner = (kp: Keypair): Signer => ({
  publicKey: kp.publicKey,
  signTransaction: async (tx) => (tx.partialSign(kp), tx),
  signMessage: async (m) => nacl.sign.detached(m, kp.secretKey),
})
const A = load('shroudpit-devnet.json')
const B = load('shroudpit-p2.json')
const sA = asSigner(A)
const sB = asSigner(B)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
const tee = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent('https://devnet-tee.magicblock.app')}`
const base = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`
const results: [string, boolean, string][] = []
const check = (name: string, ok: boolean, detail: string) => {
  results.push([name, ok, detail])
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`)
}

async function retry<T>(label: string, fn: () => Promise<T>, tries = 15): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= tries) throw e
      console.log(`   (${label}: ${String((e as Error).message).slice(0, 70)}; retrying)`)
      await sleep(3000)
    }
  }
}
const read = async (key: PublicKey): Promise<LeagueView> => {
  const l = await fetchLeague(key)
  if (!l) throw new Error('league not found')
  return l
}

// the Desk's helper: a throwaway key that holds nothing
const helperKp = lib.helperKeypair()
const helperConn = await lib.helperConnection()

// ---------------------------------------------------------------- setup
console.log('balances (SOL):', (await baseConnection.getBalance(A.publicKey)) / 1e9, (await baseConnection.getBalance(B.publicKey)) / 1e9)
if ((await baseConnection.getBalance(B.publicKey)) < 0.05e9) {
  const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: A.publicKey, toPubkey: B.publicKey, lamports: 0.1e9 }))
  console.log('  topped up the second wallet:', base(await sendBase(baseConnection, sA, t)))
}
const { league: key, signature } = await lib.createLeague(sA, { rounds: 3, minSecs: 30, maxSecs: 45, maxPlayers: 2, feedId: 6, closeMode: 0 })
console.log('\nthrowaway league', key.toBase58(), '\n  create_league:', base(signature))
console.log('  join A:', base(await lib.joinLeague(sA, key)))
console.log('  join B:', base(await lib.joinLeague(sB, key)))
console.log('  delegate_league:', base(await lib.startLeague(sA, key)))
console.log('  init_secret_permission:', tee(await retry('secret perm', () => lib.sealSecret(sA, key))))
console.log('  seal A:', tee(await retry('seal A', () => lib.sealEntry(sA, key))))
console.log('  seal B:', tee(await retry('seal B', () => lib.sealEntry(sB, key))))
const feed = priceFeedPda(6)

async function goLive(round: number) {
  console.log(`\n===== round ${round + 1} of 3: open, nonces, lock-in =====`)
  console.log('  start_round:', tee(await retry('start_round', () => lib.openRound(sA, key), 5)))
  console.log('  nonce A:', tee(await lib.commitNonce(sA, key)))
  console.log('  nonce B:', tee(await lib.commitNonce(sB, key)))
  console.log('  lock_in (Desk helper):', tee(await lib.lockIn(helperKp, helperConn, key)))
  const l = await read(key)
  check(`round ${round + 1} is Live after lock-in`, l.status === 2, `status ${l.status}`)
  console.log('  position A long x2:', tee(await lib.setPosition(sA, key, feed, 1, 2)))
  console.log('  position B short x1:', tee(await lib.setPosition(sB, key, feed, -1, 1)))
  return l
}
const settleOnce = async () => lib.settle(helperKp, helperConn, key, feed)
const scoredCount = async () => (await fetchCards(key)).map((c) => c.roundsScored)

// ---------------------------------------------------------------- round 1: (a) and (b)
let l = await goLive(0)
{
  const price0 = l.settlePrice
  console.log('\n(a) settle before the hidden close')
  console.log('  settle:', tee(await settleOnce()))
  await sleep(3000)
  l = await read(key)
  check('(a) settle before close is a no-op', l.status === 2 && l.round === 0 && l.settlePrice === price0, `status ${l.status}, round ${l.round}`)

  console.log('\n(b) settle inside the window (polling like the Desk helper)')
  const t0 = now()
  let settleSig = ''
  while (now() - t0 < 160) {
    l = await read(key)
    if (l.status !== 2) break
    try {
      settleSig = await settleOnce()
      await sleep(1500)
    } catch (e) {
      console.log('  settle attempt failed:', (e as Error).message)
      await sleep(3000)
    }
  }
  l = await read(key)
  console.log('  settled by:', settleSig ? tee(settleSig) : '(see above)')
  const cards = await scoredCount()
  check('(b) in-window settle scores the round', l.status === 3 && l.round === 1 && l.settlePrice > 0 && cards.every((c) => c === 1),
    `status ${l.status}, round ${l.round}, settlePrice ${l.settlePrice}, roundsScored ${cards.join('/')}`)
}

// ---------------------------------------------------------------- round 2: (c) void
l = await goLive(1)
const priceBefore = l.settlePrice
{
  console.log('\n(c) settle AFTER the window: not touched until close + 60 s has certainly passed')
  const until = l.roundStartedAt + l.maxSecs + 60 + 6
  while (now() < until) {
    process.stdout.write(`\r  waiting ${until - now()} s   `)
    await sleep(2000)
  }
  console.log()
  l = await read(key)
  check('(c) round is still Live before the late settle', l.status === 2, `status ${l.status}`)
  console.log('  late settle:', tee(await settleOnce()))
  await sleep(3000)
  l = await read(key)
  const cards = await scoredCount()
  check('(c) late settle voids the round', l.status === 3 && l.round === 2 && l.settlePrice === priceBefore && cards.every((c) => c === 1),
    `status ${l.status}, round ${l.round}, settlePrice unchanged ${l.settlePrice === priceBefore}, roundsScored ${cards.join('/')}`)
}

// ---------------------------------------------------------------- round 3: (d) final round, reveal, finish
l = await goLive(2)
{
  console.log('\n(d) final round: settle in the window, then the chunked reveal and finish_league')
  const t0 = now()
  while (now() - t0 < 160) {
    l = await read(key)
    if (l.status !== 2) break
    try {
      await settleOnce()
      await sleep(1500)
    } catch (e) {
      console.log('  settle attempt failed:', (e as Error).message)
      await sleep(3000)
    }
  }
  l = await read(key)
  check('(d) final settle moves the league to Finishing', l.status === 6, `status ${l.status}, round ${l.round}`)

  const t1 = now()
  while (now() - t1 < 150) {
    l = await read(key)
    if (l.status === 4 && !l.delegated) break
    try {
      if (l.status === 6) {
        if (l.revealedCount < l.playerCount) console.log(`  reveal_entries from ${l.revealedCount}:`, tee(await lib.revealEntries(helperKp, helperConn, key, l.revealedCount)))
        else console.log('  finish_league:', tee(await lib.finishLeague(helperKp, helperConn, key)))
      }
    } catch (e) {
      console.log('  reveal step failed:', (e as Error).message)
    }
    await sleep(4000)
  }
  l = await read(key)
  const cards = await scoredCount()
  check('(d) league Finished and back on the base layer', l.status === 4 && !l.delegated, `status ${l.status}, delegated ${l.delegated}`)
  check('(d) a winner is recorded', l.winner.toBase58() !== PublicKey.default.toBase58(), l.winner.toBase58())
  check('(d) cards: 2 scored rounds each (rounds 1 and 3; round 2 was void)', cards.every((c) => c === 2), `roundsScored ${cards.join('/')}`)
}

console.log('\n==== summary ====')
for (const [n, ok, d] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  (${d})`)
console.log('throwaway league:', key.toBase58())
process.exit(results.every((r) => r[1]) ? 0 : 1)
