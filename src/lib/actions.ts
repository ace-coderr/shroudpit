import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import type { Connection } from '@solana/web3.js'
import BN from 'bn.js'
import nacl from 'tweetnacl'
import {
  baseConnection, entryPda, fetchEntries, permissionPda, programFor, secretPda, sortKeys,
} from './chain'
import { TEE_VALIDATOR } from './config'
import { sendBase, sendTee, teeSession } from './session'
import type { Signer } from './session'

export interface CreateParams {
  rounds: number
  minSecs: number
  maxSecs: number
  maxPlayers: number
  feedId: number
  closeMode: number
}

/** Creator console: create the league and its private secret account on devnet. */
export async function createLeague(signer: Signer, p: CreateParams) {
  const id = BigInt(Date.now())
  const idBuf = new Uint8Array(8)
  new DataView(idBuf.buffer).setBigUint64(0, id, true)
  const league = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('league'), signer.publicKey.toBytes(), idBuf],
    programFor(baseConnection, signer.publicKey).programId,
  )[0]
  const tx = await programFor(baseConnection, signer.publicKey)
    .methods.createLeague(new BN(id.toString()), p.rounds, p.minSecs, p.maxSecs, p.maxPlayers, p.feedId, p.closeMode)
    .accountsPartial({ creator: signer.publicKey, league, secret: secretPda(league) })
    .transaction()
  const signature = await sendBase(baseConnection, signer, tx)
  return { league, signature }
}

/** Join: pay the entry rent, then delegate the entry to the TEE validator in the same transaction. */
export async function joinLeague(signer: Signer, league: PublicKey) {
  const prog = programFor(baseConnection, signer.publicKey)
  const entry = entryPda(league, signer.publicKey)
  const join = await prog.methods.joinLeague().accountsPartial({ player: signer.publicKey, league, entry }).instruction()
  const del = await prog.methods
    .delegateEntry()
    .accountsPartial({ player: signer.publicKey, league, entry, validator: TEE_VALIDATOR })
    .instruction()
  return sendBase(baseConnection, signer, new Transaction().add(join, del))
}

/** Creator closes joining: delegate the league and its secret to the Private ER. */
export async function startLeague(signer: Signer, league: PublicKey) {
  const tx = await programFor(baseConnection, signer.publicKey)
    .methods.delegateLeague()
    .accountsPartial({ creator: signer.publicKey, league, secret: secretPda(league), validator: TEE_VALIDATOR })
    .transaction()
  return sendBase(baseConnection, signer, tx)
}

/** Make the player's entry private to them. Idempotent on-chain. */
export async function sealEntry(signer: Signer, league: PublicKey) {
  const { connection } = await teeSession(signer)
  const entry = entryPda(league, signer.publicKey)
  const tx = await programFor(connection, signer.publicKey)
    .methods.initEntryPermission()
    .accountsPartial({ payer: signer.publicKey, entry, permission: permissionPda(entry) })
    .transaction()
  return sendTee(connection, signer, tx)
}

/** Creator hides the close time from everyone. */
export async function sealSecret(signer: Signer, league: PublicKey) {
  const { connection } = await teeSession(signer)
  const secret = secretPda(league)
  const tx = await programFor(connection, signer.publicKey)
    .methods.initSecretPermission()
    .accountsPartial({ payer: signer.publicKey, league, secret, permission: permissionPda(secret) })
    .transaction()
  return sendTee(connection, signer, tx)
}

export async function openRound(signer: Signer, league: PublicKey) {
  const { connection } = await teeSession(signer)
  const tx = await programFor(connection, signer.publicKey)
    .methods.startRound()
    .accountsPartial({ creator: signer.publicKey, league })
    .transaction()
  return sendTee(connection, signer, tx)
}

/** Commit a fresh random nonce. It stays private until settlement reveals it. */
export async function commitNonce(signer: Signer, league: PublicKey) {
  const { connection } = await teeSession(signer)
  const entry = entryPda(league, signer.publicKey)
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)))
  const tx = await programFor(connection, signer.publicKey)
    .methods.commitNonce(nonce as never)
    .accountsPartial({ player: signer.publicKey, league, entry, permission: permissionPda(entry) })
    .transaction()
  return sendTee(connection, signer, tx)
}

async function remainingEntries(league: PublicKey, writable: boolean) {
  const keys = sortKeys((await fetchEntries(league)).map((e) => e.key))
  return keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: writable }))
}

export async function lockIn(signer: Signer | Keypair, connection: Connection, league: PublicKey) {
  const tx = await programFor(connection, signer.publicKey)
    .methods.lockIn()
    .accountsPartial({ payer: signer.publicKey, league, secret: secretPda(league) })
    .remainingAccounts(await remainingEntries(league, false))
    .transaction()
  return sendTee(connection, signer, tx)
}

export async function finalizeWithoutVrf(signer: Signer | Keypair, connection: Connection, league: PublicKey) {
  const tx = await programFor(connection, signer.publicKey)
    .methods.finalizeWithoutVrf()
    .accountsPartial({ payer: signer.publicKey, league, secret: secretPda(league) })
    .transaction()
  return sendTee(connection, signer, tx)
}

export async function setPosition(signer: Signer, league: PublicKey, feed: PublicKey, side: number, leverage: number) {
  const { connection } = await teeSession(signer)
  const entry = entryPda(league, signer.publicKey)
  const tx = await programFor(connection, signer.publicKey)
    .methods.setPosition(side, leverage)
    .accountsPartial({
      player: signer.publicKey, league, secret: secretPda(league), entry,
      permission: permissionPda(entry), priceFeed: feed,
    })
    .transaction()
  return sendTee(connection, signer, tx)
}

/** Permissionless: anyone can settle once the hidden close has passed. */
export async function settle(signer: Signer | Keypair, connection: Connection, league: PublicKey, feed: PublicKey) {
  const tx = await programFor(connection, signer.publicKey)
    .methods.settleAndReveal()
    .accountsPartial({ league, secret: secretPda(league), priceFeed: feed })
    .remainingAccounts(await remainingEntries(league, true))
    .transaction()
  return sendTee(connection, signer, tx)
}

/**
 * A throwaway keypair that pays nothing and holds nothing. It lets the page poll settlement and
 * lock-in without a wallet pop-up each time; the program does not care who triggers them.
 */
let helper: Keypair | null = null
export function helperKeypair(): Keypair {
  helper ??= Keypair.generate()
  return helper
}
export async function helperConnection(): Promise<Connection> {
  const kp = helperKeypair()
  const signer: Signer = {
    publicKey: kp.publicKey,
    signTransaction: async (tx) => (tx.partialSign(kp), tx),
    signMessage: async (m) => nacl.sign.detached(m, kp.secretKey),
  }
  return (await teeSession(signer)).connection
}
