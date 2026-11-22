/**
 * What a page shows when a read failed. It never shows an empty state in place of data and never a
 * raw RPC reply: just plain words, an automatic retry note for "busy", and a manual Retry button.
 * With \`stale\`, the page still has earlier data on screen and this is only a small note.
 */
export default function LoadFailed({
  error,
  busy,
  onRetry,
  stale = false,
}: {
  error: string
  busy: boolean
  onRetry: () => void
  stale?: boolean
}) {
  return (
    <div className={`notice ${busy ? 'notice--warn' : 'notice--bad'}${stale ? ' small' : ''}`} role="status" aria-live="polite">
      <p>
        {error}
        {busy ? ' This page keeps trying by itself.' : ''}
        {stale ? ' Showing the last data it loaded.' : ''}
      </p>
      <button type="button" className="btn btn--small" style={{ marginTop: '0.5rem' }} onClick={onRetry}>
        Retry now
      </button>
    </div>
  )
}
