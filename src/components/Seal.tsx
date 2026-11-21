/** A bare redaction bar: stands where a hidden figure would be, without containing any figure. */
export default function Seal({ width = '5ch' }: { width?: string }) {
  return <span className="seal" style={{ width }} role="img" aria-label="sealed" />
}
