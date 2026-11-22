/** Plays once when it mounts: used when a round settles, a league finishes or a round is voided. */
export default function SealStamp({ label = 'Settled', voided = false }: { label?: string; voided?: boolean }) {
  return <span className={`stamp${voided ? ' stamp--voided' : ''}`}>{label}</span>
}
