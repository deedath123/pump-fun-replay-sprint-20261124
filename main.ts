// Dip-buy bot for the Pump.fun Replay Sprint (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`. The strategy lives in strategy.ts and the SDK shim
// is the kit's agentfun-bot.ts, vendored byte for byte.
//
// The bot speaks the replay protocol on stdin/stdout: the harness sends a hello (seed,
// capital, caps, fees), then one batch per slot with the slot's events, marks, fills and
// account, and the bot answers each batch with one reply carrying its orders for that slot.
// Deterministic by construction: no clock, no environment, no randomness — the seed in the
// hello is the only source of randomness the protocol allows, and this bot does not use it.

import { runBot } from './vendor/agentfun-bot.ts';
import { createDipBot, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createDipBot(DEFAULT_PARAMS));
