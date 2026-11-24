# Demo league: run order for the video

Player 1 is the Phantom wallet (`Cp4T…YMB3`), which also **creates** the league and does every creator step in the browser. Player 2 is the `GcMQ…yy3M` wallet, driven by `scripts/demo/second-player.mjs` on cue. Devnet only.

## Before filming

- Phantom is on **devnet** and holds a few tenths of a SOL (create, join and the Private ER steps cost a few hundredths). The wallet showed about 4.6 SOL at last check.
- Two browser tabs on the live site, so no page change eats into a timed window: **tab A** `#/create` (creator console), **tab B** the league's Desk once it exists. Keep the Desk tab **in the foreground** from "Open round" to the end of each round: browsers throttle background tabs, and the Desk tab is what locks in, settles, reveals and finishes (its helper box "Help lock in, settle and reveal from this tab" must stay ticked).
- A terminal in the repo, ready with the command below. Replace `<LEAGUE>` with the address once the league exists.

## League settings (Create form)

| Field | Value | Why |
| --- | --- | --- |
| Asset | SOL/USD | live oracle price |
| Rounds | 2 | shows a settled round, the Between phase, then the final reveal |
| Earliest close / latest close | 60 / 90 seconds | short enough to film, long enough to show the band tighten |
| Maximum players | 2 | the minimum; the league is full once the script joins |
| Close time derivation | default (VRF mixed in), or "Nonces + slot" | VRF adds about 3 seconds before LIVE |

For a shorter video use Rounds = 1 and skip every "round 2" step.

## Run order

Times are from the moment of the click that starts them.

| # | Who | Where | Action | Wait or timing |
| --- | --- | --- | --- | --- |
| 1 | Phantom | tab A `#/create` | Connect wallet, fill the form, **Create league** | two Phantom approvals: create, then join (the creator plays too) |
| 2 | you | tab A | copy the league address (copy icon on the card under "Your leagues") | |
| 3 | terminal | | **start the second player now** (command below) | it joins, then logs in to the Private ER and seals its entry; the login can take up to a minute, so start it early. It prints `joined and delegated my entry` and `sealed my entry` |
| 4 | Phantom | tab A | wait until the card reads **2/2 players**, then **Close joining and move to the Private ER** | one approval |
| 5 | Phantom | tab A | **Hide the close time** | a login signature and one approval; the next button appears within about 6 seconds |
| 6 | Phantom | tab B `#/desk/<LEAGUE>` | **Unlock my desk**, then **Seal my entry** | one signature each |
| 7 | Phantom | tab A | **Open round 1** | **starts the 45 s nonce window** |
| 8 | script | | commits its nonce within about a second (prints `committed my nonce`) | |
| 9 | Phantom | tab B | **Seal my nonce** within the 45 s | once both nonces are in, the Desk locks in within about 3 s (VRF mode: LIVE about 3 s later) |
| 10 | Phantom | tab B | when the band shows LIVE: pick Long or Short, leverage, **Place position** | the close lands at a hidden moment **60 to 90 s after lock-in**: do not wait |
| 11 | script | | places its short about 1 to 3 s after LIVE (prints `placed my short position ... s after LIVE`) | |
| 12 | (nothing) | tab B | the band tightens; at the close the Desk settles by itself | **60 s settle window** after the close; the open Desk normally settles in about 3 s. The page shows "Round settled" with the settle time |
| 13 | Phantom | tab A | **Open round 2** | **a new 45 s nonce window**; repeat steps 9 to 12 (the script follows by itself) |
| 14 | (nothing) | tab B | after the final settle the Desk shows **Revealing**, then publishes the entries and finishes | 10 to 30 s; Audit shows "chunk n of N" while it runs |
| 15 | you | `#/audit/<LEAGUE>`, `#/standings/<LEAGUE>` | show Final scores, the recomputed close times and the labelled transactions | |
| 16 | Phantom | `#/record` | if Phantom won, **Claim trophy** (about 0.0026 SOL) | if `GcMQ` won, use the claim command below instead |

Rough total for two rounds: about 7 to 9 minutes.

## Commands

Second player (start at step 3; it exits by itself when the league is revealing or finished; safe to stop and start again):

```powershell
wsl -d Ubuntu -- bash -lc 'cd "/mnt/c/Users/ACE CODER/Desktop/ace/hackathons/shroudpit" && KEYPAIR_DIR=$HOME/.config/solana LEAGUE=<LEAGUE> SIDE=short node scripts/demo/second-player.mjs'
```

`SIDE=long|short|flat` and `LEVERAGE=1..5` set its position. Output is one short line per action, for example:

```
joined and delegated my entry
sealed my entry (private to this wallet)
committed my nonce for round 1 (41 s were left)
LIVE: round 1 of 2
placed my short position 1.8 s after LIVE
```

If no Desk settles a round (tab in the background, helper unticked): run this inside the 60 s window after the close.

```powershell
wsl -d Ubuntu -- bash -lc 'cd "/mnt/c/Users/ACE CODER/Desktop/ace/hackathons/shroudpit" && LEAGUE=<LEAGUE> node scripts/e2e/settle-league.mjs'
```

If `GcMQ` wins and you want its trophy on camera too:

```powershell
wsl -d Ubuntu -- bash -lc 'cd "/mnt/c/Users/ACE CODER/Desktop/ace/hackathons/shroudpit" && LEAGUE=<LEAGUE> KEYPAIR_DIR=$HOME/.config/solana node scripts/e2e/claim-trophy.mjs'
```

## What the browser can and cannot do for a creator

Every step has a button except one: **restarting an expired nonce window**. If fewer than two nonces are in when the 45 s end, the program allows the creator to call `start_round` again, but there is no button for it. If that happens while filming, create a new league (or add the button first).

## Notes

- The nonce window is the only step with a tight human deadline (45 s). Keep tab B on the Desk, unlocked and sealed, before clicking **Open round**.
- A round whose close is not settled within 60 s is voided and scores nobody. The open Desk settling is what prevents that, so keep it in the foreground.
- The Private ER attestation check may time out in the browser or in the script; both stay authenticated and carry on.
