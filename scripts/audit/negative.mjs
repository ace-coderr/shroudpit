// Negative audit tests, run against the deployed program on devnet with throwaway leagues.
// Every test sends a transaction the program must REJECT (or, where noted, must leave without any
// state change) and records the error code it returned and the transaction link. A test that is
// accepted when it should fail is a hole and is flagged loudly.
//
//   KEYPAIR_DIR=/dir/with/devnet/keypairs node scripts/audit/negative.mjs
//
// Three wallets (shroudpit-devnet.json = creator, shroudpit-p2.json, shroudpit-p3.json) plus
// throwaway keys for an outsider, a "helper" and an attacker. About 10 minutes end to end. Results
// are printed and written to .e2e/audit-negative.json (git-ignored).
//
// League 1: 3 players, 2 rounds, nonces + slot. League 2: only a source of entries and cards that
// belong to a DIFFERENT league. League 3: 2 players, VRF mode, for the callback and finalize checks.
//
// Ids: 1 commit after lock-in, 2 double commit, 3 callback_close direct, 4 wrong price feed, 5 double
// join, 6 wrong entry set, 7 reveal chunks, 8 wrong validator or delegation account, 9 set_position
// by a non-owner or after the close, 10 non-creator calls. Second batch (ids start with N):
// N1 look-alike price feed, N2 price/staleness checks that are reachable, N3 entries and cards of a
// different league, N4 nonce replay across rounds, N5 VRF callback and finalize, N6 calls after the
// league is Finished.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import BN from 'bn.js'
import {
  BASE_RPC, ER_VALIDATOR, ORACLE, TEE_VALIDATOR, cardPda, decode, entryPda, explorerBase, explorerTee,
  leaguePda, loadKeypair, permissionPda, programFor, send, sleep, teeConnection, withCU,
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
const show = (row) => console.log(`  [${row.verdict}] ${row.id} ${row.title}\n      expected ${row.expected}; actual ${row.actual}\n      ${row.tx ?? '(no transaction)'}`)

/**
 * Run a transaction that must be rejected. `expected` lists the acceptable error codes (empty =
 * any rejection is fine). `retryOn` codes mean "the check being tested was not reached yet" (for
 * example the oracle price is a moment older than the close), so the call is repeated.
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
  show(row)
  return row
}
/** A transaction that must either be rejected or change nothing. */
async function expectNoEffect(id, title, layer, run, snapshot, note = '') {
  const before = JSON.stringify(await snapshot())
  let outcome
  try {
    outcome = { accepted: true, sig: await run() }
  } catch (e) {
    outcome = { accepted: false, ...parseError(e) }
  }
  await sleep(3000)
  const unchanged = JSON.stringify(await snapshot()) === before
  const ok = !outcome.accepted || unchanged
  const row = {
    id, title, layer, note,
    expected: 'rejection, or no change of state',
    actual: outcome.accepted ? `accepted as a no-op; state unchanged: ${unchanged}` : (outcome.name ?? `rejected: ${outcome.raw}`),
    verdict: ok ? 'PASS' : 'HOLE',
    tx: link(layer, outcome.sig),
  }
  results.push(row)
  if (!ok) holes.push(row)
  show(row)
}
function record(id, title, layer, expected, actual, ok, sig, note = '') {
  const row = { id, title, layer, note, expected, actual, verdict: ok ? 'PASS' : 'FAIL', tx: link(layer, sig) }
  results.push(row)
  if (!ok) holes.push(row)
  show(row)
}
async function retry(what, fn, tries = 12) {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= tries) throw e
      console.log(`   (${what}: ${String(e.message).slice(0, 70)}; retrying)`)
      await sleep(3000)
    }
  }
}

// ---------------------------------------------------------------- wallets and connections
const A = loadKeypair(join(DIR, 'shroudpit-devnet.json')) // creator and player
const B = loadKeypair(join(DIR, 'shroudpit-p2.json'))
const C = loadKeypair(join(DIR, 'shroudpit-p3.json'))
const D = Keypair.generate() // outsider: never funded, never joined
const H = Keypair.generate() // helper: triggers lock-in and settlement, never funded
const X = Keypair.generate() // attacker for direct callback_close calls
const W = { A, B, C }
const kps = { A, B, C, D, H, X }
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
const byKey = (a, b) => Buffer.compare(a.toBuffer(), b.toBuffer())

