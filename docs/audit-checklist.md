# Audit checklist

Status is updated as each item is verified on devnet. "Open" means not yet checked.

| # | Check | How it is verified | Status |
| --- | --- | --- | --- |
| 1 | No test features or probe instructions in the deployed program | Dump the on-chain program, compare its hash with a clean release build, confirm the IDL has no diagnostic instruction and no `er-test` feature is compiled in. Repeat after every upgrade | Verified at slot 524696378: the on-chain bytes equal the clean release build (SHA-256 `9b37aa01…a6791`), the remaining allocated bytes are zero, and the IDL has no diagnostic instruction. A diagnostic build existed on devnet only between two upgrades while the VRF and clone experiments ran |
| 2 | Another wallet cannot read a player's hidden position through RPC | Read the entry account and its transactions from the Private ER with a non-member token; read the base-layer copy while delegated | Open |
| 3 | Logs and transaction history do not expose positions | Fetch `start`, `set_position` and settlement transactions as a non-member | Open |
| 4 | The close time cannot be predicted or read before it passes | Read the league account as creator, player and outsider while the round is live | Open |
| 5 | The close time cannot be chosen or influenced by the creator or a player | Review the randomness path end to end | Open |
| 6 | VRF output cannot be replayed or injected | Call `callback_close` directly and twice; call it with a forged identity | Open |
| 7 | `set_position` is rejected after the hidden close | Submit a position after `close_at` and before settlement, and after settlement | Open |
| 8 | Stale or manipulated prices are rejected | Wrong feed account, wrong owner, zero price, stale publish time | Open |
| 9 | A wallet cannot join a league twice | Second `join_league` from the same wallet | Open |
| 10 | Settlement cannot be stranded by a late or missing trigger | Let the settlement window pass and call `settle_and_reveal`; confirm the round is voided and the league continues or finishes | Open |
| 11 | Settlement cannot be run twice or with a wrong entry set | Duplicate, missing, reordered and foreign entries | Open |
| 12 | Entries can only be delegated to the TEE validator | `delegate_entry` and `delegate_league` with another validator | Open |
| 13 | Wallet disconnect and reconnect do not lose or leak state | Front end: reconnect mid-round | Open |
| 14 | Mobile layout and every page work | Front end review at phone width | Open |
