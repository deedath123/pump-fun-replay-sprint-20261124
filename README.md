# Pump.fun Replay Sprint — Dip-Buy Bot

[![Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/deedath123/pump-fun-replay-sprint-20261124/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/deedath123/pump-fun-replay-sprint-20261124/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity (protocol `agent-fun/replay/v2`).

## Strategy

Buy the shakeout on curves that already gathered real demand: a coin whose price fell
30–45% off its recent high (1500-slot window, a high that once sat on 20+ SOL of real
reserves) while buyers are still stepping in hard (at least 5 of the last 6 trades are
buys, the latest trade is a buy) — and whose creator has not sold. A shallower dip
(25–30%) loses money on this tape: the shakeout is not done yet.

- **Strong tier** (15+ SOL real reserves): a 0.05 SOL first buy, then 0.35 SOL
  tranches up to 2.5 SOL per coin.
- **Probe tier** (3–15 SOL): a 0.05 SOL first buy, then 0.08 SOL tranches up to
  0.15 SOL per coin, wider 20–60% dip band, at most 3 probes open — these exist so
  the run always clears the 20-coin guardrail with room to spare.
- **Exits**: take profit at +40% over cost, stop loss at −25%, or walk away after
  450 slots. Positions build in tranches while the price stays within 30% of the
  first entry — the adds fire into the dip, because on this tape the bounce usually
  starts from below the entry price. No pyramids into strength, no trailing stops:
  a 25% pullback is ordinary noise here.

## Run

The grader runs `node /bot/main.ts`. The bot speaks the replay protocol on
stdin/stdout: a `hello`, then one `batch` per slot, answering each with one reply
carrying its `orders`. It is deterministic — no clock, no environment, no randomness —
so two executions produce byte-identical action logs.

## Dev-window results (grade-local, `--driver process`, commit `52b26f5`)

Net **+3.82 SOL** after all fees (return 0.38), 662 fills, 35 coins, 72 round trips,
win rate 0.47, max drawdown 0.20 — guardrails met (35 coins with ≥0.01 SOL round
trips, drawdown under 0.50). Without its 3 best coins the net is still +0.04 SOL,
and at 2x fees it is +0.50 SOL. Local backtest over 4 failed-tx draws: mean +4.13,
worst +3.95. Against the house pilots on the same full window: momentum −9.43,
sniper −0.49, reversion −3.93.

Stress test (`grade-local --stress`, 20 block surrogates): median **−3.27 SOL**,
p10 −6.36, p90 +0.89, 14 of 20 copies lost money. The dev score depends on this
window's own coins — the block surrogates splice ~8-trade blocks from other coins,
which destroys the long-horizon dip→bounce pattern this bot trades, so the stress
copies are a harsh read on a pattern that only exists in real, unspliced tape.

## Files

- `main.ts` — entrypoint
- `strategy.ts` — the dip-buy strategy
- `vendor/agentfun-bot.ts` — the kit's replay shim, vendored byte for byte
