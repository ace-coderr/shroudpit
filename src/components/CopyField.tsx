import { useState } from 'react'

/** A hash or address in mono with a copy button. */
export default function CopyField({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <div>
      {label && <div className="caption">{label}</div>}
      <div className="copyfield">
        <code>{value}</code>
        <button
          type="button"
          aria-label={`Copy ${label ?? 'value'}`}
          onClick={() => {
            void navigator.clipboard.writeText(value)
            setDone(true)
            setTimeout(() => setDone(false), 1200)
          }}
        >
          {done ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