console.log('balances (SOL):', ...(await Promise.all([A, B, C].map(async (k) => ((await retry('balance', () => base.getBalance(k.publicKey))) / 1e9).toFixed(3)))))
for (const k of [B, C]) {
  if ((await retry('balance', () => base.getBalance(k.publicKey))) < 0.35e9) {
    await sendBase(A, new Transaction().add(SystemProgram.transfer({ fromPubkey: A.publicKey, toPubkey: k.publicKey, lamports: 0.4e9 })))
    console.log('  topped up', k.publicKey.toBase58().slice(0, 6))
  }
}

// ---------------------------------------------------------------- league helpers
const joinIx = (L, n) => baseProg(W[n]).methods.joinLeague().accountsPartial({ player: W[n].publicKey, league: L.league, entry: L.E[n] }).instruction()
const delegateEntryIx = (L, n, validator) =>
  baseProg(W[n]).methods.delegateEntry().accountsPartial({ player: W[n].publicKey, league: L.league, entry: L.E[n], validator }).instruction()
const delegateLeagueTx = (L, signer = A, validator = TEE_VALIDATOR, secret = L.secret) =>
  baseProg(signer).methods.delegateLeague().accountsPartial({ creator: signer.publicKey, league: L.league, secret, validator }).transaction()

async function makeLeague(name, { rounds, closeMode, players, delay = [] }) {
  const id = Date.now() + Math.floor(Math.random() * 1000)
  const league = leaguePda(A.publicKey, id)
  const secret = PublicKey.findProgramAddressSync([Buffer.from('secret'), league.toBuffer()], PROGRAM)[0]
  const L = { name, league, secret, E: {}, CARD: {}, players }
  for (const n of players) {
    L.E[n] = entryPda(league, W[n].publicKey)
    L.CARD[n] = cardPda(league, W[n].publicKey)
  }
  console.log(`\n${name}: ${league.toBase58()} (${players.length} players, ${rounds} round(s), close 30 to 45 s, ${closeMode ? 'VRF mode' : 'nonces + slot'})`)
  console.log('  create_league:', explorerBase(await sendBase(A, await baseProg(A).methods
    .createLeague(new BN(id), rounds, 30, 45, 4, 6, closeMode).accountsPartial({ creator: A.publicKey, league, secret }).transaction())))
  for (const n of players) {
    const ixs = [await joinIx(L, n)]
    if (!delay.includes(n)) ixs.push(await delegateEntryIx(L, n, TEE_VALIDATOR))
    console.log(`  join${delay.includes(n) ? '' : ' + delegate_entry'} ${n}:`, explorerBase(await sendBase(W[n], new Transaction().add(...ixs))))
  }
  return L
}
const ascending = (L, names = L.players) => [...names].sort((x, y) => byKey(L.E[x], L.E[y]))

// ---------------------------------------------------------------- Private ER helpers
const tees = {}
const teeProg = (name) => programFor(idl, tees[name], kps[name])
const sendTee = (name, tx) => send(tees[name], tx, [kps[name]], { skipPreflight: true })
const readLeague = async (L) => decode(teeProg('A'), 'league', (await tees.A.getAccountInfo(L.league)).data)

async function sealAll(L, names) {
  await retry('init_secret_permission', async () => sendTee('A', await teeProg('A').methods
    .initSecretPermission().accountsPartial({ payer: A.publicKey, league: L.league, secret: L.secret, permission: permissionPda(L.secret) }).transaction()))
  for (const n of names) {
    await retry('init_entry_permission', async () => sendTee(n, await teeProg(n).methods
      .initEntryPermission().accountsPartial({ payer: W[n].publicKey, entry: L.E[n], permission: permissionPda(L.E[n]) }).transaction()))
  }
}
const startRoundTx = (name, L) => teeProg(name).methods.startRound().accountsPartial({ creator: kps[name].publicKey, league: L.league }).transaction()
const nonceTx = (L, n, bytes = randomBytes(32)) => teeProg(n).methods.commitNonce(Array.from(bytes))
  .accountsPartial({ player: W[n].publicKey, league: L.league, entry: L.E[n], permission: permissionPda(L.E[n]) }).transaction()
