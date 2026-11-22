// Full round on devnet with several wallets: create, join, delegate to the TEE, permissions,
// nonce commits, lock-in (optionally with VRF), positions, the "rejected after close" check,
// settlement, and an independent recomputation of the close-time derivation.
//
//   WALLETS=3 CLOSE_MODE=0|1 ROUNDS=1 KEYPAIR_DIR=/dir node scripts/e2e/10-round.mjs
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import BN from 'bn.js'
import {
  BASE_RPC, PROGRAM_ID, SOL_USD_FEED, TEE_VALIDATOR, cardPda, decode, entryPda, explorerBase, withCU,
  explorerTee, leaguePda, loadKeypair, loadState, permissionPda, programFor, saveState, send, sleep, sortKeys,
  teeConnection,
} from './lib.mjs'

const N = Number(process.env.WALLETS ?? 3)
const CLOSE_MODE = Number(process.env.CLOSE_MODE ?? 0)
const ROUNDS = Number(process.env.ROUNDS ?? 1)
const DIR = process.env.KEYPAIR_DIR
const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))

// ---- wallets (keypairs stay outside the repo) ----
const files = ['shroudpit-devnet.json', ...[2, 3, 4, 5, 6, 7, 8].map((i) => `shroudpit-p${i}.json`)]
for (const f of files.slice(0, N)) {
  const p = join(DIR, f)
  if (!existsSync(p)) writeFileSync(p, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 })
}
const wallets = files.slice(0, N).map((f) => loadKeypair(join(DIR, f)))
const creator = wallets[0]
// HELPER=1: lock-in, finalisation and settlement are sent by a brand-new key that holds no SOL
// anywhere, to prove that triggering them needs no funds and no privileges.
const HELPER = process.env.HELPER === '1'
const helper = Keypair.generate()
const base = new Connection(BASE_RPC, 'confirmed')
const baseProg = programFor(idl, base, creator)

const state = loadState()
state.round = { links: [] }
const out = state.round
const link = (label, sig, tee) => {
  out.links.push({ label, sig, tee: !!tee })
  console.log(`  ${label}: ${tee ? explorerTee(sig) : explorerBase(sig)}`)
}
const short = (k) => k.toBase58().slice(0, 6)

// fund wallets that cannot pay entry rent
for (const w of wallets.slice(1)) {
  const bal = await base.getBalance(w.publicKey)
  if (bal < 0.03 * LAMPORTS_PER_SOL) {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: w.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL }))
    link(`fund ${short(w.publicKey)} 0.03 SOL`, await send(base, tx, [creator]))
  }
}

// ---- base layer: league + players ----
const leagueId = Date.now()
const league = leaguePda(creator.publicKey, leagueId)
const secret = PublicKey.findProgramAddressSync([Buffer.from('secret'), league.toBuffer()], PROGRAM_ID)[0]
const entries = Object.fromEntries(wallets.map((w) => [w.publicKey.toBase58(), entryPda(league, w.publicKey)]))
const cards = Object.fromEntries(wallets.map((w) => [w.publicKey.toBase58(), cardPda(league, w.publicKey)]))
console.log(`\nleague ${league.toBase58()} secret ${secret.toBase58()} | wallets ${wallets.map((w) => short(w.publicKey)).join(', ')} | close_mode ${CLOSE_MODE} | rounds ${ROUNDS}`)
Object.assign(out, { league: league.toBase58(), secret: secret.toBase58(), leagueId, wallets: wallets.map((w) => w.publicKey.toBase58()) })

link('create_league', await send(base, await baseProg.methods
  .createLeague(new BN(leagueId), ROUNDS, 30, 45, Math.max(N, 2), 6, CLOSE_MODE)
  .accountsPartial({ creator: creator.publicKey, league, secret }).transaction(), [creator]))

for (const w of wallets) {
  const entry = entries[w.publicKey.toBase58()]
  const join = await baseProg.methods.joinLeague().accountsPartial({ player: w.publicKey, league, entry }).instruction()
  const del = await baseProg.methods.delegateEntry().accountsPartial({ player: w.publicKey, league, entry, validator: TEE_VALIDATOR }).instruction()
  link(`join+delegate_entry ${short(w.publicKey)}`, await send(base, new Transaction().add(join, del), [w]))
}
link('delegate_league (+secret)', await send(base, await baseProg.methods
  .delegateLeague().accountsPartial({ creator: creator.publicKey, league, secret, validator: TEE_VALIDATOR }).transaction(), [creator]))

