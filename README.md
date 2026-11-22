# Shroudpit

Private trading leagues on Solana. Players place paper positions against real, live prices. Positions stay hidden inside a Private Ephemeral Rollup until the round closes at a moment nobody can predict or choose. Then results are revealed and settled on-chain, producing a risk-adjusted skill rating and a track record anyone can verify.

**Problem.** Public leaderboards leak strategies (copying, front-running) and track records are unverifiable.

**Approach.** Hide positions while the round is live, make the close time unpredictable, and settle everything on-chain so every result can be audited.

Devnet only. No real funds are involved.

## How MagicBlock primitives are used

| Primitive | Role |
| --- | --- |
| Ephemeral Rollup | Fast, gasless position updates and settlement |
| Private Ephemeral Rollup (TEE) | Entries are readable only by their owner; the close time is readable by nobody until settlement |
| VRF | Optionally mixed into the close-time derivation when its output arrives in time |
| Real-time price oracle | Positions are marked to live oracle prices, read inside the rollup |

## Accounts

| Account | Visibility while the league runs | Holds |
| --- | --- | --- |
| `League` | Public inside the rollup, committed after every round | creator, rounds, phase, nonce deadline, player count, pinned price feed, winner |
| `Card` (one per player) | Public, committed after every round | rounds scored, running sums, last return, **rating**. Scores only: no position, no nonce |
| `Entry` (one per player) | Readable only by its owner; **not committed until the league ends** | current position, private nonce, and the closing position and nonce of every finished round |
| `Secret` | Readable by **nobody** (private, no members); **not committed until the league ends** | every round's close time, lock-in slot, base seed and VRF output |

The split between `League` and `Secret` exists so clients can follow the phase (who needs to seal a nonce, when positions are open) without ever being able to read a close time. The split between `Card` and `Entry` exists so scores can be public every round while positions stay sealed until the whole league is over.

## A round

1. **Join (devnet).** Players join an open league; each entry is delegated to the TEE validator in the same transaction. The program only accepts the TEE validator, so an entry can never be delegated to a public rollup by mistake.
2. **Seal.** The creator delegates the league and its secret and makes the secret unreadable. Each player makes their entry private to their own wallet. A position or nonce is refused unless the entry's permission account exists, belongs to that entry, and is marked private.
3. **Nonce phase.** The creator opens a round. Every player commits a random 32-byte nonce, privately. A nonce is immutable once committed.
4. **Lock-in.** Once everyone committed (or the deadline passed with at least two nonces), anyone locks the round in and the close time is derived.
5. **Live.** Players set and adjust positions at live oracle prices. `set_position` is refused once the hidden close has passed.
6. **Settle.** Anyone can call `settle_and_reveal`, from any open desk. Positions are marked to the settlement price, ratings update on the public cards, and the rollup commits only the league and the cards. Entries and the secret stay sealed.
7. **Final reveal.** After the last round the league is **Finishing**: any caller commits and undelegates the entries in chunks of four (`reveal_entries`), then `finish_league` commits the league, the secret and the cards and the league is **Finished**. Only now do positions, nonces and close times become public.

## How the close time is derived

The close time must be random, hidden and impossible for anyone to steer.

```
base seed = sha256(league, epoch, slot at lock-in, every committed (wallet, nonce), in key order)
```

- **Default (`Nonces + slot`).** `close = start + min + (seed mod (max - min + 1))`.
- **With VRF (`Nonces + slot + VRF`).** The program requests randomness and, if the output arrives within 20 seconds, uses `seed = sha256(base seed, vrf output)`. If it does not arrive in time, `finalize_without_vrf` derives the close from the base seed alone. A VRF callback that arrives after the close was derived is rejected, so an output cannot be replayed or injected.

Nonces must be committed **before** lock-in: `commit_nonce` is refused once the phase closes, a nonce cannot be changed once committed, and each round needs fresh nonces (an epoch counter makes old nonces unusable). Nonces and each round's base seed are revealed when the league finishes, so anyone can recompute every round's close time **after the final round**; the Audit page does exactly that in the browser.

### Limits of the nonce-based derivation

- **Multi-wallet limit.** The close time is unpredictable only if at least one contributing wallet's nonce is unknown to the adversary. A single person who controls **every** wallet that commits a nonce (or every one but a colluding few) knows all the inputs and can compute the close time in advance. Splitting yourself across wallets therefore gives no advantage over honest players *only if* an honest, independent player also contributes. Leagues should have at least three independent players; the program enforces two nonces as an absolute minimum, which is **not** a guarantee of fairness against two colluding wallets.
- **Slot choice.** The caller of lock-in chooses roughly when it happens, so they influence the slot. This does not help them because they cannot evaluate the seed without every nonce.
- **VRF mixing narrows, but does not remove, the multi-wallet limit.** A VRF output is unknown at nonce-commit time, so colluding wallets cannot grind their nonces against it; once it arrives it is public, so after that point the close time is computable by anyone who also holds all nonces.
- **Last-mover.** A player cannot see anyone else's nonce, so the last to commit has no advantage; but a player who withholds their nonce can only change *whether* they contribute (the round proceeds with the rest, minimum two).

