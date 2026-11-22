import { useState } from 'react'
import { WalletReadyState } from '@solana/wallet-adapter-base'
import { useWallet } from '../lib/wallet'
import { short } from '../lib/hooks'

/** Connect control. When connected the truncated address is visible and copyable. */
export default function WalletButton() {
  const { wallets, select, connect, disconnect, publicKey, connecting, wallet } = useWallet()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  if (publicKey) {
    const addr = publicKey.toBase58()
    return (
      <div className="wallet">
        <button
          className="wallet__addr"
          title={`${addr}: click to copy`}
          onClick={() => {
            void navigator.clipboard.writeText(addr)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          <span className="wallet__dot" aria-hidden="true" />
          <span className="mono">{copied ? 'copied' : short(addr, 4, 4)}</span>
        </button>
        <button className="wallet__out" onClick={() => void disconnect()} aria-label="Disconnect wallet">
          Disconnect
        </button>
      </div>
    )
  }

  return (
    <div className="wallet">
      <button className="btn btn--ink" onClick={() => setOpen(true)} disabled={connecting}>
        {connecting ? 'Connecting…' : 'Connect wallet'}
      </button>
      {open && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Choose a wallet" onClick={() => setOpen(false)}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <h3>Choose a wallet</h3>
            <p className="muted small">Shroudpit runs on Solana devnet. Use a devnet account.</p>
            <ul className="modal__list">
              {wallets.map((w) => {
                const ready = w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable
                return (
                  <li key={w.adapter.name}>
                    <button
                      className="btn"
                      disabled={!ready}
                      onClick={async () => {
                        select(w.adapter.name)
                        setOpen(false)
                        try {
                          await w.adapter.connect()
                          await connect()
                        } catch {
                          /* user dismissed the wallet prompt */
                        }
                      }}
                    >
                      {w.adapter.name}
                      {!ready && <span className="muted small"> · not detected</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
            {wallet && <p className="muted small">Last used: {wallet.adapter.name}</p>}
            <button className="btn btn--ghost" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
