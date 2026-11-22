# UI states

Every route and the states it can be in. Used as the checklist for the final click-through. "Wallet" means a connected browser wallet; reads that need no wallet work without one.

## Global

| State | Where | Behaviour |
| --- | --- | --- |
| Wallet disconnected | navbar | "Connect wallet" button opens a chooser (Phantom, Solflare); not-installed wallets are disabled and say so |
| Wallet connected | navbar | truncated address, copy on click, disconnect |
| Network read error | any page | plain-language notice with the RPC error, page keeps its last data |
| Unknown route / bad address | all league routes | "That league address is not valid" |

## `/` Overview (Home)
- Static explainer. States: none beyond global.

## `/lobby`
- **Loading**: reading the chain (skeleton cards).
- **Empty**: no leagues exist yet.
- **Error**: could not read leagues.
- **Loaded**: cards per league with phase (Open, Awaiting randomness, Live, Between rounds, Finished, Sealing nonces, Revealing).
- **Wallet disconnected**: Join shows "Connect a wallet to join".
- **Wallet connected, not joined, open, not full**: Join button.
- **Join signature pending**: button reads Joining.
- **Join done / error**: notice above the list.
- **Full**: Join disabled, reads Full.
- **Joined**: "Open my desk".
- **Not open and not joined**: Standings link.

## `/create`
- **Wallet disconnected**: notice, form disabled.
- **Idle / submitting (signature pending) / created / error**.
- **Your leagues**: empty, or one console card per league. Console card states by phase:
  Open and not delegated (needs 2 players / ready), delegated and secret unsealed ("Hide the close time"), sealed and Open or Between ("Open round n"), per-action busy and message.

## `/desk/:league`
- **Invalid address / read error / loading** (reading the ledger).
- **Wallet disconnected**: notice.
- **Not joined**: notice with lobby link.
- **Step 1 Connect** done when a wallet is connected.
- **Step 2 Unlock Private ER**: not unlocked (button), signing (pending), unlocked (attested or "could not be checked"), error.
- **Step 3 Place position**: entry unsealed ("Seal my entry"), sealing, sealed, nonce phase (Seal nonce / waiting for other players n of m), live (side, leverage, place; sealing pending), round closed rejection, stale price rejection.
- **Round phases** shown in the clock: Not started, Sealing nonces, Drawing randomness, Live (before earliest close / any moment now), Round settled, Revealing, Finished.
- **Own position**: covered (shroud) or shown on request.
- **Settlement helper**: on or off, helper error note, "Advance the round now" with busy and message.
- **Settling**: helper acting; **voided**: round settled with no scores (surfaces on the Audit page as Voided); **finished**: links to audit and standings.
- **Price**: loading, value with age.

## `/standings/:league`
- **Invalid address**, **loading**, **error**.
- **No round settled yet**: ranks hidden (sealed bars).
- **Ranked**: order frozen at the last settled round; own row highlighted; winner badge when Finished.
- **Rank change at a round boundary**: rows slide.

## `/audit/:league`
- **Scores so far**: empty (no round settled) or table.
- **Positions and close times**: sealed until the final round; **revealing** (chunk n of N while Finishing); **revealed** per round with verification result.
- **Verification**: Confirmed, Not verified (mismatch or not yet computable).
- **Voided round**: shown as Voided.
- **Chunked reveal**: idle, in progress (chunk n of N), error with retry, complete.
- **Settlement transactions**: empty or list of explorer links.

## `/record`
- **Wallet disconnected**: notice.
- **Loading / error / no leagues**.
- **Record**: leagues played, rounds scored, leagues won, per-league rows.
- **Trophies**: none, held (token link), won and unclaimed (claim button, signature pending, claimed message, error).