## What leaks, and what does not

| Channel | Result |
| --- | --- |
| RPC read of another player's `Entry` | Refused by the Private ER (verified on devnet with a non-member token) |
| RPC read of the `Secret` | Refused for everyone, including the creator (verified on devnet) |
| RPC read of the `League` | Allowed, by design: phase, round, deadlines, player count. It holds nothing that reveals the close time |
| Base-layer copy of a delegated account | Stale zeroed state from before delegation, never a live position |
| A position transaction fetched by a non-member | Returns an empty shell: zero account keys, no instruction data (so no side or leverage), zero log lines, no balances. Verified on devnet with a brand-new key. The owner's own fetch of that transaction was redacted the same way, so the owner reads their position from their `Entry`, not from history |
| Join and delegate transactions | **Public on devnet**: who joined which league is visible. Positions are not |
| Settlement commit after a non-final round | Publishes the public score cards and the league only. A verified devnet 3-round league showed every entry still holding no position on the base layer after rounds 1 and 2 |
| Final reveal | Publishes every round's positions, nonces and close times, after the league is over, so nothing can be copied while it is running |

### Rank-only standings

The Standings page shows ranks computed from the **committed** base-layer entries. Those change only when a round settles, never tick by tick, so the order cannot be used to infer who is long or short during a live round. Concretely:

- During a live round the order is frozen at the last settled round. Nothing about it moves with price.
- At a round boundary the new order reveals the *aggregate* effect of that round, which the Reveal page publishes anyway.
- Ratings and per-round returns are not shown on the standings page at all, only the order and how many rounds each player has been scored for.
- Before the first round settles no order exists, so ranks are shown as sealed bars.

Not verified: whether the *timing* and *count* of a player's transactions inside the rollup are visible to a non-member. The permission flags are set to restrict logs, messages and balances; a timing or fee-payer side channel has not been tested.

## Settlement needs no operator

`settle_and_reveal` is permissionless and safe to call at any time:

- before the hidden close, or when the round is not live: it does nothing;
- inside the **60-second settlement window** after the close: it settles at a price published inside that window;
- after the window: the round is **voided** (nobody is scored) and the league moves on. This path never reads the price feed, so a late trigger, a missing trigger or a broken feed can never strand a league.

The league account pays for the commit and signs for itself, so there is no keeper key and no funds are needed to trigger it. Verified on devnet: lock-in (including the VRF request) and settlement were sent by a brand-new key that holds no SOL anywhere, and a league that sat live far past its close was voided by such a key.

Each open desk polls `lock_in`, `finalize_without_vrf` and `settle_and_reveal` every few seconds with a throwaway key, so the first open desk to notice settles the round within about three seconds, and there is also an "Advance the round now" button. A later caller finds the round already settled and does nothing.

**Why there is no crank.** MagicBlock documents cranks (scheduled instructions that run inside the rollup). A `schedule_settle` instruction was built and tested on the Private ER: scheduling succeeded, but the scheduled call never executed. It was tried scheduled at the start of a round and scheduled after the close (when the call would have settled immediately), and nothing settled within 150 seconds either way. The failure is silent, so the cause is unknown. The instruction was removed rather than left as something that appears to work.

