# Audit checklist

Status is updated as each item is verified on devnet. "Open" means not yet checked. "Partial" says exactly what was and was not covered.

| # | Check | How it is verified | Status |
| --- | --- | --- | --- |
| 1 | No test features or probe instructions in the deployed program | Dump the on-chain program, compare its hash with a clean release build, confirm the IDL has no diagnostic instruction and no `er-test` feature is compiled in. Repeat after every upgrade | Verified at the last upgrade: on-chain bytes equal the clean build (SHA-256 `91e06c6c…8942`), no diagnostic instruction in the IDL. A diagnostic build existed on devnet only between two upgrades while the VRF and clone experiments ran |
| 2 | Another wallet cannot read a player's hidden position through RPC | Read the entry from the Private ER with a non-member token; read the base-layer copy while delegated | Partial: a non-member token could not read another player's `Entry` and the owner could (devnet, 3 wallets). Not yet checked with a position written, nor the base-layer copy mid-round |
| 3 | Logs and transaction history do not expose positions | Fetch `set_position` and nonce transactions as a non-member | Open |
| 4 | The close time cannot be read before it passes | Read the `Secret` as creator, player and outsider while a round is live | Partial: the `Secret` was unreadable by the creator and another player (devnet). Not yet checked with a live round's data in it |
| 5 | The close time cannot be chosen or influenced by the creator or a player | Review the derivation (see README); try committing a nonce after lock-in and re-committing | Open |
| 6 | Nonces must be committed before lock-in and are immutable | Commit after lock-in; commit twice in one epoch; reuse a nonce from a previous epoch | Open |
| 7 | VRF output cannot be replayed or injected | Call `callback_close` directly, call it twice, call it after `finalize_without_vrf` | Open |
| 8 | `set_position` is rejected after the hidden close | Submit a position after the close and before settlement, and after settlement | Open |
| 9 | Stale or manipulated prices are rejected | Wrong feed account, wrong owner, zero price, stale publish time | Open |
| 10 | A wallet cannot join a league twice | Second `join_league` from the same wallet | Open |
| 11 | Settlement cannot be stranded by a late or missing trigger | Let the settlement window pass and call `settle_and_reveal`; confirm the round is voided and the league continues or finishes | Open |
| 12 | Settlement cannot be run twice or with a wrong entry set | Duplicate, missing, reordered and foreign entries | Open |
| 13 | Entries and leagues can only be delegated to the TEE validator | `delegate_entry` and `delegate_league` with another validator | Open |
| 14 | The recomputed close time matches the chain | Audit page recomputation and `scripts/e2e/10-round.mjs` | Open |
| 15 | The settlement crank works inside the Private ER | `schedule_settle`, then observe settlement with no direct call | Open |
| 16 | Wallet disconnect and reconnect do not lose or leak state | Front end: reconnect mid-round | Open |
| 17 | Mobile layout and every page work | Front end review at phone width | Open |