const lockTx = async (L) => withCU(await teeProg('H').methods.lockIn().accountsPartial({ payer: H.publicKey, league: L.league, secret: L.secret })
  .remainingAccounts(ascending(L).map((n) => ({ pubkey: L.E[n], isSigner: false, isWritable: false }))).transaction())
const posTx = (L, feed, name, side, lev, { entry = L.E[name] ?? entryPda(L.league, kps[name].publicKey), priceFeed = feed } = {}) =>
  teeProg(name).methods.setPosition(side, lev)
    .accountsPartial({ player: kps[name].publicKey, league: L.league, secret: L.secret, entry, permission: permissionPda(entry), priceFeed }).transaction()
const pairsOf = (L, order, writable = true) => order.flatMap((n) => [
  { pubkey: L.E[n], isSigner: false, isWritable: writable },
  { pubkey: L.CARD[n], isSigner: false, isWritable: writable },
])
const settleTx = async (prog, L, feed, remaining, priceFeed = feed) =>
  withCU(await prog.methods.settleAndReveal().accountsPartial({ league: L.league, secret: L.secret, priceFeed }).remainingAccounts(remaining).transaction())
const revealTx = async (prog, L, keys, writable = true) =>
  withCU(await prog.methods.revealEntries().accountsPartial({ league: L.league })
    .remainingAccounts(keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: writable }))).transaction())
const finishTx = async (prog, L, keys) =>
  withCU(await prog.methods.finishLeague().accountsPartial({ league: L.league, secret: L.secret })
    .remainingAccounts(keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))).transaction())

/** Adjust A's position every couple of seconds until the hidden close passes; returns the first rejection. */
async function waitForClose(L, feed) {
  const t0 = Date.now()
  for (;;) {
    try {
      await sendTee('A', await posTx(L, feed, 'A', 1, 2))
      await sleep(Date.now() - t0 < 25_000 ? 2500 : 350)
    } catch (e) {
      return parseError(e)
    }
    if (Date.now() - t0 > 130_000) throw new Error('the round never closed within the expected time')
  }
}
const settleUntilDone = async (L, feed, want) => {
  let sig = null
  for (let i = 0; i < 10 && !sig; i++) {
    try {
      sig = await sendTee('H', await settleTx(teeProg('H'), L, feed, pairsOf(L, ascending(L))))
    } catch (e) {
      console.log('   valid settle attempt failed:', parseError(e).raw)
      await sleep(1500)
    }
  }
  const l = await readLeague(L)
  return { sig, status: l.status, ok: l.status === want }
}

// ================================================================ LEAGUE 1 and 2: setup (base layer)
const L1 = await makeLeague('league 1', { rounds: 2, closeMode: 0, players: ['A', 'B', 'C'], delay: ['C'] })
const L2 = await makeLeague('league 2 (a source of foreign entries and cards)', { rounds: 1, closeMode: 0, players: ['A', 'B', 'C'] })

console.log('\n== base layer: double join (5), wrong validator or delegation account (8), non-creator (10) ==')
await expectFail('5a', 'a wallet that already joined (and delegated) joins again', 'base', [], async () =>
  sendBase(B, new Transaction().add(await joinIx(L1, 'B'))), { note: 'entry PDA already exists, so init fails' })
await expectFail('5b', 'the creator joins a second time', 'base', [], async () => sendBase(A, new Transaction().add(await joinIx(L1, 'A'))))
const otherValidator = new PublicKey(Object.values(ER_VALIDATOR)[0])
await expectFail('8a', 'delegate_entry to a validator that is not the attested TEE (a public ER validator)', 'base', [6004], async () =>
  sendBase(C, new Transaction().add(await delegateEntryIx(L1, 'C', otherValidator))))
await expectFail('8b', 'delegate_entry with a random key as validator', 'base', [6004], async () =>
  sendBase(C, new Transaction().add(await delegateEntryIx(L1, 'C', Keypair.generate().publicKey))))
await expectFail('8c', "delegate_entry naming another player's entry and card", 'base', [2006], async () =>
  sendBase(B, new Transaction().add(await baseProg(B).methods.delegateEntry()
    .accountsPartial({ player: B.publicKey, league: L1.league, entry: L1.E.C, card: L1.CARD.C, validator: TEE_VALIDATOR }).instruction())))
