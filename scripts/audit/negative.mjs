// Negative audit tests, run against the deployed program on devnet with a throwaway league.
// Every test sends a transaction the program must REJECT and records the error code it returned
// and the transaction link. A test that is accepted is a hole and is flagged loudly.
//
//   KEYPAIR_DIR=/dir/with/devnet/keypairs node scripts/audit/negative.mjs
//
// Uses three wallets (shroudpit-devnet.json = creator, shroudpit-p2.json, shroudpit-p3.json) plus
// throwaway keys for an outsider and a "helper". About 4 minutes end to end. Results are printed and
// written to .e2e/audit-negative.json (git-ignored).
//
// Test ids follow the task: 1 commit after lock-in, 2 double commit, 3 callback_close, 4 wrong
// price feed, 5 double join, 6 wrong entry set at settlement, 7 reveal chunks, 8 wrong validator or
// delegation account, 9 set_position by a non-owner and after the close, 10 non-creator actions.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import BN from 'bn.js'
import {
  BASE_RPC, ER_VALIDATOR, ORACLE, SOL_USD_FEED, TEE_VALIDATOR, cardPda, decode, entryPda, explorerBase, explorerTee,
  leaguePda, loadKeypair, permissionPda, programFor, send, sleep, sortKeys, teeConnection, withCU,
} from '../e2e/lib.mjs'

const DIR = process.env.KEYPAIR_DIR
if (!DIR) throw new Error('set KEYPAIR_DIR to the directory holding the devnet keypairs')
const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))
const PROGRAM = new PublicKey(idl.address)

// ---------------------------------------------------------------- error names
const NAMES = new Map(idl.errors.map((e) => [e.code, e.name]))
const FRAMEWORK = {
  0: 'system: account already in use',
  2000: 'ConstraintMut', 2003: 'ConstraintRaw', 2006: 'ConstraintSeeds', 2012: 'ConstraintAddress',
  3001: 'AccountDiscriminatorNotFound', 3002: 'AccountDiscriminatorMismatch', 3007: 'AccountOwnedByWrongProgram',
  3010: 'AccountNotSigner', 3012: 'AccountNotInitialized',
}
const label = (code) => `${NAMES.get(code) ?? FRAMEWORK[code] ?? 'code'} (${code})`
function parseError(e) {
  const text = (v) => (typeof v === 'string' ? v : (() => { try { return JSON.stringify(v) } catch { return String(v) } })())
  const message = text(e?.message ?? e) + (e?.logs ? ' | ' + e.logs.join(' | ') : '')
  const m = message.match(/"Custom":(\d+)/)
  const code = m ? Number(m[1]) : null
  return { code, name: code === null ? null : label(code), raw: message.slice(0, 220), sig: e?.sig ?? null }
}

// ---------------------------------------------------------------- result log
const results = []
const holes = []
const link = (layer, sig) => (sig ? (layer === 'tee' ? explorerTee(sig) : explorerBase(sig)) : null)

/**
 * Run a transaction that must be rejected. `expected` lists the acceptable error codes (empty =
 * any rejection is fine). `retryOn` codes mean "the test was not reached yet" (for example the
 * oracle price is a moment older than the close), so the call is repeated.
 */
async function expectFail(id, title, layer, expected, run, { retryOn = [], tries = 1, note = '' } = {}) {
  let outcome = null
  for (let i = 0; i < tries; i++) {
    try {
      outcome = { accepted: true, sig: await run() }
      break
    } catch (e) {
      outcome = { accepted: false, ...parseError(e) }
      if (retryOn.includes(outcome.code) && i < tries - 1) {
        await sleep(1500)
        continue
      }
      break
    }
  }
  const row = {
    id, title, layer, note,
    expected: expected.length ? expected.map(label).join(' or ') : 'any rejection',
    actual: outcome.accepted ? 'ACCEPTED' : (outcome.name ?? `rejected: ${outcome.raw}`),
    verdict: outcome.accepted ? 'HOLE' : expected.length === 0 || expected.includes(outcome.code) ? 'PASS' : 'REJECTED, DIFFERENT CODE',
    tx: link(layer, outcome.sig),
  }
  results.push(row)
  if (row.verdict === 'HOLE') holes.push(row)
  console.log(`  [${row.verdict}] ${id} ${title}\n      expected ${row.expected}; actual ${row.actual}\n      ${row.tx ?? '(no transaction)'}`)
  return row
}
function record(id, title, layer, expected, actual, ok, sig, note = '') {
  const row = { id, title, layer, note, expected, actual, verdict: ok ? 'PASS' : 'FAIL', tx: link(layer, sig) }
  results.push(row)
  if (!ok) holes.push(row)
  console.log(`  [${row.verdict}] ${id} ${title}\n      expected ${expected}; actual ${actual}\n      ${row.tx ?? ''}`)
}

