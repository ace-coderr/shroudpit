import { AnchorProvider, BorshAccountsCoder, Program } from '@anchor-lang/core'
import type { Idl } from '@anchor-lang/core'
import { DELEGATION_PROGRAM_ID, permissionPdaFromAccount } from '@magicblock-labs/ephemeral-rollups-sdk'
import { Connection, PublicKey } from '@solana/web3.js'
import type { Transaction } from '@solana/web3.js'
import bs58 from 'bs58'
import idlJson from './idl.json'
import { BASE_RPC, PROGRAM_ID, TEE_RPC } from './config'
import { FALLBACK_RPCS, resilientFetch } from './rpc'

export const idl = idlJson as unknown as Idl
export const baseConnection = new Connection(BASE_RPC, {
  commitment: 'confirmed',
  fetch: resilientFetch(BASE_RPC, FALLBACK_RPCS),
  disableRetryOnRateLimit: true, // resilientFetch does the backing off and rotates endpoints
})
/** Unauthenticated connection: enough for publicly readable accounts (league, price feed). */
export const teePublicConnection = new Connection(TEE_RPC, {
  commitment: 'confirmed',
  fetch: resilientFetch(TEE_RPC),
  disableRetryOnRateLimit: true,
})
const coder = new BorshAccountsCoder(idl)

export { permissionPdaFromAccount as permissionPda }

const u64le = (n: bigint | number) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true)
  return b
}

export const leaguePda = (creator: PublicKey, id: bigint | number) =>
  PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('league'), creator.toBytes(), u64le(id)],
    PROGRAM_ID,
  )[0]
export const secretPda = (league: PublicKey) =>
  PublicKey.findProgramAddressSync([new TextEncoder().encode('secret'), league.toBytes()], PROGRAM_ID)[0]
export const entryPda = (league: PublicKey, player: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('entry'), league.toBytes(), player.toBytes()],
    PROGRAM_ID,
  )[0]
export const priceFeedPda = (pythLazerId: number) =>
  PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('price_feed'), new TextEncoder().encode('pyth-lazer'), new TextEncoder().encode(String(pythLazerId))],
    new PublicKey('PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd'),
  )[0]

/** Entries must be passed to the program in ascending key order. */
export const sortKeys = (keys: PublicKey[]) =>
  [...keys].sort((a, b) => {
    const x = a.toBytes()
    const y = b.toBytes()
    for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
  })

// ---------- typed account views ----------

type Num = { toString(): string }
const n = (v: Num) => Number(v.toString())

export interface LeagueView {
  key: PublicKey
  creator: PublicKey
  id: string
  status: number
  nRounds: number
  round: number
  playerCount: number
  maxPlayers: number
  closeMode: number
  minSecs: number
  maxSecs: number
  feed: PublicKey
  epoch: number
  nonceDeadline: number
  nonceCount: number
  vrfDeadline: number
  roundStartedAt: number
  settlePrice: number
  settleTime: number
  winner: PublicKey
  revealedCount: number
  /** true when the base-layer copy is stale because the account lives in the rollup */
  delegated: boolean
}

/** One finished round's closing position and nonce. Public only after the league ends. */
export interface RoundPosView {
  nonce: Uint8Array
  committed: boolean
  scored: boolean
  side: number
  leverage: number
  entryPrice: number
  retBps: number
}

export interface EntryView {
  key: PublicKey
  league: PublicKey
  player: PublicKey
  round: number
  nonce: Uint8Array
  nonceEpoch: number
  side: number
  leverage: number
  entryPrice: number
  retBps: number
  /** Revealed on the base layer only after the final round. */
  history: RoundPosView[]
}

/** Public score card, committed after every round. Holds scores only. */
export interface CardView {
  key: PublicKey
  league: PublicKey
  player: PublicKey
  roundsScored: number
  sumRetBps: number
  lastRetBps: number
  rating: number
}

export interface RoundSecretView {
  epoch: number
  startedAt: number
  closeAt: number
  lockSlot: number
  baseSeed: Uint8Array
  randomness: Uint8Array
  vrfUsed: boolean
}