// ---- Private ER ----
const tee = {}
for (const w of wallets) tee[w.publicKey.toBase58()] = await teeConnection(w)
if (HELPER) {
  tee[helper.publicKey.toBase58()] = await teeConnection(helper)
  out.helper = { key: helper.publicKey.toBase58(), baseBalanceLamports: await base.getBalance(helper.publicKey) }
  console.log(`helper ${helper.publicKey.toBase58()} base balance ${out.helper.baseBalanceLamports} lamports (never funded)`)
}
const actor = HELPER ? helper : creator
const teeOf = (w) => tee[w.publicKey.toBase58()]
const progOf = (w) => programFor(idl, teeOf(w), w)
const teeC = teeOf(creator)

process.stdout.write('waiting for league and secret in the TEE')
for (let i = 0; i < 60; i++) {
  if ((await teeC.getAccountInfo(league)) && (await teeC.getAccountInfo(secret))) break
  process.stdout.write('.')
  await sleep(1500)
}
console.log()

const sendTee = (w, tx) => send(teeOf(w), tx, [w], { skipPreflight: true })
link('init_secret_permission', await sendTee(creator, await progOf(creator).methods
  .initSecretPermission().accountsPartial({ payer: creator.publicKey, league, secret, permission: permissionPda(secret) }).transaction()), true)
for (const w of wallets) {
  const entry = entries[w.publicKey.toBase58()]
  link(`init_entry_permission ${short(w.publicKey)}`, await sendTee(w, await progOf(w).methods
    .initEntryPermission().accountsPartial({ payer: w.publicKey, entry, permission: permissionPda(entry) }).transaction()), true)
}

// ---- privacy: who can read what? ----
async function canRead(conn, key) {
  try { return !!(await conn.getAccountInfo(key)) } catch (e) { return `error: ${String(e.message).slice(0, 50)}` }
}
const other = wallets[1]
console.log('\nprivacy reads (true = readable):')
console.log('  secret read by creator      :', await canRead(teeC, secret))
console.log('  secret read by other player :', await canRead(teeOf(other), secret))
console.log('  league read by other player :', await canRead(teeOf(other), league))
console.log('  creator entry read by owner :', await canRead(teeC, entries[creator.publicKey.toBase58()]))
console.log('  creator entry read by other :', await canRead(teeOf(other), entries[creator.publicKey.toBase58()]))
out.privacy = {
  secretByCreator: await canRead(teeC, secret),
  secretByPlayer: await canRead(teeOf(other), secret),
  entryByOwner: await canRead(teeC, entries[creator.publicKey.toBase58()]),
  entryByOther: await canRead(teeOf(other), entries[creator.publicKey.toBase58()]),
}

const readLeague = async () => decode(progOf(creator), 'league', (await teeC.getAccountInfo(league)).data)
const sortedEntries = sortKeys(Object.values(entries))
const remaining = sortedEntries.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))
// settlement takes [entry, card] pairs in ascending entry-key order
const playerOfEntry = (key) => wallets.find((w) => entries[w.publicKey.toBase58()].equals(key))
const remainingPairs = sortedEntries.flatMap((pubkey) => [
  { pubkey, isSigner: false, isWritable: true },
  { pubkey: cards[playerOfEntry(pubkey).publicKey.toBase58()], isSigner: false, isWritable: true },
])