async function retry(label, fn, tries = 12) {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= tries) throw e
      console.log(`   (${label}: ${String(e.message).slice(0, 70)}; retrying)`)
      await sleep(3000)
    }
  }
}

// ---------------------------------------------------------------- setup
const A = loadKeypair(join(DIR, 'shroudpit-devnet.json')) // creator and player
const B = loadKeypair(join(DIR, 'shroudpit-p2.json'))
const C = loadKeypair(join(DIR, 'shroudpit-p3.json'))
const D = Keypair.generate() // outsider: never funded, never joined
const H = Keypair.generate() // helper: triggers lock-in and settlement, never funded
const X = Keypair.generate() // attacker for the direct callback_close call
const BTC_FEED = PublicKey.findProgramAddressSync([Buffer.from('price_feed'), Buffer.from('pyth-lazer'), Buffer.from('1')], ORACLE)[0]
const base = new Connection(BASE_RPC, 'confirmed')
const baseProg = (kp) => programFor(idl, base, kp)
const sendBase = async (kp, tx) => {
  for (let i = 0; ; i++) {
    try {
      return await send(base, tx, [kp], { skipPreflight: true })
    } catch (e) {
      // a rejection by the program carries a signature; anything without one never reached the chain
      if (e?.sig || i >= 4) throw e
      await sleep(2500)
    }
  }
}

console.log('balances (SOL):', ...(await Promise.all([A, B, C].map(async (k) => ((await base.getBalance(k.publicKey)) / 1e9).toFixed(3)))))
for (const k of [B, C]) {
  if ((await base.getBalance(k.publicKey)) < 0.08e9) {
    await sendBase(A, new Transaction().add(SystemProgram.transfer({ fromPubkey: A.publicKey, toPubkey: k.publicKey, lamports: 0.12e9 })))
    console.log('  topped up', k.publicKey.toBase58().slice(0, 6))
  }
}

const leagueId = Date.now()
const league = leaguePda(A.publicKey, leagueId)
const secret = PublicKey.findProgramAddressSync([Buffer.from('secret'), league.toBuffer()], PROGRAM)[0]
const E = { A: entryPda(league, A.publicKey), B: entryPda(league, B.publicKey), C: entryPda(league, C.publicKey) }
const CARD = { A: cardPda(league, A.publicKey), B: cardPda(league, B.publicKey), C: cardPda(league, C.publicKey) }
console.log('\nthrowaway league', league.toBase58(), '(3 players, 1 round, close 30 to 45 s, nonces + slot)')

const sigCreate = await sendBase(A, await baseProg(A).methods
  .createLeague(new BN(leagueId), 1, 30, 45, 4, 6, 0).accountsPartial({ creator: A.publicKey, league, secret }).transaction())
console.log('  create_league:', explorerBase(sigCreate))
const joinIx = (kp) => baseProg(kp).methods.joinLeague().accountsPartial({ player: kp.publicKey, league, entry: entryPda(league, kp.publicKey) }).instruction()
const delegateEntryIx = (kp, validator) =>
  baseProg(kp).methods.delegateEntry().accountsPartial({ player: kp.publicKey, league, entry: entryPda(league, kp.publicKey), validator }).instruction()