await expectFail('8d', 'delegate_league to a validator that is not the TEE', 'base', [6004], async () =>
  sendBase(A, await delegateLeagueTx(L1, A, otherValidator)))
await expectFail('8e', "delegate_league with a secret account that is not this league's", 'base', [6021], async () =>
  sendBase(A, await delegateLeagueTx(L1, A, TEE_VALIDATOR, L1.E.A)))
await expectFail('10a', 'delegate_league signed by a player who is not the creator', 'base', [6003], async () =>
  sendBase(B, await delegateLeagueTx(L1, B)))
console.log('  C delegates correctly now, and the creator closes joining:')
console.log('   delegate_entry C:', explorerBase(await sendBase(C, new Transaction().add(await delegateEntryIx(L1, 'C', TEE_VALIDATOR)))))
console.log('   delegate_league :', explorerBase(await sendBase(A, await delegateLeagueTx(L1))))

// ================================================================ LEAGUE 1: Private ER, round 1
console.log('\n== Private ER, league 1, round 1 ==')
for (const [name, kp] of Object.entries(kps)) tees[name] = await retry(`Private ER login ${name}`, () => teeConnection(kp), 8)
await sealAll(L1, ['A', 'B', 'C'])
console.log('  secret and entries sealed')

await expectFail('10b', 'start_round signed by a player who is not the creator', 'tee', [6003], async () => sendTee('B', await startRoundTx('B', L1)))
console.log('  start_round (creator):', explorerTee(await sendTee('A', await startRoundTx('A', L1))))

const nonceA1 = randomBytes(32)
console.log('  nonce A:', explorerTee(await sendTee('A', await nonceTx(L1, 'A', nonceA1))))
await expectFail('2', 'the same player commits a second nonce in the same round', 'tee', [6016], async () => sendTee('A', await nonceTx(L1, 'A')))
console.log('  nonce B:', explorerTee(await sendTee('B', await nonceTx(L1, 'B'))))
console.log('  (C deliberately does not commit yet)')

const callbackIx = async (L, identity) => {
  const ix = await teeProg('A').methods.callbackClose(Array.from(randomBytes(32))).accountsPartial({ league: L.league, secret: L.secret }).instruction()
  ix.keys[0] = { pubkey: identity, isSigner: true, isWritable: false } // the vrf_program_identity slot
  return ix
}
await expectFail('3a', 'callback_close called directly by an arbitrary key', 'tee', [2012], async () =>
  sendTee('X', new Transaction().add(await callbackIx(L1, X.publicKey))))
await expectFail('3b', 'callback_close called directly by the league creator', 'tee', [2012], async () =>
  sendTee('A', new Transaction().add(await callbackIx(L1, A.publicKey))))

let l = await readLeague(L1)
const waitS = l.nonceDeadline.toNumber() - Math.floor(Date.now() / 1000) + 2
console.log(`  waiting ${Math.max(0, waitS)} s for the nonce window to end`)
if (waitS > 0) await sleep(waitS * 1000)
console.log('  lock_in (helper):', explorerTee(await sendTee('H', await lockTx(L1))))
l = await readLeague(L1)
record('0', 'setup: round 1 is Live after lock-in', 'tee', 'status 2 (Live)', `status ${l.status}`, l.status === 2, null)
const lockedAt = Math.floor(Date.now() / 1000)
await expectFail('1', 'a player who had not committed sends commit_nonce after lock-in', 'tee', [6015], async () => sendTee('C', await nonceTx(L1, 'C')))

const FEED = l.feed
console.log('  position A long x2:', explorerTee(await sendTee('A', await posTx(L1, FEED, 'A', 1, 2))))
console.log('  position B short x1:', explorerTee(await sendTee('B', await posTx(L1, FEED, 'B', -1, 1))))
await expectFail('4b', 'set_position naming a different price feed (BTC)', 'tee', [6006], async () => sendTee('B', await posTx(L1, FEED, 'B', 1, 1, { priceFeed: BTC_FEED })))
await expectFail('N1c', 'set_position with a look-alike feed: a program-owned account (an entry)', 'tee', [6006], async () =>
  sendTee('B', await posTx(L1, FEED, 'B', 1, 1, { priceFeed: L1.E.A })))
await expectFail('N1d', 'set_position with a look-alike feed: a system-owned account (a wallet)', 'tee', [6006], async () =>
  sendTee('B', await posTx(L1, FEED, 'B', 1, 1, { priceFeed: C.publicKey })))
