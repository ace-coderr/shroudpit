import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react'
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom'
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { BASE_RPC } from './config'
import type { Signer } from './session'

export function WalletProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], [])
  return (
    <ConnectionProvider endpoint={BASE_RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  )
}

/** The connected wallet as a Signer, or null when disconnected or unable to sign messages. */
export function useSigner(): Signer | null {
  const { publicKey, signTransaction, signMessage } = useWallet()
  return useMemo(
    () =>
      publicKey && signTransaction && signMessage ? { publicKey, signTransaction, signMessage } : null,
    [publicKey, signTransaction, signMessage],
  )
}

export { useWallet }
