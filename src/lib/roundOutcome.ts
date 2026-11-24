export type RoundOutcome = 'scored' | 'voided' | 'pending'

/**
 * What the Desk result card says about each settled round of one player.
 *
 * "Voided" is only ever shown when it can be trusted: the entry's revealed history must be final (it
 * is on devnet and owned by the program again) AND agree with the committed score card on how many
 * rounds were scored. Anything else is "pending" (still being read), never "voided". The score card is
 * committed at every settlement, so it is the reference: a round that has a committed score cannot be
 * shown as voided.
 */
export function roundOutcomes(input: {
  settled: number
  cardRoundsScored: number
  history: { scored: boolean }[] | null | undefined
  entriesFinal: boolean
}): RoundOutcome[] {
  const { settled, cardRoundsScored, history, entriesFinal } = input
  const pending: RoundOutcome[] = Array.from({ length: settled }, () => 'pending')
  if (!entriesFinal || !history) return pending
  const raw = Array.from({ length: settled }, (_, r) => (history[r]?.scored ? 'scored' : 'voided')) as RoundOutcome[]
  const scored = raw.filter((o) => o === 'scored').length
  if (scored !== cardRoundsScored) return pending // history and score card disagree: do not guess
  return raw
}