for (const kp of [A, B]) {
  console.log('  join + delegate_entry', kp.publicKey.toBase58().slice(0, 6), explorerBase(await sendBase(kp, new Transaction().add(await joinIx(kp), await delegateEntryIx(kp, TEE_VALIDATOR)))))
}
console.log('  join (no delegation yet) C:', explorerBase(await sendBase(C, new Transaction().add(await joinIx(C)))))

// ---------------------------------------------------------------- base-layer tests: 5, 8, 10
console.log('\n== base layer: double join (5), wrong validator or delegation account (8), non-creator (10) ==')
await expectFail('5a', 'a wallet that already joined (and delegated) joins again', 'base', [], async () =>
  sendBase(B, new Transaction().add(await joinIx(B))), { note: 'entry PDA already exists, so init fails' })
await expectFail('5b', 'the creator joins a second time', 'base', [], async () => sendBase(A, new Transaction().add(await joinIx(A))))

await expectFail('8a', 'delegate_entry to a validator that is not the attested TEE (a public ER validator)', 'base', [6004], async () =>
  sendBase(C, new Transaction().add(await delegateEntryIx(C, new PublicKey(Object.values(ER_VALIDATOR)[0])))))
await expectFail('8b', 'delegate_entry with a random key as validator', 'base', [6004], async () =>
  sendBase(C, new Transaction().add(await delegateEntryIx(C, Keypair.generate().publicKey))))
await expectFail('8c', "delegate_entry naming another player's entry and card", 'base', [2006], async () =>
  sendBase(B, new Transaction().add(await baseProg(B).methods.delegateEntry()
    .accountsPartial({ player: B.publicKey, league, entry: E.C, card: CARD.C, validator: TEE_VALIDATOR }).instruction())))
await expectFail('8d', 'delegate_league to a validator that is not the TEE', 'base', [6004], async () =>
  sendBase(A, await baseProg(A).methods.delegateLeague()
    .accountsPartial({ creator: A.publicKey, league, secret, validator: new PublicKey(Object.values(ER_VALIDATOR)[0]) }).transaction()))
await expectFail('8e', "delegate_league with a secret account that is not this league's", 'base', [6021], async () =>
  sendBase(A, await baseProg(A).methods.delegateLeague()
    .accountsPartial({ creator: A.publicKey, league, secret: E.A, validator: TEE_VALIDATOR }).transaction()))
await expectFail('10a', 'delegate_league signed by a player who is not the creator', 'base', [6003], async () =>
  sendBase(B, await baseProg(B).methods.delegateLeague()
    .accountsPartial({ creator: B.publicKey, league, secret, validator: TEE_VALIDATOR }).transaction()))

console.log('  C delegates correctly now, and the creator closes joining:')
console.log('   delegate_entry C:', explorerBase(await sendBase(C, new Transaction().add(await delegateEntryIx(C, TEE_VALIDATOR)))))
console.log('   delegate_league :', explorerBase(await sendBase(A, await baseProg(A).methods.delegateLeague()
  .accountsPartial({ creator: A.publicKey, league, secret, validator: TEE_VALIDATOR }).transaction())))

// ---------------------------------------------------------------- Private ER
console.log('\n== Private ER ==')
const tees = {}
for (const [name, kp] of Object.entries({ A, B, C, D, H, X })) tees[name] = await teeConnection(kp)
const kps = { A, B, C, D, H, X }
const teeProg = (name) => programFor(idl, tees[name], kps[name])
const sendTee = (name, tx) => send(tees[name], tx, [kps[name]], { skipPreflight: true })
const readLeague = async () => decode(teeProg('A'), 'league', (await tees.A.getAccountInfo(league)).data)

console.log('  seal secret:', explorerTee(await retry('init_secret_permission', async () => sendTee('A', await teeProg('A').methods
  .initSecretPermission().accountsPartial({ payer: A.publicKey, league, secret, permission: permissionPda(secret) }).transaction()))))
for (const name of ['A', 'B', 'C']) {
  await retry('init_entry_permission', async () => sendTee(name, await teeProg(name).methods
    .initEntryPermission().accountsPartial({ payer: kps[name].publicKey, entry: E[name], permission: permissionPda(E[name]) }).transaction()))
}
console.log('  entries sealed')

