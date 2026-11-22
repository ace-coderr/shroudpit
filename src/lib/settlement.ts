import type { ConfirmedSignatureInfo } from '@solana/web3.js'
import { BASE_RPC } from './config'
import { FALLBACK_RPCS, rpcJson } from './rpc'

/**
 * Labels for the transactions that touch a league on devnet.
 *
 * What the chain actually shows: the program's own transactions log their instruction name
 * ("Instruction: JoinLeague"). Everything the Private ER commits back to devnet is sent by the
 * validator and logs only the delegation program, plus "Instruction: ProcessUndelegation" (a program
 * instruction) whenever accounts leave the rollup. So:
 *   - a commit with no undelegation is the end of a round (settle, scored or voided);
 *   - a commit that undelegates accounts is a reveal chunk, and the last one on a finished league
 *     is the finish step (league, secret and score cards).
 */
export interface TxLabel {
  signature: string
  label: string
  /** Extra detail such as "voided". */
  note?: string
  time: number | null
  failed: boolean
}

interface Logs {
  names: string[]
  undelegations: number
}

const cache = new Map<string, Logs>()

async function logsOf(signature: string): Promise<Logs | null> {
  const hit = cache.get(signature)
  if (hit) return hit
  try {
    const tx = await rpcJson<{ meta?: { logMessages?: string[] } }>(
      BASE_RPC,
      'getTransaction',
      // version-1 transactions (the validator's commits) are not understood by web3.js, so ask raw
      [signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }],
      FALLBACK_RPCS,
    )
    const lines = tx?.meta?.logMessages ?? []
    const names = lines.filter((l) => l.includes('Instruction:')).map((l) => l.split('Instruction:')[1].trim())
    const out = { names, undelegations: names.filter((n) => n === 'ProcessUndelegation').length }
    cache.set(signature, out)
    return out
  } catch {
    return null
  }
}

const PROGRAM_LABEL: Record<string, string> = {
  CreateLeague: 'Create league',
  JoinLeague: 'Join league',
  DelegateEntry: 'Join league',
  DelegateLeague: 'Close joining (league moved to the Private ER)',
  ClaimTrophy: 'Claim trophy',
}

/**
 * Label signatures (newest first, as the RPC returns them). `voidedRounds` are 1-based round numbers
 * known to have been voided, when the league has been revealed.
 */
export async function labelTransactions(
  sigs: ConfirmedSignatureInfo[],
  opts: { finished: boolean; voidedRounds: number[] },
): Promise<TxLabel[]> {
  const chronological = [...sigs].reverse()
  const parsed: { s: ConfirmedSignatureInfo; logs: Logs | null }[] = []
  for (const s of chronological) {
    const known = cache.has(s.signature)
    parsed.push({ s, logs: await logsOf(s.signature) })
    if (!known) await new Promise((r) => setTimeout(r, 120)) // be gentle with the public RPC
  }

  const commits = parsed.filter((p) => p.logs && !p.logs.names.some((n) => n in PROGRAM_LABEL))
  const lastUndelegating = [...commits].reverse().find((p) => (p.logs?.undelegations ?? 0) > 0)

  let settleN = 0
  let revealN = 0
  const out: TxLabel[] = parsed.map(({ s, logs }) => {
    const base = { signature: s.signature, time: s.blockTime ?? null, failed: !!s.err }
    if (!logs) return { ...base, label: 'Transaction' }
    const program = logs.names.find((n) => n in PROGRAM_LABEL)
    if (program) return { ...base, label: PROGRAM_LABEL[program] }
    if (logs.undelegations === 0) {
      settleN += 1
      return { ...base, label: `Settle round ${settleN}`, note: opts.voidedRounds.includes(settleN) ? 'voided' : undefined }
    }
    if (opts.finished && lastUndelegating && lastUndelegating.s.signature === s.signature) {
      return { ...base, label: 'Finish league', note: 'league, secret and score cards committed' }
    }
    revealN += 1
    return { ...base, label: `Reveal chunk ${revealN}` }
  })
  return out.reverse()
}
