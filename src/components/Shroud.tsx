/**
 * A position under a cloth. Covered it shows only the breathing cloth; on reveal the five strips
 * lift one after another and the position underneath (long or short, size) appears.
 */
export default function Shroud({
  revealed,
  side,
  leverage,
  caption,
  bare = false,
}: {
  revealed: boolean
  /** -1 short, 0 flat, 1 long. Only used once revealed. */
  side?: number
  leverage?: number
  caption?: string
  /** Dim the shape (no real position behind the cloth, e.g. the intro frame). */
  bare?: boolean
}) {
  const kind = side === 1 ? 'long' : side === -1 ? 'short' : 'flat'
  const title = side === 0 ? 'Flat' : side === 1 ? `Long ×${leverage}` : `Short ×${leverage}`
  return (
    <div className={`shroud shroud--${kind}${revealed ? ' shroud--revealed' : ''}${bare ? ' shroud--bare' : ''}`} role="img" aria-label={revealed ? title : 'Position, sealed'}>
      <div className="shroud__shape">
        <svg className="icon" width="51" height="51" viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">
          {side === 0 ? <rect x="6" y="21" width="36" height="6" rx="2" /> : <path d="M24 5l17 22H29v16H19V27H7z" />}
        </svg>
        <strong>{revealed ? title : 'Position'}</strong>
        {caption && <span className="caption">{caption}</span>}
      </div>
      <div className="shroud__cloth" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <i key={i} style={{ ['--i' as string]: i }} />
        ))}
      </div>
    </div>
  )
}
