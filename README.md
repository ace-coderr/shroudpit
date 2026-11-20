# Shroudpit

Private trading leagues on Solana. Players place paper positions against real, live prices. Positions stay hidden inside a Private Ephemeral Rollup until the round closes at a randomised moment. Then results are revealed and settled on-chain, producing a risk-adjusted skill rating and a trophy asset the winner owns.

**Problem.** Public leaderboards leak strategies (copying, front-running) and track records are unverifiable.

**Approach.** Hide positions while the round is live, make the close time unpredictable, and settle everything on-chain so every result can be audited.

## How MagicBlock primitives are used

| Primitive | Role |
| --- | --- |
| Ephemeral Rollup | Fast, gasless position updates during a round |
| Private Ephemeral Rollup (TEE) | Positions are readable only by their owner until settlement |
| VRF | The round close moment is randomised and cannot be predicted or chosen |

## Repository layout

```
src/        React + TypeScript front end (Vite)
program/    Anchor program (Rust)
.github/    GitHub Pages deployment workflow
```

## Network

Devnet only. No real funds are involved.

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

## Deployment

The site is a static build served from GitHub Pages. Every push to `main` runs `.github/workflows/deploy.yml`, which installs, lints, builds and publishes `dist/`. There is no backend.

## Rating

The risk-adjusted rating formula is documented here once the scoring instruction is implemented.

## Status

Scaffold. Program instructions, price feed, rating, trophy and the front-end modules are built in later steps.