await expectFail('10b', 'start_round signed by a player who is not the creator', 'tee', [6003], async () =>
  sendTee('B', await teeProg('B').methods.startRound().accountsPartial({ creator: B.publicKey, league }).transaction()))
console.log('  start_round (creator):', explorerTee(await sendTee('A', await teeProg('A').methods
  .startRound().accountsPartial({ creator: A.publicKey, league }).transaction())))

const nonceTx = (name) => teeProg(name).methods.commitNonce(Array.from(randomBytes(32)))
  .accountsPartial({ player: kps[name].publicKey, league, entry: E[name], permission: permissionPda(E[name]) }).transaction()
console.log('  nonce A:', explorerTee(await sendTee('A', await nonceTx('A'))))
await expectFail('2', 'the same player commits a second nonce in the same round', 'tee', [6016], async () => sendTee('A', await nonceTx('A')))
console.log('  nonce B:', explorerTee(await sendTee('B', await nonceTx('B'))))
console.log('  (C deliberately does not commit yet)')

// 3. callback_close called directly: not signed by the VRF program identity
const callbackIx = async (identity) => {
  const ix = await teeProg('A').methods.callbackClose(Array.from(randomBytes(32))).accountsPartial({ league, secret }).instruction()
  ix.keys[0] = { pubkey: identity, isSigner: true, isWritable: false } // the vrf_program_identity slot
  return ix
}
await expectFail('3a', 'callback_close called directly by an arbitrary key', 'tee', [2012], async () =>
  sendTee('X', new Transaction().add(await callbackIx(X.publicKey))))
await expectFail('3b', 'callback_close called directly by the league creator', 'tee', [2012], async () =>
  sendTee('A', new Transaction().add(await callbackIx(A.publicKey))))

// wait for the nonce window to end (C never commits), then lock in
let l = await readLeague()
const waitS = l.nonceDeadline.toNumber() - Math.floor(Date.now() / 1000) + 2
console.log(`  waiting ${Math.max(0, waitS)} s for the nonce window to end`)
if (waitS > 0) await sleep(waitS * 1000)
const sortedEntries = sortKeys([E.A, E.B, E.C])
const lockTx = async () => withCU(await teeProg('H').methods.lockIn().accountsPartial({ payer: H.publicKey, league, secret })
  .remainingAccounts(sortedEntries.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))).transaction())
console.log('  lock_in (helper):', explorerTee(await sendTee('H', await lockTx())))
l = await readLeague()
record('0', 'setup: the round is Live after lock-in', 'tee', 'status 2 (Live)', `status ${l.status}`, l.status === 2, null)
const lockedAt = Math.floor(Date.now() / 1000)

await expectFail('1', 'a player who had not committed sends commit_nonce after lock-in', 'tee', [6015], async () => sendTee('C', await nonceTx('C')))

const feed = l.feed
const posTx = (name, side, lev, { entry = E[name] ?? entryPda(league, kps[name].publicKey), priceFeed = feed } = {}) => teeProg(name).methods.setPosition(side, lev)
  .accountsPartial({ player: kps[name].publicKey, league, secret, entry, permission: permissionPda(entry), priceFeed }).transaction()
console.log('  position A long x2:', explorerTee(await sendTee('A', await posTx('A', 1, 2))))
console.log('  position B short x1:', explorerTee(await sendTee('B', await posTx('B', -1, 1))))

await expectFail('4b', 'set_position naming a different price feed (BTC)', 'tee', [6006], async () => sendTee('B', await posTx('B', 1, 1, { priceFeed: BTC_FEED })))
await expectFail('9a', "set_position signed by B using A's entry", 'tee', [2006], async () => sendTee('B', await posTx('B', 1, 1, { entry: E.A })))
await expectFail('9b', 'set_position by an outsider who never joined (own entry PDA does not exist)', 'tee', [3012], async () => sendTee('D', await posTx('D', 1, 1)))
await expectFail('9d', 'set_position with leverage above the maximum', 'tee', [6012], async () => sendTee('A', await posTx('A', 1, 9)))

