import Redacted from '../components/Redacted'

const steps = [
  {
    n: 'I',
    title: 'Seal',
    body: 'Place paper positions against live prices. They are written into a private rollup that only you can read.',
  },
  {
    n: 'II',
    title: 'Wait',
    body: 'The round closes at a randomised moment. No one, including the league creator, can predict it.',
  },
  {
    n: 'III',
    title: 'Reveal',
    body: 'At close every position is revealed, scored and settled on-chain with a link you can audit.',
  },
]

export default function Home() {
  return (
    <>
      <section className="hero">
        <p className="eyebrow">Private trading leagues · Solana</p>
        <h1 className="hero__title">
          Trade in the dark.
          <br />
          Be judged in the open.
        </h1>
        <p className="hero__lede">
          Public leaderboards leak strategies and track records cannot be verified. In Shroudpit
          your positions stay <Redacted delay={300}>hidden</Redacted> until the round ends, then a
          verifiable skill rating is written on-chain.
        </p>
      </section>

      <section className="section">
        <h2 className="section__title">How a round works</h2>
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s.n} className="step" style={{ ['--i' as string]: i }}>
              <span className="step__n">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="section section--ruled">
        <h2 className="section__title">Why the rating means something</h2>
        <p className="prose">
          Raw profit rewards luck. Shroudpit scores risk-adjusted performance across several rounds,
          so a single lucky call cannot top the table. The winner receives a trophy asset they own.
        </p>
      </section>
    </>
  )
}