for (let round = 0; round < ROUNDS; round++) {
  console.log(`\n===== round ${round} =====`)
  // open the nonce phase
  link(`start_round (r${round})`, await sendTee(creator, await progOf(creator).methods
    .startRound().accountsPartial({ creator: creator.publicKey, league }).transaction()), true)
  let l = await readLeague()
  console.log(`  status=${l.status} (5 = Nonces) epoch=${l.epoch} nonce_deadline in ${l.nonceDeadline.toNumber() - Math.floor(Date.now() / 1000)}s`)

  // every player commits a private nonce
  const nonces = {}
  for (const w of wallets) {
    const nonce = randomBytes(32)
    nonces[w.publicKey.toBase58()] = nonce
    link(`commit_nonce ${short(w.publicKey)}`, await sendTee(w, await progOf(w).methods
      .commitNonce(Array.from(nonce)).accountsPartial({ player: w.publicKey, league, entry: entries[w.publicKey.toBase58()], permission: permissionPda(entries[w.publicKey.toBase58()]) }).transaction()), true)
  }
  l = await readLeague()
  console.log(`  nonce_count=${l.nonceCount}/${l.playerCount}`)

  // lock in (anyone may; the creator pays here)
  const lockIx = (who) => progOf(who).methods
    .lockIn().accountsPartial({ payer: who.publicKey, league, secret })
    .remainingAccounts(remaining.map((r) => ({ ...r, isWritable: false }))).transaction().then((t) => withCU(t))
  let lockSig
  try {
    lockSig = await sendTee(actor, await lockIx(actor))
    if (HELPER) out.helper.lockIn = 'ok'
  } catch (e) {
    if (!HELPER) throw e
    out.helper.lockIn = `FAILED: ${e.message}`
    console.log('  lock_in by the unfunded key FAILED:', e.message, '-> retrying with the creator')
    lockSig = await sendTee(creator, await lockIx(creator))
  }
  link(`lock_in (r${round}) by ${actor === helper && out.helper?.lockIn === 'ok' ? 'unfunded key' : 'creator'}`, lockSig, true)
  l = await readLeague()
  console.log(`  after lock_in: status=${l.status} (2 = Live, 1 = AwaitingVrf)`)

  if (l.status === 1) {
    const t0 = Date.now()
    process.stdout.write('  waiting for the VRF callback')
    while ((l = await readLeague()).status === 1 && Date.now() - t0 < 25_000) {
      process.stdout.write('.')
      await sleep(1500)
    }
    console.log()
    if (l.status === 1) {
      const waitMs = l.vrfDeadline.toNumber() * 1000 - Date.now()
      if (waitMs > 0) await sleep(waitMs + 1500)
      link('finalize_without_vrf', await sendTee(actor, await progOf(actor).methods
        .finalizeWithoutVrf().accountsPartial({ payer: actor.publicKey, league, secret }).transaction()), true)
      out.vrf = 'did not arrive in time; derived from nonces and slot only'
    } else {
      out.vrf = `arrived after ~${Math.round((Date.now() - t0) / 1000)}s and was mixed in`
    }
    console.log('  VRF:', out.vrf)
    l = await readLeague()
  }
  console.log(`  round is Live: status=${l.status}`)

  // positions: each wallet sets a position at the live price
  const sides = [1, -1, 1, -1]
  for (const [i, w] of wallets.entries()) {
    link(`set_position ${short(w.publicKey)} ${sides[i % sides.length] > 0 ? 'long' : 'short'} x${1 + (i % 5)}`, await sendTee(w, await progOf(w).methods
      .setPosition(sides[i % sides.length], 1 + (i % 5)).accountsPartial({
        player: w.publicKey, league, secret, entry: entries[w.publicKey.toBase58()],
        permission: permissionPda(entries[w.publicKey.toBase58()]), priceFeed: SOL_USD_FEED,
      }).transaction()), true)
  }

  // privacy with real positions in place: what can a non-member see now?
  {
    const posSig = out.links.filter((x) => x.label.startsWith(`set_position ${short(wallets[0].publicKey)}`)).at(-1)?.sig
    const ownerEntry = entries[wallets[0].publicKey.toBase58()]
    const outsiders = [['another player', teeOf(wallets[1])]]
    if (HELPER) outsiders.push(['unfunded outsider', teeOf(helper)])
    const res = {}
    for (const [who, conn] of outsiders) {
      res[`entryReadBy_${who}`] = await canRead(conn, ownerEntry)
      let logs = 'denied/none'
      try {
        const t = await conn.getTransaction(posSig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
        logs = t ? `VISIBLE (${t.meta?.logMessages?.length ?? 0} log lines)` : 'denied/none'
      } catch (e) { logs = `denied (${String(e.message).slice(0, 40)})` }
      res[`positionTxBy_${who}`] = logs
    }
    const baseEntry = await base.getAccountInfo(ownerEntry)
    const be = decode(baseProg, 'entry', baseEntry.data)
    res.secretReadByCreatorWhileLive = await canRead(teeC, secret)
    res.secretReadByPlayerWhileLive = await canRead(teeOf(wallets[1]), secret)
    res.secretReadByOutsiderWhileLive = HELPER ? await canRead(teeOf(helper), secret) : 'n/a'
    res.baseLayerCopyShowsPosition = be.side !== 0
    res.ownerSeesOwnPosition = !!(await teeC.getAccountInfo(ownerEntry))
    console.log('privacy with positions in place:', JSON.stringify(res, null, 2))
    out.privacyLive = res
  }

  // keep adjusting until the (hidden) close passes: the first RoundClosed rejection proves
  // set_position is refused after close, before settlement happens.
  let rejectedAfterClose = null
  const w0 = wallets[0]
  const start = Date.now()
  while (Date.now() - start < 120_000) {
    const sig = await sendTee(w0, await progOf(w0).methods
      .setPosition(1, 2).accountsPartial({
        player: w0.publicKey, league, secret, entry: entries[w0.publicKey.toBase58()],
        permission: permissionPda(entries[w0.publicKey.toBase58()]), priceFeed: SOL_USD_FEED,
      }).transaction()).catch((e) => ({ failed: true, sig: e.sig, msg: e.message }))
    if (sig.failed) {
      const tx = await teeOf(w0).getTransaction(sig.sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null)
      const logs = (tx?.meta?.logMessages ?? []).join(' | ')
      const m = logs.match(/Error Code: (\w+)/)
      rejectedAfterClose = { code: m?.[1] ?? sig.msg, sig: sig.sig }
      break
    }
    await sleep(2500)
  }
  console.log('  first rejected set_position:', rejectedAfterClose)
  if (rejectedAfterClose?.sig) link('set_position REJECTED (after close)', rejectedAfterClose.sig, true)
  out.rejectedAfterClose = rejectedAfterClose

  // settlement: anyone can call settle_and_reveal (here: the actor, which may be an unfunded key)
  let settledBy = 'nobody yet'
  const t1 = Date.now()
  while (Date.now() - t1 < 150_000) {
    l = await readLeague().catch(() => null)
    if (!l) break // finished and undelegated: no longer in the TEE
    if (l.status !== 2) break
    {
      settledBy = 'direct call'
      try {
        const sig = await sendTee(actor, await progOf(actor).methods
          .settleAndReveal().accountsPartial({ league, secret, priceFeed: SOL_USD_FEED })
          .remainingAccounts(remainingPairs).transaction().then((t) => withCU(t)))
        link(`settle_and_reveal (r${round}) by ${HELPER ? 'unfunded key' : 'creator'}`, sig, true)
        if (HELPER) out.helper.settle = 'ok'
      } catch (e) {
        console.log('  settle_and_reveal error:', e.message, e.sig ? `(sig ${e.sig.slice(0, 12)}…)` : '')
        if (e.sig) {
          const t = await teeOf(actor).getTransaction(e.sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null)
          for (const l of t?.meta?.logMessages ?? ['    (no logs returned for the failed settle)']) console.log('     ', l)
        }
        if (HELPER) out.helper.settle = `error: ${e.message}`
      }
    }
    await sleep(3000)
  }
  console.log(`  settled by: ${settledBy}`)
  out[`settledBy${round}`] = settledBy
  if (round === ROUNDS - 1) {
    // final reveal: entries in chunks of 4, then the league itself
    const CHUNK = 4
    for (let k = 0; k < 40; k++) {
      const l2 = await readLeague().catch(() => null)
      if (!l2) break
      if (l2.status === 4) break
      if (l2.status === 6 && l2.revealedCount < l2.playerCount) {
        const start = l2.revealedCount
        const chunk = sortedEntries.slice(start, start + CHUNK).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))
        try {
          const sig = await sendTee(actor, await progOf(actor).methods.revealEntries().accountsPartial({ league }).remainingAccounts(chunk).transaction().then((t) => withCU(t)))
          link(`reveal_entries [${start}..${start + chunk.length})`, sig, true)
        } catch (e) { console.log('  reveal_entries error:', e.message) }
      } else if (l2.status === 6) {
        const cardMetas = sortedEntries.map((key) => ({ pubkey: cards[playerOfEntry(key).publicKey.toBase58()], isSigner: false, isWritable: true }))
        try {
          const sig = await sendTee(actor, await progOf(actor).methods.finishLeague().accountsPartial({ league, secret }).remainingAccounts(cardMetas).transaction().then((t) => withCU(t)))
          link('finish_league', sig, true)
        } catch (e) { console.log('  finish_league error:', e.message) }
      }
      await sleep(3000)
    }
  }
  await sleep(6000)
  if (round < ROUNDS - 1) {
    await sleep(6000)
    const lb0 = decode(baseProg, 'league', (await base.getAccountInfo(league)).data)
    const hidden = []
    for (const w of wallets) {
      const e = decode(baseProg, 'entry', (await base.getAccountInfo(entries[w.publicKey.toBase58()])).data)
      const c = decode(baseProg, 'card', (await base.getAccountInfo(cards[w.publicKey.toBase58()])).data)
      hidden.push({ player: short(w.publicKey), base_side: e.side, base_history_scored: e.history[round].scored, card_rounds_scored: c.roundsScored, card_rating: c.rating.toString() })
    }
    console.log(`  after round ${round} settled (base layer): league status=${lb0.status} round=${lb0.round}; entries must show NO position, cards show scores:`)
    console.table(hidden)
    ;(out.betweenRounds ??= []).push({ round, allPositionsHidden: hidden.every((h) => h.base_side === 0 && !h.base_history_scored), cardsScored: hidden.every((h) => h.card_rounds_scored === round + 1) })
  }
}

