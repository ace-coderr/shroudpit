export type StatusKind = 'sealed' | 'revealed' | 'voided' | 'unverified'

const LABEL: Record<StatusKind, string> = {
  sealed: 'Sealed',
  revealed: 'Revealed · confirmed on-chain',
  voided: 'Voided',
  unverified: 'Not verified',
}

const Check = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8.5l3.2 3.2L13 4.5" />
  </svg>
)

/**
 * The one badge for the state of a position, round or score card. Four looks, never mixed:
 * Sealed = solid black, Revealed = outlined with a check, Voided = hatched, Not verified = dashed hatched.
 */
export default function StatusBadge({ kind, label }: { kind: StatusKind; label?: string }) {
  return (
    <span className={`status status--${kind}`}>
      {kind === 'revealed' && <Check />}
      {label ?? LABEL[kind]}
    </span>
  )
}