await expectFail('9a', "set_position signed by B using A's entry", 'tee', [2006], async () => sendTee('B', await posTx(L1, FEED, 'B', 1, 1, { entry: L1.E.A })))
await expectFail('9b', 'set_position by an outsider who never joined (own entry PDA does not exist)', 'tee', [3012], async () => sendTee('D', await posTx(L1, FEED, 'D', 1, 1)))
await expectFail('9d', 'set_position with leverage above the maximum', 'tee', [6012], async () => sendTee('A', await posTx(L1, FEED, 'A', 1, 9)))

console.log('  adjusting A until the hidden close passes...')
const closed = await waitForClose(L1, FEED)
record('9c', 'set_position after the hidden close', 'tee', label(6009), closed.name ?? 'rejected', closed.code === 6009, closed.sig,
  `first rejection came ${Math.floor(Date.now() / 1000) - lockedAt} s after lock-in`)

// ---------------------------------------------------------------- settlement tests (inside the 60 s window)
console.log('\n== settlement, inside the 60 s window ==')
const hp = teeProg('H')
const asc1 = ascending(L1)
const opts = { retryOn: [6011], tries: 8 } // 6011 = the oracle price is a moment older than the close: the check under test is not reached yet

// N2c: what the price checks do at the instant of the close. settle with no entries reads the price first, so
// the outcome sequence shows whether "price older than the close" (OutsideSettleWindow) was observed before BadEntries.
{
  const seen = []
  let sig = null
  for (let i = 0; i < 10; i++) {
    try {
      sig = await sendTee('H', await settleTx(hp, L1, FEED, []))
      seen.push('ACCEPTED')
      break
    } catch (e) {
      const p = parseError(e)
      seen.push(p.code ?? 'other')
      sig = p.sig
      if (p.code !== 6011) break
      await sleep(250)
    }
  }
  const ok = seen.every((c) => c === 6011 || c === 6013) && seen.at(-1) === 6013
  record('N2c', 'settle right after the close: the price-versus-close check', 'tee',
    'OutsideSettleWindow (6011) while the price is older than the close, then BadEntries (6013)',
    `outcomes in order: ${seen.join(', ')}${seen.includes(6011) ? ' (the stale-versus-close check was observed)' : ' (the price was already newer than the close, so only BadEntries was reached)'}`,
    ok, sig)
}

await expectFail('4', 'settle_and_reveal with the wrong price feed account (BTC)', 'tee', [6006], async () => sendTee('H', await settleTx(hp, L1, FEED, pairsOf(L1, asc1), BTC_FEED)), opts)
await expectFail('N1a', 'settle_and_reveal with a look-alike feed: a program-owned account (an entry)', 'tee', [6006], async () =>
  sendTee('H', await settleTx(hp, L1, FEED, pairsOf(L1, asc1), L1.E.B)), opts)
await expectFail('N1b', 'settle_and_reveal with a look-alike feed: a system-owned account (a wallet)', 'tee', [6006], async () =>
  sendTee('H', await settleTx(hp, L1, FEED, pairsOf(L1, asc1), C.publicKey)), opts)
await expectFail('N3a', "settle_and_reveal with another league's entries and cards (same count, ascending order)", 'tee', [6013], async () =>
  sendTee('H', await settleTx(hp, L1, FEED, pairsOf(L2, ascending(L2)))), opts)
await expectFail('N3b', "settle_and_reveal with this league's entries but another league's cards", 'tee', [6013], async () =>
  sendTee('H', await settleTx(hp, L1, FEED, asc1.flatMap((n) => [
    { pubkey: L1.E[n], isSigner: false, isWritable: true },
    { pubkey: L2.CARD[n], isSigner: false, isWritable: true },
  ]))), opts)
await expectFail('6b', 'settle with one pair of three (wrong count)', 'tee', [6013], async () => sendTee('H', await settleTx(hp, L1, FEED, pairsOf(L1, asc1.slice(0, 1)))), opts)
await expectFail('6c', 'settle with the pairs in descending order', 'tee', [6013], async () => sendTee('H', await settleTx(hp, L1, FEED, pairsOf(L1, [...asc1].reverse()))), opts)
await expectFail('6d', 'settle with one entry repeated and one missing', 'tee', [6013], async () =>
  sendTee('H', await settleTx(hp, L1, FEED, pairsOf(L1, [asc1[0], asc1[0], asc1[1]]))), opts)
