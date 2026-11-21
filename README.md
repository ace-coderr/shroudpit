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
| Cranks | A scheduled instruction can trigger settlement with no off-chain bot |

## Accounts

| Account | Visibility while a round is live | Holds |
| --- | --- | --- |
| `League` | Public inside the rollup | creator, rounds, phase, nonce deadline, player count, pinned price feed |
| `Secret` | Readable by **nobody** (private, no members) | hidden close time, lock-in slot, base seed, VRF output |
| `Entry` (one per player) | Readable only by its owner | position, private nonce, running rating |

When a round settles, the rollup commits `League`, `Secret` and every `Entry` to Solana. Only then does their content become public, which is what the Reveal & Audit page shows.

The split between `League` and `Secret` exists so clients can follow the phase (who needs to seal a nonce, when positions are open) without ever being able to read the close time.

## A round

1. **Join (devnet).** Players join an open league; each entry is delegated to the TEE validator in the same transaction. The program only accepts the TEE validator, so an entry can never be delegated to a public rollup by mistake.
2. **Seal.** The creator delegates the league and its secret and makes the secret unreadable. Each player makes their entry private to their own wallet. A position or nonce is refused unless the entry's permission account exists, belongs to that entry, and is marked private.
3. **Nonce phase.** The creator opens a round. Every player commits a random 32-byte nonce, privately. A nonce is immutable once committed.
4. **Lock-in.** Once everyone committed (or the deadline passed with at least two nonces), anyone locks the round in and the close time is derived.
5. **Live.** Players set and adjust positions at live oracle prices. `set_position` is refused once the hidden close has passed.
6. **Settle and reveal.** Anyone can call `settle_and_reveal` (a crank can too). Positions are marked to the settlement price, ratings update, and the rollup commits. The last round also undelegates everything.

## How the close time is derived

The close time must be random, hidden and impossible for anyone to steer.

```
base seed = sha256(league, epoch, slot at lock-in, every committed (wallet, nonce), in key order)
```

- **Default (`Nonces + slot`).** `close = start + min + (seed mod (max - min + 1))`.
- **With VRF (`Nonces + slot + VRF`).** The program requests randomness and, if the output arrives within 20 seconds, uses `seed = sha256(base seed, vrf output)`. If it does not arrive in time, `finalize_without_vrf` derives the close from the base seed alone. A VRF callback that arrives after the close was derived is rejected, so an output cannot be replayed or injected.

Nonces must be committed **before** lock-in: `commit_nonce` is refused once the phase closes, a nonce cannot be changed once committed, and each round needs fresh nonces (an epoch counter makes old nonces unusable). Nonces and the base seed are revealed at settlement, so anyone can recompute the close time; the Audit page does exactly that in the browser.

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
| Transaction logs for position and nonce transactions | Visible only to the entry's owner (permission flags restrict logs, messages and balances to the member) |
| Join and delegate transactions | **Public on devnet**: who joined which league is visible. Positions are not |
| Settlement commit | Reveals each player's closing position and nonce **for that round**, after it closed. This enables audit but also lets later rounds copy an earlier pattern. Keeping positions sealed until the final round is a possible future option |

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
- inside the **30-second settlement window** after the close: it settles at a price published inside that window;
- after the window: the round is **voided** (nobody is scored) and the league moves on. This path never reads the price feed, so a late trigger, a missing trigger or a broken feed can never strand a league.

The league account pays for the commit and signs for itself, so there is no keeper key. The front end polls settlement from any open desk with a throwaway key, and the creator can schedule a crank (`schedule_settle`) that calls the same instruction every two seconds inside the rollup.

Trade-off: a settler can choose the exact moment inside the 30-second window, so the settlement price can be nudged by at most 30 seconds of price movement. The window is a constant in `state.rs`.

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

## Deployment

The site is a static build served from GitHub Pages. Every push to `main` runs `.github/workflows/deploy.yml`, which installs, lints, builds and publishes `dist/`. There is no backend: leagues and entries are discovered with `getProgramAccounts` filters (delegated accounts keep their data on the base layer under the delegation program), and live state is read straight from the rollup.

## Status

Front end: Lobby, Creator Console, Sealed Desk (with fuzzy Round Clock), Rank-only Standings, Reveal & Audit and Skill Record are implemented and read real devnet data. Trophies are not implemented yet.

On-chain flow verified on devnet: league creation, joining, delegation to the Private ER, private entry permissions, the privacy reads in the table above, the live price feed on the rollup and the base-layer VRF. See `docs/audit-checklist.md` for the open and verified checks.
