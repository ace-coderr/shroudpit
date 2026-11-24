// Guard: a round that has a committed score card must never be rendered as "voided" in the Desk result card.
// Runs with the other checks (npm test).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { roundOutcomes } from '../src/lib/roundOutcome.ts'

const histories = (n) => Array.from({ length: 2 ** n }, (_, bits) => Array.from({ length: n }, (_, r) => ({ scored: !!((bits >> r) & 1) })))

test('the case that was wrong: entries not final yet, card says every round was scored', () => {
  // every entry still looks empty (all "not scored") right after the league finishes
  const out = roundOutcomes({ settled: 2, cardRoundsScored: 2, history: [{ scored: false }, { scored: false }], entriesFinal: false })
  assert.deepEqual(out, ['pending', 'pending'])
})

test('a final, consistent history is shown as it is', () => {
  assert.deepEqual(roundOutcomes({ settled: 2, cardRoundsScored: 2, history: [{ scored: true }, { scored: true }], entriesFinal: true }), ['scored', 'scored'])
  assert.deepEqual(roundOutcomes({ settled: 2, cardRoundsScored: 1, history: [{ scored: false }, { scored: true }], entriesFinal: true }), ['voided', 'scored'])
  assert.deepEqual(roundOutcomes({ settled: 2, cardRoundsScored: 0, history: [{ scored: false }, { scored: false }], entriesFinal: true }), ['voided', 'voided'])
})

test('never voided when the score card counts every settled round (exhaustive over every history)', () => {
  for (let settled = 1; settled <= 4; settled++) {
    for (const history of histories(settled)) {
      for (const entriesFinal of [true, false]) {
        const out = roundOutcomes({ settled, cardRoundsScored: settled, history, entriesFinal })
        assert.ok(!out.includes('voided'), `settled ${settled}, final ${entriesFinal}, history ${JSON.stringify(history)} -> ${out}`)
      }
    }
  }
})

test('never more voided rounds than the score card allows, and never voided while entries are not final', () => {
  for (let settled = 1; settled <= 4; settled++) {
    for (let cardScored = 0; cardScored <= settled; cardScored++) {
      for (const history of histories(settled)) {
        for (const entriesFinal of [true, false]) {
          const out = roundOutcomes({ settled, cardRoundsScored: cardScored, history, entriesFinal })
          const voided = out.filter((o) => o === 'voided').length
          assert.ok(voided <= settled - cardScored, 'more voided rounds than the score card allows')
          if (!entriesFinal) assert.equal(voided, 0)
          if (voided > 0) assert.equal(out.filter((o) => o === 'scored').length, cardScored)
        }
      }
    }
  }
})

test('missing history is pending, not voided', () => {
  assert.deepEqual(roundOutcomes({ settled: 2, cardRoundsScored: 2, history: undefined, entriesFinal: true }), ['pending', 'pending'])
  assert.deepEqual(roundOutcomes({ settled: 2, cardRoundsScored: 2, history: null, entriesFinal: true }), ['pending', 'pending'])
})

test('the Desk result card decides "voided" only through roundOutcomes', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/components/ResultCard.tsx', import.meta.url), 'utf8')
  assert.ok(src.includes('roundOutcomes('), 'ResultCard must use roundOutcomes')
  assert.ok(!/\.scored\s*\?/.test(src), 'ResultCard must not decide voided from a raw scored flag')
})