await expectFail('6e', "settle with each entry paired with another player's card", 'tee', [6013], async () =>
  sendTee('H', await settleTx(hp, L1, FEED, asc1.flatMap((n, i) => [
    { pubkey: L1.E[n], isSigner: false, isWritable: true },
    { pubkey: L1.CARD[asc1[(i + 1) % 3]], isSigner: false, isWritable: true },
  ]))), opts)
await expectFail('6f', 'settle with the entries read-only', 'tee', [6013], async () => sendTee('H', await settleTx(hp, L1, FEED, pairsOf(L1, asc1, false))), opts)
await expectFail('6g', 'settle with the league account in place of an entry', 'tee', [3002], async () => {
  const bad = pairsOf(L1, asc1)
  bad[0] = { pubkey: L1.league, isSigner: false, isWritable: true }
  return sendTee('H', await settleTx(hp, L1, FEED, bad))
}, opts)
record('6a', 'settle with no entries at all (see N2c: rejected with BadEntries once the price check passes)', 'tee', 'BadEntries (6013)', 'BadEntries (6013) in the N2c sequence', results.find((r) => r.id === 'N2c')?.verdict === 'PASS', results.find((r) => r.id === 'N2c')?.tx?.split('/tx/')[1]?.split('?')[0] ?? null)

const settled1 = await settleUntilDone(L1, FEED, 3)
record('0b', 'setup: the valid settlement of round 1 moves the league to Between (not final)', 'tee', 'status 3 (Between)', `status ${settled1.status}`, settled1.ok, settled1.sig)

// ================================================================ LEAGUE 1: round 2 (nonce replay, then the final reveal)
console.log('\n== league 1, round 2: nonce replay across rounds (N4) ==')
console.log('  start_round (creator):', explorerTee(await sendTee('A', await startRoundTx('A', L1))))
await expectFail('N4', "commit_nonce replaying the exact nonce this player used in the previous round (previous epoch)", 'tee', [],
  async () => sendTee('A', await nonceTx(L1, 'A', nonceA1)),
  { note: 'the program checks one commit per epoch and a non-zero value; it does not compare against earlier epochs' })
for (const n of ['B', 'C']) console.log(`  nonce ${n}:`, explorerTee(await sendTee(n, await nonceTx(L1, n))))
console.log('  lock_in (helper, all three nonces in):', explorerTee(await sendTee('H', await lockTx(L1))))
l = await readLeague(L1)
record('0d', 'setup: round 2 is Live after lock-in', 'tee', 'status 2 (Live)', `status ${l.status}`, l.status === 2, null)
console.log('  position A long x2:', explorerTee(await sendTee('A', await posTx(L1, FEED, 'A', 1, 2))))
console.log('  position B short x1:', explorerTee(await sendTee('B', await posTx(L1, FEED, 'B', -1, 1))))
console.log('  adjusting A until the hidden close passes...')
await waitForClose(L1, FEED)
const settled2 = await settleUntilDone(L1, FEED, 6)
record('0e', 'setup: the valid settlement of the final round moves the league to Finishing', 'tee', 'status 6 (Finishing)', `status ${settled2.status}`, settled2.ok, settled2.sig)

// ---------------------------------------------------------------- final reveal tests
console.log('\n== final reveal: chunk size, order, repeats, foreign league ==')
const sortedE = ascending(L1).map((n) => L1.E[n])
await expectFail('7a', 'reveal_entries with no entries', 'tee', [6024], async () => sendTee('H', await revealTx(hp, L1, [])))
await expectFail('7b', 'reveal_entries with five accounts (oversized chunk)', 'tee', [6024], async () =>
  sendTee('H', await revealTx(hp, L1, [sortedE[0], sortedE[1], sortedE[2], sortedE[0], sortedE[1]])))