// 9c: keep adjusting until the hidden close passes; the first rejection must be RoundClosed
console.log('  adjusting A until the hidden close passes (a few tens of seconds)...')
let closedRow = null
for (let i = 0; i < 70 && !closedRow; i++) {
  try {
    await sendTee('A', await posTx('A', 1, 2))
    await sleep(2000)
  } catch (e) {
    const p = parseError(e)
    closedRow = { code: p.code, name: p.name, sig: p.sig }
  }
}
if (!closedRow) throw new Error('the round never closed within the expected time')
record('9c', 'set_position after the hidden close', 'tee', label(6009), closedRow.name ?? 'rejected', closedRow.code === 6009, closedRow.sig,
  `first rejection came ${Math.floor(Date.now() / 1000) - lockedAt} s after lock-in`)

// ---------------------------------------------------------------- settlement tests (inside the window)
console.log('\n== settlement, inside the 60 s window ==')
const pairs = (order) => order.flatMap((k) => [
  { pubkey: E[k], isSigner: false, isWritable: true },
  { pubkey: CARD[k], isSigner: false, isWritable: true },
])
const settleTx = async (remaining, priceFeed = feed) =>
  withCU(await teeProg('H').methods.settleAndReveal().accountsPartial({ league, secret, priceFeed }).remainingAccounts(remaining).transaction())
const byKey = (a, b) => Buffer.compare(a.toBuffer(), b.toBuffer())
const ascending = ['A', 'B', 'C'].sort((x, y) => byKey(E[x], E[y]))
const opts = { retryOn: [6011], tries: 8 } // 6011 = the oracle price is a moment older than the close: not reached yet

await expectFail('4', 'settle_and_reveal with the wrong price feed account (BTC)', 'tee', [6006], async () => sendTee('H', await settleTx(pairs(ascending), BTC_FEED)), opts)
await expectFail('6a', 'settle with no entries at all', 'tee', [6013], async () => sendTee('H', await settleTx([])), opts)
await expectFail('6b', 'settle with one pair of three (wrong count)', 'tee', [6013], async () => sendTee('H', await settleTx(pairs(ascending.slice(0, 1)))), opts)
await expectFail('6c', 'settle with the pairs in descending order', 'tee', [6013], async () => sendTee('H', await settleTx(pairs([...ascending].reverse()))), opts)
await expectFail('6d', 'settle with one entry repeated and one missing', 'tee', [6013], async () =>
  sendTee('H', await settleTx(pairs([ascending[0], ascending[0], ascending[1]]))), opts)
await expectFail('6e', "settle with each entry paired with another player's card", 'tee', [6013], async () => {
  const swapped = ascending.flatMap((k, i) => [
    { pubkey: E[k], isSigner: false, isWritable: true },
    { pubkey: CARD[ascending[(i + 1) % 3]], isSigner: false, isWritable: true },
  ])
  return sendTee('H', await settleTx(swapped))
}, opts)
await expectFail('6f', 'settle with the entries read-only', 'tee', [6013], async () =>
  sendTee('H', await settleTx(pairs(ascending).map((m) => ({ ...m, isWritable: false })))), opts)
await expectFail('6g', 'settle with the league account in place of an entry', 'tee', [3002], async () => {
  const bad = pairs(ascending)
  bad[0] = { pubkey: league, isSigner: false, isWritable: true }
  return sendTee('H', await settleTx(bad))
}, opts)

// the valid settlement
let settledSig = null
for (let i = 0; i < 10 && !settledSig; i++) {
  try {
    settledSig = await sendTee('H', await settleTx(pairs(ascending)))
  } catch (e) {
    console.log('   valid settle attempt failed:', parseError(e).raw)
    await sleep(1500)
  }
}
l = await readLeague()
record('0b', 'setup: the valid settlement moves the final round to Finishing', 'tee', 'status 6 (Finishing)', `status ${l.status}`, l.status === 6, settledSig)

// ---------------------------------------------------------------- reveal tests (7 and 6, reveal side)
console.log('\n== final reveal: chunk size, order, repeats ==')
const sortedE = [...sortedEntries]
const revealTx = async (keys, writable = true) =>
  withCU(await teeProg('H').methods.revealEntries().accountsPartial({ league })
    .remainingAccounts(keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: writable }))).transaction())