// ---- reveal & audit (base layer), after the FINAL round ----
console.log('\n===== reveal & audit (base layer) =====')
await sleep(8000)
const lb = decode(baseProg, 'league', (await base.getAccountInfo(league)).data)
const sb = decode(baseProg, 'secret', (await base.getAccountInfo(secret)).data)
console.log(`league status=${lb.status} (4 = Finished) rounds=${lb.round} winner=${lb.winner.toBase58()}`)
const entryData = {}
const rows = []
for (const w of wallets) {
  const k = w.publicKey.toBase58()
  const e = decode(baseProg, 'entry', (await base.getAccountInfo(entries[k])).data)
  const c = decode(baseProg, 'card', (await base.getAccountInfo(cards[k])).data)
  entryData[k] = e
  rows.push({ player: short(w.publicKey), rounds: c.roundsScored, last_ret_bps: c.lastRetBps.toString(), rating: c.rating.toString() })
}
console.table(rows)

const sha = (...bufs) => createHash('sha256').update(Buffer.concat(bufs)).digest()
const audit = []
for (let r = 0; r < lb.round; r++) {
  const rs = sb.history[r]
  const epochLe = Buffer.alloc(2); epochLe.writeUInt16LE(rs.epoch)
  const slotLe = Buffer.alloc(8); slotLe.writeBigUInt64LE(BigInt(rs.lockSlot.toString()))
  const parts = [league.toBuffer(), epochLe, slotLe]
  const positions = []
  for (const key of sortedEntries) {
    const w = playerOfEntry(key)
    const h = entryData[w.publicKey.toBase58()].history[r]
    if (h.committed) parts.push(w.publicKey.toBuffer(), Buffer.from(h.nonce))
    positions.push({ player: short(w.publicKey), side: h.side, lev: h.leverage, entry_price: h.entryPrice.toString(), ret_bps: h.retBps.toString(), scored: h.scored })
  }
  const baseSeed = sha(...parts)
  const okBase = baseSeed.equals(Buffer.from(rs.baseSeed))
  const finalSeed = rs.vrfUsed ? sha(Buffer.from(rs.baseSeed), Buffer.from(rs.randomness)) : baseSeed
  const span = BigInt(lb.maxSecs - lb.minSecs + 1)
  const expectedClose = BigInt(rs.startedAt.toString()) + BigInt(lb.minSecs) + (finalSeed.readBigUInt64LE(0) % span)
  const okClose = expectedClose.toString() === rs.closeAt.toString()
  console.log(`round ${r}: base seed matches ${okBase} | close_at matches ${okClose} | vrf_used ${rs.vrfUsed}`)
  console.table(positions)
  audit.push({ round: r, baseSeedMatches: okBase, closeMatches: okClose, vrfUsed: rs.vrfUsed })
}
out.audit = audit
out.finalStatus = lb.status
saveState(state)