await expectFail('7c', 'reveal_entries with the entries in descending order', 'tee', [6013], async () => sendTee('H', await revealTx(hp, L1, [sortedE[2], sortedE[1]])))
await expectFail('7d', 'reveal_entries with the entry read-only', 'tee', [6013], async () => sendTee('H', await revealTx(hp, L1, [sortedE[0]], false)))
await expectFail('7e', 'reveal_entries with a score card in place of an entry', 'tee', [3002], async () => sendTee('H', await revealTx(hp, L1, [L1.CARD.A])))
await expectFail('N3c', "reveal_entries with another league's entry", 'tee', [6013], async () => sendTee('H', await revealTx(hp, L1, [L2.E[ascending(L2)[0]]])))
await expectFail('7f', 'finish_league before every entry is revealed', 'tee', [6025], async () =>
  sendTee('H', await finishTx(hp, L1, ascending(L1).map((n) => L1.CARD[n]))))

const first = await sendTee('H', await revealTx(hp, L1, [sortedE[0]]))
await sleep(3000)
l = await readLeague(L1)
record('7g', 'a valid reveal of one entry counts exactly one', 'tee', 'revealed_count 1', `revealed_count ${l.revealedCount}`, l.revealedCount === 1, first)
await expectFail('7h', 'the same chunk sent again (repeat)', 'tee', [6023], async () => sendTee('H', await revealTx(hp, L1, [sortedE[0]])),
  { note: 'any rejection is acceptable here: the entry has already left the rollup, so the program may never be reached' })
await sleep(2000)
l = await readLeague(L1)
record('7i', 'after the repeat, revealed_count is still 1 (no double count)', 'tee', 'revealed_count 1', `revealed_count ${l.revealedCount}`, l.revealedCount === 1, null)
const rest = await sendTee('H', await revealTx(hp, L1, [sortedE[1], sortedE[2]]))
await sleep(3000)
l = await readLeague(L1)
record('7j', 'the remaining two entries reveal, count reaches 3', 'tee', 'revealed_count 3', `revealed_count ${l.revealedCount}`, l.revealedCount === 3, rest)

await expectFail('N3d', "finish_league with another league's score cards (every entry revealed)", 'tee', [6013], async () =>
  sendTee('H', await finishTx(hp, L1, ascending(L2).map((n) => L2.CARD[n]))))
await expectFail('6h', 'finish_league with only two of three score cards', 'tee', [6013], async () => sendTee('H', await finishTx(hp, L1, [L1.CARD.A, L1.CARD.B])))
await expectFail('6i', 'finish_league with entries in place of score cards', 'tee', [3002], async () => sendTee('H', await finishTx(hp, L1, sortedE)))
const finishSig = await sendTee('H', await finishTx(hp, L1, ascending(L1).map((n) => L1.CARD[n])))
let baseL = null
for (let i = 0; i < 20; i++) {
  await sleep(3000)
  const ai = await base.getAccountInfo(L1.league)
  if (ai && ai.owner.equals(PROGRAM)) {
    baseL = decode(baseProg(A), 'league', ai.data)
    if (baseL.status === 4) break
  }
}
record('0c', 'setup: the valid finish_league ends the league', 'base', 'status 4 (Finished)', `status ${baseL?.status}`, baseL?.status === 4, finishSig)

// ---------------------------------------------------------------- N6: after the league is Finished
console.log('\n== calls after the league is Finished (N6) ==')
const snap = async () => {
  const ai = await base.getAccountInfo(L1.league)
  const x = decode(baseProg(A), 'league', ai.data)
  return { owner: ai.owner.toBase58(), status: x.status, round: x.round, revealed: x.revealedCount, winner: x.winner.toBase58(), settlePrice: x.settlePrice.toString() }
}
const bp = baseProg(A)
const baseSettle = async () => sendBase(A, await settleTx(bp, L1, FEED, pairsOf(L1, ascending(L1))))
const baseReveal = async () => sendBase(A, await revealTx(bp, L1, [sortedE[0]]))
const baseFinish = async () => sendBase(A, await finishTx(bp, L1, ascending(L1).map((n) => L1.CARD[n])))
await expectNoEffect('N6a', 'settle_and_reveal on devnet after the league is Finished', 'base', baseSettle, snap, 'status is not Live, so the handler returns Ok without doing anything')
await expectNoEffect('N6b', 'reveal_entries on devnet after the league is Finished', 'base', baseReveal, snap)
await expectNoEffect('N6c', 'finish_league on devnet after the league is Finished', 'base', baseFinish, snap)
await expectNoEffect('N6d', 'settle_and_reveal sent to the Private ER after the league is Finished', 'tee', async () =>
  sendTee('H', await settleTx(hp, L1, FEED, pairsOf(L1, ascending(L1)))), snap, 'the accounts have left the rollup')