await expectFail('7a', 'reveal_entries with no entries', 'tee', [6024], async () => sendTee('H', await revealTx([])))
await expectFail('7b', 'reveal_entries with five accounts (oversized chunk)', 'tee', [6024], async () =>
  sendTee('H', await revealTx([sortedE[0], sortedE[1], sortedE[2], sortedE[0], sortedE[1]])))
await expectFail('7c', 'reveal_entries with the entries in descending order', 'tee', [6013], async () =>
  sendTee('H', await revealTx([sortedE[2], sortedE[1]])))
await expectFail('7d', 'reveal_entries with the entry read-only', 'tee', [6013], async () => sendTee('H', await revealTx([sortedE[0]], false)))
await expectFail('7e', 'reveal_entries with a score card in place of an entry', 'tee', [3002], async () => sendTee('H', await revealTx([CARD.A])))
await expectFail('7f', 'finish_league before every entry is revealed', 'tee', [6025], async () =>
  sendTee('H', withCU(await teeProg('H').methods.finishLeague().accountsPartial({ league, secret })
    .remainingAccounts(['A', 'B', 'C'].map((k) => ({ pubkey: CARD[k], isSigner: false, isWritable: true }))).transaction())))

const first = await sendTee('H', await revealTx([sortedE[0]]))
await sleep(3000)
l = await readLeague()
record('7g', 'a valid reveal of one entry counts exactly one', 'tee', 'revealed_count 1', `revealed_count ${l.revealedCount}`, l.revealedCount === 1, first)
await expectFail('7h', 'the same chunk sent again (repeat)', 'tee', [6023], async () => sendTee('H', await revealTx([sortedE[0]])),
  { note: 'any rejection is acceptable here: the entry has already left the rollup, so the program may never be reached' })
await sleep(2000)
l = await readLeague()
record('7i', 'after the repeat, revealed_count is still 1 (no double count)', 'tee', 'revealed_count 1', `revealed_count ${l.revealedCount}`, l.revealedCount === 1, null)

const rest = await sendTee('H', await revealTx([sortedE[1], sortedE[2]]))
await sleep(3000)
l = await readLeague()
record('7j', 'the remaining two entries reveal, count reaches 3', 'tee', 'revealed_count 3', `revealed_count ${l.revealedCount}`, l.revealedCount === 3, rest)

const finishTx = async (keys) => withCU(await teeProg('H').methods.finishLeague().accountsPartial({ league, secret })
  .remainingAccounts(keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))).transaction())
await expectFail('6h', 'finish_league with only two of three score cards', 'tee', [6013], async () => sendTee('H', await finishTx([CARD.A, CARD.B])))
await expectFail('6i', 'finish_league with entries in place of score cards', 'tee', [3002], async () => sendTee('H', await finishTx(sortedE)))
const finishSig = await sendTee('H', await finishTx(ascending.map((k) => CARD[k])))
await sleep(6000)
const baseLeague = decode(baseProg(A), 'league', (await base.getAccountInfo(league)).data)
record('0c', 'setup: the valid finish_league ends the league', 'base', 'status 4 (Finished)', `status ${baseLeague.status}`, baseLeague.status === 4, finishSig)

// ---------------------------------------------------------------- summary
mkdirSync('.e2e', { recursive: true })
writeFileSync('.e2e/audit-negative.json', JSON.stringify({ league: league.toBase58(), results }, null, 2))
console.log('\n==== summary ====  league', league.toBase58())
for (const r of results) console.log(`${r.verdict.padEnd(26)} ${r.id.padEnd(3)} ${r.title}  ->  ${r.actual}`)
const different = results.filter((r) => r.verdict === 'REJECTED, DIFFERENT CODE')
console.log(`\n${results.length} checks. Holes (accepted when it should fail) or failed checks: ${holes.length}. Rejected with a different code than expected: ${different.length}.`)
process.exit(holes.length ? 2 : 0)