export interface SecretView {
  league: PublicKey
  history: RoundSecretView[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any

export function toLeague(key: PublicKey, data: Uint8Array, delegated: boolean): LeagueView {
  const l: Raw = coder.decode('League', Buffer.from(data))
  return {
    key,
    creator: l.creator,
    id: l.id.toString(),
    status: l.status,
    nRounds: l.n_rounds ?? l.nRounds,
    round: l.round,
    playerCount: l.player_count ?? l.playerCount,
    maxPlayers: l.max_players ?? l.maxPlayers,
    closeMode: l.close_mode ?? l.closeMode,
    minSecs: l.min_secs ?? l.minSecs,
    maxSecs: l.max_secs ?? l.maxSecs,
    feed: l.feed,
    epoch: l.epoch,
    nonceDeadline: n(l.nonce_deadline ?? l.nonceDeadline),
    nonceCount: l.nonce_count ?? l.nonceCount,
    vrfDeadline: n(l.vrf_deadline ?? l.vrfDeadline),
    roundStartedAt: n(l.round_started_at ?? l.roundStartedAt),
    settlePrice: n(l.settle_price ?? l.settlePrice),
    settleTime: n(l.settle_time ?? l.settleTime),
    winner: l.winner,
    revealedCount: l.revealed_count ?? l.revealedCount ?? 0,
    delegated,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pick = (o: Raw, snake: string, camel: string) => o[snake] ?? o[camel]

export function toEntry(key: PublicKey, data: Uint8Array): EntryView {
  const e: Raw = coder.decode('Entry', Buffer.from(data))
  return {
    key,
    league: e.league,
    player: e.player,
    round: e.round,
    nonce: Uint8Array.from(e.nonce),
    nonceEpoch: pick(e, 'nonce_epoch', 'nonceEpoch'),
    side: e.side,
    leverage: e.leverage,
    entryPrice: n(pick(e, 'entry_price', 'entryPrice')),
    retBps: n(pick(e, 'ret_bps', 'retBps')),
    history: (e.history as Raw[]).map((h) => ({
      nonce: Uint8Array.from(h.nonce),
      committed: h.committed,
      scored: h.scored,
      side: h.side,
      leverage: h.leverage,
      entryPrice: n(pick(h, 'entry_price', 'entryPrice')),
      retBps: n(pick(h, 'ret_bps', 'retBps')),
    })),
  }
}

export function toCard(key: PublicKey, data: Uint8Array): CardView {
  const c: Raw = coder.decode('Card', Buffer.from(data))
  return {
    key,
    league: c.league,
    player: c.player,
    roundsScored: pick(c, 'rounds_scored', 'roundsScored'),
    sumRetBps: n(pick(c, 'sum_ret_bps', 'sumRetBps')),
    lastRetBps: n(pick(c, 'last_ret_bps', 'lastRetBps')),
    rating: n(c.rating),
  }
}

export function toSecret(data: Uint8Array): SecretView {
  const s: Raw = coder.decode('Secret', Buffer.from(data))
  return {
    league: s.league,
    history: (s.history as Raw[]).map((r) => ({
      epoch: r.epoch,
      startedAt: n(pick(r, 'started_at', 'startedAt')),
      closeAt: n(pick(r, 'close_at', 'closeAt')),
      lockSlot: n(pick(r, 'lock_slot', 'lockSlot')),
      baseSeed: Uint8Array.from(pick(r, 'base_seed', 'baseSeed')),
      randomness: Uint8Array.from(r.randomness),
      vrfUsed: pick(r, 'vrf_used', 'vrfUsed'),
    })),
  }
}

// ---------- discovery with no backend ----------

const FIELD_SIZE: Record<string, number> = { u8: 1, i8: 1, u16: 2, u32: 4, i32: 4, u64: 8, i64: 8, bool: 1, pubkey: 32 }
type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } }
const sizeOf = (t: IdlType): number => {
  if (typeof t === 'string') return FIELD_SIZE[t]
  if ('array' in t) return sizeOf(t.array[0]) * t.array[1]
  return structSize(t.defined.name)
}
function structSize(name: string): number {
  const def = (idl.types ?? []).find((x) => x.name === name)
  if (!def) throw new Error(`IDL has no type ${name}`)
  const fields = (def.type as unknown as { fields: { type: IdlType }[] }).fields
  return fields.reduce((sum, f) => sum + sizeOf(f.type), 0)
}
const accountSize = (name: string) => 8 + structSize(name)
const discriminator = (name: string) => {
  const acc = (idl.accounts ?? []).find((a) => a.name === name)
  if (!acc) throw new Error(`IDL has no account ${name}`)
  return bs58.encode(Uint8Array.from(acc.discriminator))
}

/**
 * A delegated account keeps its data on the base layer with the delegation program as owner, so
 * leagues and entries are discoverable with plain getProgramAccounts filters: no indexer, no
 * server. The base copy of a delegated account is the state at delegation or last commit.
 */
async function programAccounts(name: string, extra: { memcmp: { offset: number; bytes: string } }[] = []) {
  const filters = [{ dataSize: accountSize(name) }, { memcmp: { offset: 0, bytes: discriminator(name) } }, ...extra]
  const [own, delegated] = await Promise.all([
    baseConnection.getProgramAccounts(PROGRAM_ID, { filters }),
    baseConnection.getProgramAccounts(DELEGATION_PROGRAM_ID, { filters }),
  ])
  return [
    ...own.map((a) => ({ ...a, delegated: false })),
    ...delegated.map((a) => ({ ...a, delegated: true })),
  ]
}

export async function fetchLeagues(): Promise<LeagueView[]> {
  const rows = await programAccounts('League')
  // A delegated league's base copy is stale; overlay the live public copy from the rollup.
  const delegated = rows.filter((r) => r.delegated)
  let live: (Awaited<ReturnType<Connection['getAccountInfo']>>)[] = []
  if (delegated.length > 0) {
    try {
      live = await teePublicConnection.getMultipleAccountsInfo(delegated.map((r) => r.pubkey))
    } catch {
      live = []
    }
  }
  const liveOf = new Map(delegated.map((r, i) => [r.pubkey.toBase58(), live[i] ?? null]))
  return rows
    .map((r) => {
      const l = liveOf.get(r.pubkey.toBase58())
      return toLeague(r.pubkey, l ? l.data : r.account.data, r.delegated)
    })
    .sort((a, b) => Number(b.id) - Number(a.id))
}

export async function fetchLeague(key: PublicKey): Promise<LeagueView | null> {
  const base = await baseConnection.getAccountInfo(key)
  if (!base) return null
  const delegated = !base.owner.equals(PROGRAM_ID)
  if (delegated) {
    // The live copy is inside the Private ER. The league account is public there.
    try {
      const live = await teePublicConnection.getAccountInfo(key)
      if (live) return toLeague(key, live.data, true)
    } catch {
      /* fall back to the last committed copy */
    }
  }
  return toLeague(key, base.data, delegated)
}

/**
 * The live copy of a delegated league, straight from the rollup. One request, none to the base
 * layer: used by the desk helper, which polls every second while a settlement window is open.
 */
export async function fetchLiveLeague(key: PublicKey): Promise<LeagueView | null> {
  const live = await teePublicConnection.getAccountInfo(key)
  return live ? toLeague(key, live.data, true) : null
}

// ---------- who plays in a league: found once, then derived ----------
//
// getProgramAccounts is the one call public devnet rate-limits hardest, so it is used only to find
// out WHO is in a league (the score cards carry the player). After that every entry and card is a
// PDA of (league, player): it is read with getMultipleAccounts, which is cheap and batchable.

interface PlayerList {
  players: PublicKey[]
  t: number
  complete: boolean
}
const PLAYERS_STORE = 'shroudpit.players.v1.'
const playerLists = new Map<string, PlayerList>()

function loadPlayerList(league: string): PlayerList | null {
  const mem = playerLists.get(league)
  if (mem) return mem
  try {
    const raw = localStorage.getItem(PLAYERS_STORE + league)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { players: string[]; t: number }
    const list = { players: parsed.players.map((p) => new PublicKey(p)), t: parsed.t, complete: true }
    playerLists.set(league, list)
    return list
  } catch {
    return null
  }
}
function savePlayerList(league: string, players: PublicKey[], expected: number | undefined) {
  // a list is final only when we know how many players the league has and have found them all
  const complete = expected !== undefined && expected >= 2 && players.length >= expected
  playerLists.set(league, { players, t: Date.now(), complete })
  if (!complete) return
  try {
    localStorage.setItem(PLAYERS_STORE + league, JSON.stringify({ players: players.map((p) => p.toBase58()), t: Date.now() }))
  } catch {
    /* storage unavailable: the in-memory copy still works for this session */
  }
}
/** A usable remembered player list, or null when the players have to be looked up. */
function knownPlayers(league: PublicKey, expected?: number): PublicKey[] | null {
  const list = loadPlayerList(league.toBase58())
  if (!list) return null
  if (list.complete && (expected === undefined || list.players.length >= expected)) return list.players
  // an incomplete list (joining may still be open) is only trusted briefly
  return expected !== undefined && list.players.length >= expected ? list.players : Date.now() - list.t < 15_000 ? list.players : null
}

async function discoverCards(league: PublicKey, expected?: number): Promise<CardView[]> {
  const rows = await programAccounts('Card', [{ memcmp: { offset: 8, bytes: league.toBase58() } }])
  const cards = rows.map((r) => toCard(r.pubkey, r.account.data))
  savePlayerList(league.toBase58(), cards.map((c) => c.player), expected)
  return cards
}

/**
 * Accounts created under an older program layout have a different size. The old getProgramAccounts
 * filters excluded them silently, so derived reads must too, or decoding them throws.
 */
const isCurrent = (ai: { data: Uint8Array } | null, name: string): ai is { data: Uint8Array } => !!ai && ai.data.length === accountSize(name)

/** getMultipleAccounts in chunks of 100 (the RPC limit), in order, with null for missing accounts. */
async function readMany(conn: Connection, keys: PublicKey[]) {
  const out: Awaited<ReturnType<Connection['getMultipleAccountsInfo']>> = []
  for (let i = 0; i < keys.length; i += 100) out.push(...(await conn.getMultipleAccountsInfo(keys.slice(i, i + 100))))
  return out
}

/** Entries of a league. Pass the league's player count when known so the player list can be trusted. */
export async function fetchEntries(league: PublicKey, expected?: number): Promise<EntryView[]> {
  let players = knownPlayers(league, expected)
  if (!players) players = (await discoverCards(league, expected)).map((c) => c.player)
  const keys = players.map((p) => entryPda(league, p))
  const infos = await readMany(baseConnection, keys)
  return infos.flatMap((ai, i) => (isCurrent(ai, 'Entry') ? [toEntry(keys[i], ai.data)] : []))
}

/** Score cards of a league: one lookup the first time, plain batched reads after that. */
export async function fetchCards(league: PublicKey, expected?: number): Promise<CardView[]> {
  const players = knownPlayers(league, expected)
  if (!players) return discoverCards(league, expected)
  const keys = players.map((p) => cardPda(league, p))
  const infos = await readMany(baseConnection, keys)
  return infos.flatMap((ai, i) => (isCurrent(ai, 'Card') ? [toCard(keys[i], ai.data)] : []))
}

export async function fetchCardsForPlayer(player: PublicKey): Promise<CardView[]> {
  const rows = await programAccounts('Card', [{ memcmp: { offset: 8 + 32, bytes: player.toBase58() } }])
  return rows.map((r) => toCard(r.pubkey, r.account.data))
}

/** Leagues by address: one batched read on devnet, plus the live public copy from the rollup. */
export async function fetchLeaguesByKey(keys: PublicKey[]): Promise<LeagueView[]> {
  if (keys.length === 0) return []
  const [base, live] = await Promise.all([
    readMany(baseConnection, keys),
    readMany(teePublicConnection, keys).catch(() => [] as Awaited<ReturnType<typeof readMany>>),
  ])
  return keys
    .flatMap((key, i) => {
      const b = base[i]
      if (!b || !isCurrent(b, 'League')) return []
      const delegated = !b.owner.equals(PROGRAM_ID)
      const l = delegated && isCurrent(live[i] ?? null, 'League') ? live[i] : null
      return [toLeague(key, l ? l.data : b.data, delegated)]
    })
    .sort((x, y) => Number(y.id) - Number(x.id))
}

/** Revealed secret (only meaningful once committed to the base layer). */
export async function fetchSecretBase(league: PublicKey): Promise<SecretView | null> {
  const ai = await baseConnection.getAccountInfo(secretPda(league))
  return ai ? toSecret(ai.data) : null
}

// ---------- price ----------

export interface Quote {
  price: number
  publishTime: number
}
/** SOL/USD etc. as served by the real-time oracle. Read from the rollup, never the base layer. */
export async function fetchQuote(conn: Connection, feed: PublicKey): Promise<Quote | null> {
  const ai = await conn.getAccountInfo(feed)
  if (!ai || ai.data.length < 101) return null
  const dv = new DataView(ai.data.buffer, ai.data.byteOffset, ai.data.byteLength)
  // exponent -8 on every feed in the oracle's list; only the ratio matters for scoring
  const price = Number(dv.getBigInt64(73, true)) / 1e8
  return { price, publishTime: Number(dv.getBigInt64(93, true)) }
}

// ---------- program client (instruction building only) ----------

export function programFor(connection: Connection, publicKey: PublicKey) {
  const wallet = {
    publicKey,
    signTransaction: async <T,>(tx: T) => tx,
    signAllTransactions: async <T,>(txs: T[]) => txs,
  }
  return new Program(idl, new AnchorProvider(connection, wallet as never, { commitment: 'confirmed' }))
}

export type AnyTx = Transaction

// ---------- trophies ----------

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const trophyMint = (league: PublicKey) =>
  PublicKey.findProgramAddressSync([new TextEncoder().encode('trophy'), league.toBytes()], PROGRAM_ID)[0]

/** Has this league's trophy been minted yet? The mint is a PDA that can exist only once. */
export async function trophyClaimed(league: PublicKey): Promise<boolean> {
  return !!(await baseConnection.getAccountInfo(trophyMint(league)))
}

const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const ata = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ATA_PROGRAM)[0]

/**
 * Everything the Record page needs, in a small fixed number of calls:
 *   1. the wallet's score cards (the one getProgramAccounts lookup),
 *   2. those leagues in one batched read (plus one on the rollup for live ones),
 *   3. for finished leagues: each league's trophy mint and the wallet's token account for it,
 *      both derived addresses, in one more batched read. No token-account scan.
 * A wallet can only win a league it played, so deriving from its own leagues finds its trophies.
 */
export async function fetchRecord(player: PublicKey) {
  const cards = await fetchCardsForPlayer(player)
  const leagues = await fetchLeaguesByKey([...new Set(cards.map((c) => c.league.toBase58()))].map((k) => new PublicKey(k)))
  const byKey = new Map(leagues.map((l) => [l.key.toBase58(), l]))
  const rows = cards
    .map((card) => ({ card, league: byKey.get(card.league.toBase58()) }))
    .filter((r): r is { card: CardView; league: LeagueView } => !!r.league)
    .sort((a, b) => Number(b.league.id) - Number(a.league.id))

  const finished = leagues.filter((l) => l.status === 4)
  const mints = finished.map((l) => trophyMint(l.key))
  const infos = finished.length ? await readMany(baseConnection, [...mints, ...mints.map((m) => ata(player, m))]) : []
  const held: { mint: PublicKey; league: LeagueView }[] = []
  const claimable: LeagueView[] = []
  finished.forEach((league, i) => {
    const mintExists = !!infos[i]
    const tokenAccount = infos[finished.length + i]
    // SPL token account layout: mint (32) owner (32) amount (u64 LE at byte 64)
    const amount = tokenAccount && tokenAccount.data.length >= 72 ? new DataView(tokenAccount.data.buffer, tokenAccount.data.byteOffset).getBigUint64(64, true) : 0n
    if (amount >= 1n) held.push({ mint: mints[i], league })
    if (!mintExists && league.winner.equals(player)) claimable.push(league)
  })
  return { rows, held, claimable }
}

/** Map a failed transaction's logs to the program error name. */
export function errorFromLogs(logs: string[] | null | undefined): string | null {
  const m = (logs ?? []).join('\n').match(/Error Code: (\w+)/)
  return m ? m[1] : null
}

export const cardPda = (league: PublicKey, player: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('card'), league.toBytes(), player.toBytes()],
    PROGRAM_ID,
  )[0]
