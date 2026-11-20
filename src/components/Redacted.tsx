import { useEffect, useRef, useState, type ReactNode } from 'react'

type Props = {
  children: ReactNode
  /** Controlled reveal. When omitted the bar lifts when scrolled into view. */
  revealed?: boolean
  /** Delay before the bar slides away, in ms. */
  delay?: number
}

/**
 * The signature element: every hidden figure sits under an ink bar.
 * The bar slides away once the value is legitimately revealed.
 */
export default function Redacted({ children, revealed, delay = 0 }: Props) {
  const ref = useRef<HTMLSpanElement>(null)
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    if (revealed !== undefined) return
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setSeen(true)
          io.disconnect()
        }
      },
      { threshold: 1 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [revealed])

  const open = revealed ?? seen
  return (
    <span
      ref={ref}
      className={`redacted${open ? ' is-open' : ''}`}
      style={{ ['--delay' as string]: `${delay}ms` }}
    >
      <span className="redacted__text">{children}</span>
      <span className="redacted__bar" aria-hidden="true" />
    </span>
  )
}
