// Shared helpers for the devnet end-to-end scripts. Reads keypairs from a directory outside the
// repository (KEYPAIR_DIR) and keeps run state under .e2e/ (git-ignored).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from '@solana/web3.js'
import * as anchor from '@anchor-lang/core'
import nacl from 'tweetnacl'
import { DELEGATION_PROGRAM_ID, getAuthToken, verifyTeeRpcIntegrity } from '@magicblock-labs/ephemeral-rollups-sdk'
import bs58 from 'bs58'

// The program under test is whatever the IDL says (IDL=path overrides the default).
const IDL_PATH = process.env.IDL ?? 'program/target/idl/shroudpit.json'
export const PROGRAM_ID = new PublicKey(JSON.parse(readFileSync(IDL_PATH, 'utf8')).address)
export const TEE_VALIDATOR = new PublicKey('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo')
export const ER_VALIDATOR = {
  eu: new PublicKey('MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e'),
  as: new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57'),
}
export const BASE_RPC = 'https://api.devnet.solana.com'
export const TEE_RPC = 'https://devnet-tee.magicblock.app'
export const ORACLE = new PublicKey('PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd')
export const SOL_USD_FEED = new PublicKey('ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu')
export {
  EPHEMERAL_VAULT_ID as VAULT,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID as MAGIC_PROGRAM,
  PERMISSION_PROGRAM_ID as PERMISSION_PROGRAM,
  permissionPdaFromAccount as permissionPda,
} from '@magicblock-labs/ephemeral-rollups-sdk'

const STATE_DIR = '.e2e'
export function loadState() {
  const p = join(STATE_DIR, 'state.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
}
export function saveState(s) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(join(STATE_DIR, 'state.json'), JSON.stringify(s, null, 2))
}

export function loadKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
}

export function explorerBase(sig) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`
}
export function explorerTee(sig) {
  return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(TEE_RPC)}`
}

export function leaguePda(creator, id) {
  const idLe = Buffer.alloc(8)
  idLe.writeBigUInt64LE(BigInt(id))
  return PublicKey.findProgramAddressSync([Buffer.from('league'), creator.toBuffer(), idLe], PROGRAM_ID)[0]
}
export function entryPda(league, player) {
  return PublicKey.findProgramAddressSync([Buffer.from('entry'), league.toBuffer(), player.toBuffer()], PROGRAM_ID)[0]
}
export function cardPda(league, player) {
  return PublicKey.findProgramAddressSync([Buffer.from('card'), league.toBuffer(), player.toBuffer()], PROGRAM_ID)[0]
}

/** Put an explicit compute budget in front of a transaction. */
export function withCU(tx, units = 1_400_000) {
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units }))
  return tx
}

export function sortKeys(keys) {
  return [...keys].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()))
}

export function programFor(idl, connection, kp) {
  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async (tx) => (tx.partialSign(kp), tx),
    signAllTransactions: async (txs) => txs.map((tx) => (tx.partialSign(kp), tx)),
  }
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' })
  return new anchor.Program(idl, provider)
}

export async function teeConnection(kp) {
  try {
    await verifyTeeRpcIntegrity(TEE_RPC)
  } catch (e) {
    // attestation needs a third-party certificate service; do not let its outage stop a test run
    console.log('  (attestation check skipped: ' + String(e.cause?.code ?? e.message).slice(0, 40) + ')')
  }
  const { token } = await getAuthToken(TEE_RPC, kp.publicKey, (m) => Promise.resolve(nacl.sign.detached(m, kp.secretKey)))
  // The token is a secret: it is only held in memory and never printed.
  return new Connection(`${TEE_RPC}?token=${token}`, { wsEndpoint: `${TEE_RPC.replace('https', 'wss')}?token=${token}`, commitment: 'confirmed' })
}

export async function send(connection, tx, signers, { skipPreflight = false } = {}) {
  tx.feePayer = signers[0].publicKey
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.sign(...signers)
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight })
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  if (res.value.err) throw Object.assign(new Error(`tx failed: ${JSON.stringify(res.value.err)}`), { sig })
  return sig
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function decode(program, name, data) {
  return program.coder.accounts.decode(name, data)
}

/**
 * Find a league's entries on chain (delegated ones keep their data on the base layer, owned by the
 * delegation program) and build the account lists the program expects. Nothing is assumed about
 * which wallets play.
 *   entries: [{ key, player }] in ascending entry-key order
 *   pairs:   [entry, card, entry, card, ...] for settle_and_reveal (both writable)
 */
export async function discoverEntries(base, prog, league) {
  const disc = bs58.encode(Buffer.from(prog.idl.accounts.find((a) => a.name.toLowerCase() === 'entry').discriminator))
  const rows = []
  for (const owner of [PROGRAM_ID, DELEGATION_PROGRAM_ID]) {
    const accs = await base.getProgramAccounts(owner, {
      filters: [{ memcmp: { offset: 0, bytes: disc } }, { memcmp: { offset: 8, bytes: league.toBase58() } }],
    })
    for (const a of accs) rows.push({ key: a.pubkey, player: prog.coder.accounts.decode('entry', a.account.data).player })
  }
  rows.sort((x, y) => Buffer.compare(x.key.toBuffer(), y.key.toBuffer()))
  const pairs = rows.flatMap((r) => [
    { pubkey: r.key, isSigner: false, isWritable: true },
    { pubkey: cardPda(league, r.player), isSigner: false, isWritable: true },
  ])
  return { entries: rows, pairs }
}
