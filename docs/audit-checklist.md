# Audit checklist

Status is updated as each item is verified on devnet. "Open" means not yet checked. "Partial" says exactly what was and was not covered. Verified items name the run that proved them (`scripts/e2e/10-round.mjs` unless stated).

| # | Check | How it is verified | Status |
| --- | --- | --- | --- |
| 1 | No test features or probe instructions in the deployed program | Dump the on-chain program, compare its hash with a clean release build, confirm the IDL has no diagnostic instruction and no `er-test` feature. Repeat after every upgrade | Verified at the last upgrade (slot 524821742): on-chain bytes equal the clean build (SHA-256 `524c7a4f…04db`), the unused tail of the account is all zeros, no diagnostic instruction in the IDL. A diagnostic build existed on devnet only between two earlier upgrades |
| 2 | Another wallet cannot read a player's hidden position through RPC | Read the entry from the Private ER with a non-member token, with positions written; read the base-layer copy | Verified: another player and a never-funded outsider could not read the entry while the owner could; the base-layer copy of a delegated entry showed no position in round 0. In later rounds the base copy shows the last *committed* (already revealed) position, as documented in the README |
| 3 | Transaction history does not expose positions | Fetch a `set_position` transaction as the owner, another player and a brand-new key (`scripts/e2e/leak-check.mjs`) | Verified: non-members receive an empty shell (zero account keys, no instruction data, zero log lines, no balances) |
| 4 | The close time cannot be read before it passes | Read the `Secret` as creator, player and outsider while a round is live | Verified: unreadable by all three while Live |
| 5 | The close time cannot be chosen or influenced by the creator or a player | Review the derivation (README) and recompute it from revealed values | Partial: the recomputation from revealed nonces matches the chain in every run; the negative tests in #6 are still to do |
| 6 | Nonces must be committed before lock-in and are immutable | Commit after lock-in; commit twice in one epoch; reuse a nonce from a previous epoch | Open |
| 7 | VRF output cannot be replayed or injected | Call `callback_close` directly, twice, and after `finalize_without_vrf` | Open (the genuine callback was verified to fire inside the Private ER and be mixed in) |
| 8 | `set_position` is rejected after the hidden close | Submit a position after the close and before settlement | Verified in four runs: rejected with `RoundClosed` (6009) |
| 9 | Stale or manipulated prices are rejected | Wrong feed account, wrong owner, zero price, stale publish time | Open |
| 10 | A wallet cannot join a league twice | Second `join_league` from the same wallet | Open |
| 11 | Settlement cannot be stranded by a late or missing trigger | Let the settlement window pass, then call `settle_and_reveal` | Verified: a league left Live far past its close was voided by a never-funded key (status moved to Between, round advanced, no price) and later rounds proceeded |
| 12 | Settlement cannot be run twice or with a wrong entry set | Duplicate, missing, reordered and foreign entries | Open |
| 13 | Entries and leagues can only be delegated to the TEE validator | `delegate_entry` and `delegate_league` with another validator | Open |
| 14 | The recomputed close time matches the chain | Audit page and `10-round.mjs` recompute the base seed and close time from revealed nonces | Verified in five runs (with and without VRF mixing) |
| 15 | Settlement needs no operator and no funds | Lock-in (with a VRF request) and settlement sent by a brand-new key holding 0 lamports | Verified in every run since the permission fix |
| 16 | A settlement crank works inside the Private ER | `schedule_settle` scheduled at round start and after the close, with no direct settle for 150 s | Tested, **did not execute** in either configuration; the instruction was removed. See the README |
| 17 | Multi-round leagues work (non-final commit, epoch reset, final undelegate) | Two-round league | Verified (required adding the magic fee vault account for a delegated payer) |
| 18 | Wallet disconnect and reconnect do not lose or leak state | Front end: reconnect mid-round | Open |
| 19 | Mobile layout and every page work | Front end review at phone width | Partial: Lobby, Desk and Audit checked at 375px; wallet flows need a browser with a wallet extension |
