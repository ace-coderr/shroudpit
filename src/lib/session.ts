import { getAuthToken, verifyTeeRpcIntegrity } from '@magicblock-labs/ephemeral-rollups-sdk'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import nacl from 'tweetnacl'
import { errorFromLogs } from './chain'
import { TEE_RPC } from './config'

/** The subset of the wallet adapter the session needs. */
export interface Signer {
  publicKey: PublicKey
  signTransaction: (tx: Transaction) => Promise<Transaction>
  signMessage: (message: Uint8Array) => Promise<Uint8Array>
}

interface TeeSession {
  connection: Connection
  expiresAt: number
  attested: boolean
}

// Tokens are secrets: kept in memory only, never persisted, never put in a URL we display.
const sessions = new Map<string, TeeSession>()

/**
 * Open an authenticated connection to the Private ER. The wallet signs a challenge once; the
 * resulting token is what lets the enclave show this wallet its own entry.
 */
export async function teeSession(signer: Signer): Promise<TeeSession> {
  const key = signer.publicKey.toBase58()
  const cached = sessions.get(key)
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached

  let attested = false
  try {
    await verifyTeeRpcIntegrity(TEE_RPC)
    attested = true
  } catch {
    // The attestation check needs a third-party certificate service; browsers may block it.
    // The UI shows the result instead of pretending it passed.
    attested = false
  }
  const { token, expiresAt } = await getAuthToken(TEE_RPC, signer.publicKey, signer.signMessage)
  const connection = new Connection(`${TEE_RPC}?token=${token}`, {
    wsEndpoint: `${TEE_RPC.replace('https', 'wss')}?token=${token}`,
    commitment: 'confirmed',
  })
  const session = { connection, expiresAt: Number(expiresAt), attested }
  sessions.set(key, session)
  return session
}

/** Forget a cached Private ER session so the next call logs in again (used when a call stalls). */
export function forgetTeeSession(publicKey: PublicKey) {
  sessions.delete(publicKey.toBase58())
}

/** Reject if `p` does not settle in time. The slow call keeps running; nothing waits for it. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))])
}

export class TxError extends Error {
  code: string | null
  signature: string | null
  constructor(message: string, code: string | null, signature: string | null) {
    super(message)
    this.code = code
    this.signature = signature
  }
}

/** Send to the Private ER: the wallet signs, the rollup is gasless. Returns the signature. */
export async function sendTee(connection: Connection, signer: Signer | Keypair, tx: Transaction): Promise<string> {
  tx.feePayer = signer.publicKey
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  const signed = signer instanceof Keypair ? (tx.sign(signer), tx) : await signer.signTransaction(tx)
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true })
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  if (res.value.err) {
    let code: string | null = null
    try {
      const t = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
      code = errorFromLogs(t?.meta?.logMessages)
    } catch {
      /* logs are only visible to permitted members */
    }
    throw new TxError(code ?? `transaction failed: ${JSON.stringify(res.value.err)}`, code, signature)
  }
  return signature
}

/** Send to Solana devnet through the wallet. */
export async function sendBase(
  connection: Connection,
  signer: Signer,
  tx: Transaction,
): Promise<string> {
  tx.feePayer = signer.publicKey
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  const signed = await signer.signTransaction(tx)
  const signature = await connection.sendRawTransaction(signed.serialize())
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  if (res.value.err) throw new TxError(`transaction failed: ${JSON.stringify(res.value.err)}`, null, signature)
  return signature
}

export { nacl }
