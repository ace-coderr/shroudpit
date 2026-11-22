import { useState } from 'react'
import { Link } from 'react-router-dom'
import { shortAddr } from '../lib/format'

interface Props {
  value: string
  /** Make the address a router link (internal) or an external link. */
  to?: string
  href?: string
  /** Hide the copy button where the address is itself the click target (the wallet button). */
  noCopy?: boolean
}

/** An address in mono, shortened the same way everywhere, with a copy button. */
export default function Addr({ value, to, href, noCopy }: Props) {
  const [done, setDone] = useState(false)
  const text = <span className="mono">{shortAddr(value)}</span>
  return (
    <span className="addr" title={value}>
      {to ? <Link to={to}>{text}</Link> : href ? <a href={href} target="_blank" rel="noreferrer">{text}</a> : text}
      {!noCopy && (
        <button
          type="button"
          className="addr__copy"
          aria-label={`Copy address ${shortAddr(value)}`}
          onClick={() => {
            void navigator.clipboard.writeText(value)
            setDone(true)
            setTimeout(() => setDone(false), 1200)
          }}
        >
          {done ? (
            <svg className="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 8.5l3.2 3.2L13 4.5" />
            </svg>
          ) : (
            <svg className="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
              <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
            </svg>
          )}
        </button>
      )}
    </span>
  )
}
