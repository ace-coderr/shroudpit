import idl from './idl.json'
import { TxError } from './session'

export interface Explained {
  /** Plain-language message for the red box. */
  text: string
  /** True only when trying the same action again can succeed. */
  retry: boolean
}

interface Known {
  text: string
  retry?: boolean
}

/** Program errors by name. Anything not listed falls back to the message in the program's IDL. */
const PROGRAM: Record<string, Known> = {
  RoundClosed: {
    text: 'This round has already closed. The close moment stays hidden until it passes, so positions cannot be placed after it.',
  },
  RoundOpen: {
    text: 'The round has not closed yet. Settlement only works after the hidden close. Wait a moment and try again.',
    retry: true,
  },
  OutsideSettleWindow: {
    text: 'The latest oracle price was not inside the settlement window. Try again in a moment.',
    retry: true,
  },
  BadEntries: {
    text: 'The list of players sent with this step did not match the league, usually because devnet returned a partial list. Try again; if it keeps failing, reload the page.',
    retry: true,
  },
  WrongStatus: { text: 'The league is not in a phase that allows this right now. It has probably moved on; this page refreshes by itself.' },
  NoncePhaseClosed: { text: 'The nonce window is over for this round.' },
  NoncePhaseOpen: { text: 'The nonce window is still open. Lock-in happens once every player has sealed a nonce or the window ends.', retry: true },
  NonceAlreadyCommitted: { text: 'Your nonce for this round is already sealed.' },
  NotEnoughNonces: { text: 'Fewer than two players sealed a nonce, so the round cannot lock in. The creator has to open a new nonce window.' },
  ZeroNonce: { text: 'The nonce was empty. Seal a fresh one.', retry: true },
  PermissionMissing: { text: 'Your entry is not sealed yet. Seal it first.' },
  StalePrice: { text: 'The oracle price was stale. Try again in a moment.', retry: true },
  InvalidPrice: { text: 'The oracle price was not valid. Try again in a moment.', retry: true },
  InvalidPosition: { text: 'That position is not allowed. Pick long, short or flat, with leverage from 1 to 5.' },
  VrfWaitNotExpired: { text: 'The randomness request is still waiting for its answer. Try again shortly.', retry: true },
  NotAllRevealed: { text: 'Not every entry has been revealed yet. Reveal them first, then finish.', retry: true },
  EntryRevealed: { text: 'This entry was already revealed.' },
  ChunkTooLarge: { text: 'Too many entries were sent in one reveal step.' },
  NotCreator: { text: 'Only the league creator can do this.' },
  LeagueFull: { text: 'This league is full.' },
  NotWinner: { text: 'Only the league winner can claim the trophy.' },
  WrongFeed: { text: 'The price feed does not match the one this league is pinned to.' },
  WrongValidator: { text: 'This league can only run on the attested Private ER validator.' },
  WrongSecret: { text: 'The secret account does not belong to this league.' },
  InvalidParams: { text: 'Those league settings are not valid.' },
  Overflow: { text: 'A number went out of range. Please report this.' },
}

const byCode = new Map<number, string>()
const idlMsg = new Map<string, string>()
for (const e of (idl as { errors?: { code: number; name: string; msg?: string }[] }).errors ?? []) {
  byCode.set(e.code, e.name)
  if (e.msg) idlMsg.set(e.name, e.msg)
}

function programErrorName(e: unknown): string | null {
  if (e instanceof TxError && e.code) return e.code
  const message = e instanceof Error ? e.message : String(e)
  const logged = message.match(/Error Code: (\w+)/)
  if (logged) return logged[1]
  // The rollup hides logs from non-members, so the only trace is the numeric code:
  // "InstructionError [0, Custom 6013]" or {"InstructionError":[0,{"Custom":6013}]}
  const custom = message.match(/Custom\D{0,6}(\d{4,5})/)
  return custom ? (byCode.get(Number(custom[1])) ?? null) : null
}

/** Turn anything a Desk action can throw into a plain sentence and a retry decision. */
export function explain(e: unknown): Explained {
  const name = programErrorName(e)
  if (name) {
    const known = PROGRAM[name]
    if (known) return { text: known.text, retry: !!known.retry }
    return { text: `The program rejected this step: ${idlMsg.get(name) ?? name}.`, retry: false }
  }
  const message = e instanceof Error ? e.message : String(e)
  if (/reject|declin|denied|cancel/i.test(message)) {
    return { text: 'The signature was cancelled in your wallet. Nothing was sent.', retry: true }
  }
  if (/fetch|network|timeout|timed out|429|50[0-9]|blockhash|ECONN|ENOTFOUND|socket|expired/i.test(message)) {
    return { text: 'Could not reach Solana devnet or the Private ER just now. Nothing was applied. Try again.', retry: true }
  }
  return { text: `Something went wrong: ${message.slice(0, 160)}`, retry: false }
}
