// Full round on devnet with several wallets: create, join, delegate to the TEE, permissions,
// nonce commits, lock-in (optionally with VRF), positions, the "rejected after close" check,
// settlement, and an independent recomputation of the close-time derivation.
//
//   WALLETS=3 CLOSE_MODE=0|1 ROUNDS=1 CRANK=0|1 KEYPAIR_DIR=/dir node scripts/e2e/10-round.mjs
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import BN from 'bn.js'
import {
  BASE_RPC, SOL_USD_FEED, TEE_VALIDATOR, decode, entryPda, explorerBase,
  explorerTee, leaguePda, loadKeypair, loadState, permissionPda, programFor, saveState, send, sleep, sortKeys,
  teeConnection,
} from './lib.mjs'

const N = Number(process.env.WALLETS ?? 3)
const CLOSE_MODE = Number(process.env.CLOSE_MODE ?? 0)
const ROUNDS = Number(process.env.ROUNDS ?? 1)
const CRANK = process.env.CRANK === '1'
const DIR = process.env.KEYPAIR_DIR
const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))

// ---- wallets (keypairs stay outside the repo) ----
const files = ['shroudpit-devnet.json', 'shroudpit-p2.json', 'shroudpit-p3.json', 'shroudpit-p4.json']
for (const f of files.slice(0, N)) {
  const p = join(DIR, f)
  if (!existsSync(p)) writeFileSync(p, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 })
}
const wallets = files.slice(0, N).map((f) => loadKeypair(join(DIR, f)))
const creator = wallets[0]
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
const secret = PublicKey.findProgramAddressSync([Buffer.from('secret'), league.toBuffer()], idl.address ? new PublicKey(idl.address) : undefined)[0]
const entries = Object.fromEntries(wallets.map((w) => [w.publicKey.toBase58(), entryPda(league, w.publicKey)]))
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

for (let round = 0; round < ROUNDS; round++) {
  console.log(`\n===== round ${round} =====`)
  // open the nonce phase
  link(`start_round (r${round})`, await sendTee(creator, await progOf(creator).methods
    .startRound().accountsPartial({ creator: creator.publicKey, league }).transaction()), true)
  let l = await readLeague()
  console.log(`  status=${l.status} (5 = Nonces) epoch=${l.epoch} nonce_deadline in ${l.nonceDeadline.toNumber() - Math.floor(Date.now() / 1000)}s`)

  // schedule the settlement crank for this round
  if (CRANK) {
    try {
      link(`schedule_settle (r${round})`, await sendTee(creator, await progOf(creator).methods
        .scheduleSettle().accountsPartial({ payer: creator.publicKey, league, secret, priceFeed: SOL_USD_FEED })
        .remainingAccounts(remaining).transaction()), true)
    } catch (e) {
      console.log('  schedule_settle FAILED:', e.message)
      out.crank = { ok: false, error: e.message }
    }
  }

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
  const lockSig = await sendTee(creator, await progOf(creator).methods
    .lockIn().accountsPartial({ payer: creator.publicKey, league, secret })
    .remainingAccounts(remaining.map((r) => ({ ...r, isWritable: false }))).transaction())
  link(`lock_in (r${round})`, lockSig, true)
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
      link('finalize_without_vrf', await sendTee(creator, await progOf(creator).methods
        .finalizeWithoutVrf().accountsPartial({ payer: creator.publicKey, league, secret }).transaction()), true)
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
    link(`set_position ${short(w.publicKey)} ${sides[i] > 0 ? 'long' : 'short'} x${2 + i}`, await sendTee(w, await progOf(w).methods
      .setPosition(sides[i], 2 + i).accountsPartial({
        player: w.publicKey, league, secret, entry: entries[w.publicKey.toBase58()],
        permission: permissionPda(entries[w.publicKey.toBase58()]), priceFeed: SOL_USD_FEED,
      }).transaction()), true)
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

  // settlement: by the crank if scheduled, else by anyone calling settle_and_reveal
  let settledBy = 'crank'
  const t1 = Date.now()
  while (Date.now() - t1 < 150_000) {
    l = await readLeague().catch(() => null)
    if (!l) break // finished and undelegated: no longer in the TEE
    if (l.status !== 2) break
    if (!CRANK || Date.now() - t1 > 25_000) {
      settledBy = 'direct call'
      try {
        const sig = await sendTee(creator, await progOf(creator).methods
          .settleAndReveal().accountsPartial({ league, secret, priceFeed: SOL_USD_FEED })
          .remainingAccounts(remaining).transaction())
        link(`settle_and_reveal (r${round})`, sig, true)
      } catch (e) {
        console.log('  settle_and_reveal error:', e.message)
      }
    }
    await sleep(3000)
  }
  console.log(`  settled by: ${settledBy}`)
  out[`settledBy${round}`] = settledBy
  await sleep(6000)
}

