import { PublicKey } from '@solana/web3.js'
import idl from './idl.json'

export const PROGRAM_ID = new PublicKey(idl.address)
export const BASE_RPC = 'https://api.devnet.solana.com'
export const TEE_RPC = 'https://devnet-tee.magicblock.app'
/** The only validator entries and leagues may be delegated to: the attested enclave. */
export const TEE_VALIDATOR = new PublicKey('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo')
export const ER_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc')
export const EXPLORER = 'https://explorer.solana.com'

/** Assets the oracle serves; ids are Pyth Lazer ids. The price feed is a PDA of the oracle. */
export const ASSETS = [
  { id: 6, symbol: 'SOL/USD' },
  { id: 1, symbol: 'BTC/USD' },
  { id: 2, symbol: 'ETH/USD' },
] as const

export const STATUS_LABEL: Record<number, string> = {
  0: 'Open',
  1: 'Awaiting randomness',
  2: 'Live',
  3: 'Between rounds',
  4: 'Finished',
  5: 'Sealing nonces',
  6: 'Revealing',
}

export const CLOSE_MODE_LABEL: Record<number, string> = {
  0: 'Nonces + slot',
  1: 'Nonces + slot + VRF',
}

export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}?cluster=devnet`
export const explorerTx = (s: string) => `${EXPLORER}/tx/${s}?cluster=devnet`
export const explorerTeeTx = (s: string) =>
  `${EXPLORER}/tx/${s}?cluster=custom&customUrl=${encodeURIComponent(TEE_RPC)}`