await expectNoEffect('N6e', 'reveal_entries sent to the Private ER after the league is Finished', 'tee', async () => sendTee('H', await revealTx(hp, L1, [sortedE[0]])), snap)
await expectNoEffect('N6f', 'finish_league sent to the Private ER after the league is Finished', 'tee', async () =>
  sendTee('H', await finishTx(hp, L1, ascending(L1).map((n) => L1.CARD[n]))), snap)

// ================================================================ LEAGUE 3: VRF mode (N5)
console.log('\n== league 3 (VRF mode): callback_close and finalize_without_vrf (N5) ==')
const L3 = await makeLeague('league 3', { rounds: 1, closeMode: 1, players: ['A', 'B'] })
console.log('  delegate_league:', explorerBase(await sendBase(A, await delegateLeagueTx(L3))))
await sealAll(L3, ['A', 'B'])
await retry('start_round', async () => sendTee('A', await startRoundTx('A', L3)), 6)
for (const n of ['A', 'B']) await sendTee(n, await nonceTx(L3, n))
console.log('  lock_in (helper; asks the VRF oracle for randomness):', explorerTee(await sendTee('H', await lockTx(L3))))
await expectFail('N5a', 'finalize_without_vrf right after lock-in, before the VRF wait is over', 'tee', [6020, 6001], async () =>
  sendTee('H', await teeProg('H').methods.finalizeWithoutVrf().accountsPartial({ payer: H.publicKey, league: L3.league, secret: L3.secret }).transaction()),
  { note: 'VrfWaitNotExpired if still AwaitingVrf; WrongStatus if the genuine callback has already landed' })
let l3 = await readLeague(L3)
for (let i = 0; i < 30 && l3.status === 1; i++) {
  await sleep(2000)
  l3 = await readLeague(L3)
  if (l3.status === 1 && Math.floor(Date.now() / 1000) >= l3.vrfDeadline.toNumber()) {
    try {
      await sendTee('H', await teeProg('H').methods.finalizeWithoutVrf().accountsPartial({ payer: H.publicKey, league: L3.league, secret: L3.secret }).transaction())
    } catch { /* the callback may have landed meanwhile */ }
  }
}
record('N5-setup', 'setup: the VRF round reaches Live (genuine callback, or the 20 s fallback)', 'tee', 'status 2 (Live)', `status ${l3.status}`, l3.status === 2, null)
await expectFail('N5b', 'finalize_without_vrf after the close time was already derived', 'tee', [6001], async () =>
  sendTee('H', await teeProg('H').methods.finalizeWithoutVrf().accountsPartial({ payer: H.publicKey, league: L3.league, secret: L3.secret }).transaction()))
await expectFail('N5c', 'callback_close called directly after the round is Live (second callback attempt)', 'tee', [2012], async () =>
  sendTee('X', new Transaction().add(await callbackIx(L3, X.publicKey))))
await expectFail('N5d', 'callback_close called directly a second time by another key', 'tee', [2012], async () =>
  sendTee('A', new Transaction().add(await callbackIx(L3, A.publicKey))))

// ================================================================ summary
mkdirSync('.e2e', { recursive: true })
writeFileSync('.e2e/audit-negative.json', JSON.stringify({ league: L1.league.toBase58(), league2: L2.league.toBase58(), league3: L3.league.toBase58(), results }, null, 2))
console.log('\n==== summary ====  leagues', L1.league.toBase58(), L2.league.toBase58(), L3.league.toBase58())
for (const r of results) console.log(`${r.verdict.padEnd(26)} ${r.id.padEnd(8)} ${r.title}  ->  ${r.actual}`)
const different = results.filter((r) => r.verdict === 'REJECTED, DIFFERENT CODE')
console.log(`\n${results.length} checks. Holes (accepted when it should fail) or failed checks: ${holes.length}. Rejected with a different code than expected: ${different.length}.`)
for (const h of holes) console.log(`  HOLE/FAIL: ${h.id} ${h.title} -> ${h.actual} ${h.tx ?? ''}`)
process.exit(holes.length ? 2 : 0)
