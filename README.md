# Pump.fun Replay Sprint — Dip-Buy Bot

[![Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/deedath123/pump-fun-replay-sprint-20261124/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/deedath123/pump-fun-replay-sprint-20261124/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity (protocol `agent-fun/replay/v2`).

## Strategy

Buy the shakeout on curves that already gathered real demand: a coin whose price fell
30–45% off its recent high (1500-slot window) while buyers are still stepping in
(at least 4 of the last 6 trades are buys, the latest trade is a buy).

- **Strong tier** (15+ SOL real reserves): 0.35 SOL tranches up to 2.5 SOL per coin.
- **Probe tier** (3–15 SOL): 0.05–0.08 SOL tranches up to 0.15 SOL per coin, wider
  20–60% dip band, at most 3 probes open — these exist so the run always clears the
  20-coin guardrail with room to spare.
- **Exits**: take profit at +25% over cost, stop loss at −15%, or walk away after
  450 slots. Positions build in tranches while the price stays within 30% of the
  first entry. No pyramids into strength, no trailing stops.

## Run

The grader runs `node /bot/main.ts`. The bot speaks the replay protocol on
stdin/stdout: a `hello`, then one `batch` per slot, answering each with one reply
carrying its `orders`. It is deterministic — no clock, no environment, no randomness —
so two executions produce byte-identical action logs.

## Dev-window results (local engine)

Net **+6.7 SOL** after all fees (mean over 4 failed-tx draws; worst +5.8), 759 fills,
63 coins, 121 round trips, 39 wins, max drawdown 0.20 — against the house momentum
pilot's −9.38 SOL on the same window.

## Files

- `main.ts` — entrypoint
- `strategy.ts` — the dip-buy strategy
- `vendor/agentfun-bot.ts` — the kit's replay shim, vendored byte for byte
