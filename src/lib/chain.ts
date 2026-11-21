import { AnchorProvider, BorshAccountsCoder, Program } from '@anchor-lang/core'
import type { Idl } from '@anchor-lang/core'
import { DELEGATION_PROGRAM_ID, permissionPdaFromAccount } from '@magicblock-labs/ephemeral-rollups-sdk'
import { Connection, PublicKey } from '@solana/web3.js'
import type { Transaction } from '@solana/web3.js'
import bs58 from 'bs58'
import idlJson from './idl.json'
import { BASE_RPC, PROGRAM_ID, TEE_RPC } from './config'

export const idl = idlJson as unknown as Idl
export const baseConnection = new Connection(BASE_RPC, 'confirmed')
/** Unauthenticated connection: enough for publicly readable accounts (league, price feed). */
export const teePublicConnection = new Connection(TEE_RPC, 'confirmed')
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
  /** true when the base-layer copy is stale because the account lives in the rollup */
  delegated: boolean
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
  roundsScored: number
  sumRetBps: number
  lastRetBps: number
  rating: number
}

export interface SecretView {
  league: PublicKey
  vrfUsed: boolean
  closeAt: number
  lockSlot: number
  baseSeed: Uint8Array
  randomness: Uint8Array
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
    delegated,
  }
}

export function toEntry(key: PublicKey, data: Uint8Array): EntryView {
  const e: Raw = coder.decode('Entry', Buffer.from(data))
  return {
    key,
    league: e.league,
    player: e.player,
    round: e.round,
    nonce: Uint8Array.from(e.nonce),
    nonceEpoch: e.nonce_epoch ?? e.nonceEpoch,
    side: e.side,
    leverage: e.leverage,
    entryPrice: n(e.entry_price ?? e.entryPrice),
    retBps: n(e.ret_bps ?? e.retBps),
    roundsScored: e.rounds_scored ?? e.roundsScored,
    sumRetBps: n(e.sum_ret_bps ?? e.sumRetBps),
    lastRetBps: n(e.last_ret_bps ?? e.lastRetBps),
    rating: n(e.rating),
  }
}

export function toSecret(data: Uint8Array): SecretView {
  const s: Raw = coder.decode('Secret', Buffer.from(data))
  return {
    league: s.league,
    vrfUsed: s.vrf_used ?? s.vrfUsed,
    closeAt: n(s.close_at ?? s.closeAt),
    lockSlot: n(s.lock_slot ?? s.lockSlot),
    baseSeed: Uint8Array.from(s.base_seed ?? s.baseSeed),
    randomness: Uint8Array.from(s.randomness),
  }
}

// ---------- discovery with no backend ----------

const FIELD_SIZE: Record<string, number> = { u8: 1, i8: 1, u16: 2, u32: 4, i32: 4, u64: 8, i64: 8, bool: 1, pubkey: 32 }
type IdlType = string | { array: [IdlType, number] }
const sizeOf = (t: IdlType): number => (typeof t === 'string' ? FIELD_SIZE[t] : sizeOf(t.array[0]) * t.array[1])
function accountSize(name: string) {
  const def = (idl.types ?? []).find((t) => t.name === name)
  if (!def) throw new Error(`IDL has no type ${name}`)
  const fields = (def.type as unknown as { fields: { type: IdlType }[] }).fields
  return 8 + fields.reduce((sum, f) => sum + sizeOf(f.type), 0)
}
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

export async function fetchEntries(league: PublicKey): Promise<EntryView[]> {
  const rows = await programAccounts('Entry', [{ memcmp: { offset: 8, bytes: league.toBase58() } }])
  return rows.map((r) => toEntry(r.pubkey, r.account.data))
}

export async function fetchEntriesForPlayer(player: PublicKey): Promise<EntryView[]> {
  const rows = await programAccounts('Entry', [{ memcmp: { offset: 8 + 32, bytes: player.toBase58() } }])
  return rows.map((r) => toEntry(r.pubkey, r.account.data))
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

/** Map a failed transaction's logs to the program error name. */
export function errorFromLogs(logs: string[] | null | undefined): string | null {
  const m = (logs ?? []).join('\n').match(/Error Code: (\w+)/)
  return m ? m[1] : null
}
