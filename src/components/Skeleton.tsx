export default function Skeleton({ count = 3, height = '9rem' }: { count?: number; height?: string }) {
  return (
    <ul className="cards" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="skeleton" style={{ minHeight: height }} />
      ))}
    </ul>
  )
}