Trade-off: a settler can pick the exact moment inside the 60-second window, so the settlement price can be nudged by at most that much price movement. In practice the first open desk settles within seconds and later calls are no-ops, so the bound is the polling interval as long as one honest desk is open. **Limit: settlement needs an open client within the window.** There is no server and the scheduled-task route did not work, so if no desk (any player's) is open during the 60 seconds after the hidden close, the round is voided and nobody is scored. It costs nobody anything but the round. The window is a constant in `state.rs`.
## Trophy

When a league has finished, the winner can claim an owned devnet asset with `claim_trophy`: a 0-decimal SPL token, supply 1, minted to the winner's wallet. The mint is a PDA of the league, so a second claim fails, and its mint authority is removed right after minting so the supply can never grow. Only the recorded winner can claim. Verified on devnet: supply 1, no mint or freeze authority, the winner holds it, and a second claim is rejected. The winner pays the rent for the mint and their token account, 0.00256 SOL on devnet (measured). There is no metadata account: the asset is the token itself, and the Skill Record page lists the trophies a wallet actually holds.

## Reveal policy

Positions, nonces and close times of **every** round are published only after the final round. Scores are public after every round. A later round therefore cannot copy an earlier one, because nothing about earlier positions is public while the league runs.

Costs, measured on devnet: one extra account per player (the public card, about 0.0016 SOL of rent) and a larger entry (about 540 bytes, because it stores every round's closing position and nonce). The program grew by about 50 KB.

**The commit-size limit and the chunked reveal.** The validator rejects a commit bundle whose account data totals more than roughly 2.7 KB (measured by simulation on a real 8-player league: the 8 entries alone, about 4.3 KB, were refused; 8 score cards plus the league and the secret, 10 accounts, were accepted; so it is size, not account count). One commit of everything is therefore impossible for large leagues, and the final reveal is split: entries in chunks of four, then the league, secret and cards. Eight players need two chunks and one finish call.

**Side effects.** The close-time recomputation can only be done after the final round. A league that is abandoned before its final round never reveals, and its entries stay delegated. Settlement can still void a round but never skips the final reveal.

## Prices

Positions are marked to the MagicBlock real-time oracle (Pyth Lazer data, updated roughly every second inside the rollup). The program reads the feed account directly and checks that it is the pinned feed address, owned by the oracle program, has a positive price, and is fresh: at most 5 seconds old when a position is set, and published inside the settlement window when settling. The base-layer copy of the feed is not used; it is stale.

## Rating

Per round, a player's return `r` (basis points) is the sum over their position changes of `side * leverage * (price_now - entry_price) / entry_price * 10000`, floored at -10,000 and capped at 1,000,000. Over `n` scored rounds:

```
mean   = sum(r) / n
std    = sqrt( sum(r^2) / n - mean^2 )          (population standard deviation)
rating = 1000 * mean / max(std, 100)
```

All arithmetic is integer. The floor of 100 bps on `std` stops a single scored round (where `std` is zero) from producing an unbounded rating. The league winner is the highest rating after the last round; ties go to the lowest entry key. A voided round scores nobody.

This is the rating as implemented today. It rewards return per unit of volatility across rounds rather than raw profit.

## Repository layout

```
src/        React + TypeScript front end (Vite)
program/    Anchor program (Rust)
scripts/    devnet end-to-end scripts and read-only probes
docs/       audit checklist
.github/    GitHub Pages deployment workflow
```

## Local development

Front end (Node.js 24):

```
npm install
npm run dev
npm run build
```

Program (Rust 1.89, Solana CLI, Anchor 1.0.x), from `program/`:

```
anchor build
```

The end-to-end scripts take `KEYPAIR_DIR` (a directory of devnet keypairs kept outside the repository) and run against the deployed program.

### Running the demo league

`scripts/demo/seed-demo.mjs` leaves one league open so a second wallet can join live. Closing joining and opening round 1 are creator-only actions, so they are scripted:

1. In the browser, a second wallet joins from the Lobby, unlocks its desk and seals its entry.
2. Run `scripts/demo/run-round1.mjs` as the creator wallet. It closes joining (delegates the league to the Private ER), hides the close time, seals the creator's own entry, counts down 10 s, opens the round, commits the creator's nonce and then shows the 45 s nonce window.
3. The second wallet presses "Seal my nonce" on the Desk inside that window. Once every player has committed, lock-in is sent by the Desk helper or, if the Desk has not done it within 5 s, by the script. The script prints `LIVE` when positions can be placed.

The script reads the chain before every step, so it can be re-run after a failure and only does what is still missing. If the nonce window ends with fewer than two nonces it opens a new window. It needs only devnet SOL for the creator's fees.

```
KEYPAIR_DIR=$HOME/.config/solana node scripts/demo/run-round1.mjs
```

## Deployment

The site is a static build served from GitHub Pages. Every push to `main` runs `.github/workflows/deploy.yml`, which installs, lints, builds and publishes `dist/`. There is no backend: leagues and entries are discovered with `getProgramAccounts` filters (delegated accounts keep their data on the base layer under the delegation program), and live state is read straight from the rollup.

## Status

Front end: Lobby, Creator Console, Sealed Desk (with fuzzy Round Clock), Rank-only Standings, Reveal & Audit and Skill Record are implemented and read real devnet data. The winner claims a trophy token from the Skill Record page.

On-chain flow verified on devnet: league creation, joining, delegation to the Private ER, private entries, VRF mixed into the close time inside the Private ER, settlement and the chunked final reveal for leagues of 3 and 8 wallets, multi-round leagues (3 rounds), the privacy reads above, the trophy claim, and a never-funded key triggering lock-in and settlement. See `docs/audit-checklist.md` for the open and verified checks.