// ---- reveal & audit: read the committed state from the BASE layer ----
console.log('\n===== reveal & audit (base layer) =====')
await sleep(8000)
const lb = decode(baseProg, 'league', (await base.getAccountInfo(league)).data)
const sb = decode(baseProg, 'secret', (await base.getAccountInfo(secret)).data)
console.log(`league status=${lb.status} (3 = Between, 4 = Finished) round=${lb.round} winner=${lb.winner.toBase58()} settle_price=${lb.settlePrice.toString()}`)
const rows = []
for (const w of wallets) {
  const e = decode(baseProg, 'entry', (await base.getAccountInfo(entries[w.publicKey.toBase58()])).data)
  rows.push({ player: short(w.publicKey), side: e.side, lev: e.leverage, entry_price: e.entryPrice.toString(), last_ret_bps: e.lastRetBps.toString(), rating: e.rating.toString(), nonce: Buffer.from(e.nonce).toString('hex').slice(0, 12) + '…' })
  out[`entry_${short(w.publicKey)}`] = { nonce: Buffer.from(e.nonce).toString('hex'), epoch: e.nonceEpoch }
}
console.table(rows)

// independent recomputation of the close-time derivation from what was revealed
const sha = (...bufs) => createHash('sha256').update(Buffer.concat(bufs)).digest()
const epochLe = Buffer.alloc(2); epochLe.writeUInt16LE(lb.epoch)
const slotLe = Buffer.alloc(8); slotLe.writeBigUInt64LE(BigInt(sb.lockSlot.toString()))
const parts = [league.toBuffer(), epochLe, slotLe]
for (const key of sortedEntries) {
  const w = wallets.find((x) => entries[x.publicKey.toBase58()].equals(key))
  const e = decode(baseProg, 'entry', (await base.getAccountInfo(key)).data)
  if (e.nonceEpoch === lb.epoch) parts.push(w.publicKey.toBuffer(), Buffer.from(e.nonce))
}
const baseSeed = sha(...parts)
const okBase = baseSeed.equals(Buffer.from(sb.baseSeed))
console.log('recomputed base seed matches the on-chain secret.base_seed:', okBase)
const finalSeed = sb.vrfUsed ? sha(Buffer.from(sb.baseSeed), Buffer.from(sb.randomness)) : baseSeed
const span = BigInt(lb.maxSecs - lb.minSecs + 1)
const offset = finalSeed.readBigUInt64LE(0) % span
const expectedClose = BigInt(lb.roundStartedAt.toString()) + BigInt(lb.minSecs) + offset
console.log('recomputed close_at', expectedClose.toString(), 'vs on-chain', sb.closeAt.toString(), '=>', expectedClose.toString() === sb.closeAt.toString())
console.log('vrf_used:', sb.vrfUsed)
out.audit = { baseSeedMatches: okBase, closeMatches: expectedClose.toString() === sb.closeAt.toString(), vrfUsed: sb.vrfUsed, closeAt: sb.closeAt.toString() }
saveState(state)
