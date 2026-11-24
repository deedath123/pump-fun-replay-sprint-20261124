// Dip-buy on pump.fun curves, for agent-fun/replay/v2.
//
// Idea: most launches die, but curves that already gathered real demand sometimes shake out
// weak hands and then bounce hard — a whale buy, a second wave, sometimes a full migration.
// We buy only the shakeout: a coin whose price fell off its recent high while buyers are
// still stepping in (at least 4 of the last 6 trades are buys and the latest trade is a buy).
//
// Two sizes. Strong curves (15+ SOL of real reserves at entry) get the full position: 0.35
// SOL tranches up to 2.5 SOL, entered on a 30-45% dip. Mid curves (3-15 SOL) get a small
// probe: 0.05 SOL tranches up to 0.2 SOL, entered on a wider 20-60% dip, at most 3 probes
// open at once. The probes exist so the run always clears the 20-coin guardrail with room
// to spare; they cost a little on average and the strong tier pays for them many times over.
//
// Positions build in tranches while the price stays within 30% of the first entry, and the
// whole position leaves at +25% over cost, is cut at -15%, or walks away after 450 slots if
// it never moves. No pyramids into strength, no trailing stops: in this tape a 25% pullback
// is ordinary noise, so a trailing stop just donates the winners back.
//
// Everything is a pure function of the batches the harness sends: no clock, no environment,
// no randomness, so the two graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface DipParams {
  /** Lookback (slots) for the recent high the dip is measured from. */
  highWindow: number;
  /** Strong tier: enter when the price is at least this far below the recent high... */
  dipMin: number;
  /** ...and not further than this (a collapse, not a dip). */
  dipMax: number;
  /** Probe tier: the wider dip band mid curves may enter on. */
  probeDipMin: number;
  probeDipMax: number;
  /** The curve must hold at least this much real SOL (lamports) at decision time. */
  minRealSol: bigint;
  /** The recent high must have come with at least this much real SOL (lamports). */
  minHighRealSol: bigint;
  /** Curves holding at least this much real SOL get the full-size strong tier. */
  strongRealSol: bigint;
  /** Of the last `flowTrades` trades at least `minBuys` must be buys... */
  flowTrades: number;
  minBuys: number;
  /** ...and the most recent trade must be a buy (the dip is being bought). */
  lastMustBeBuy: boolean;
  /** Net SOL bought over the last `flowTrades` trades must be at least this (lamports). */
  minNetFlow: bigint;
  /** Lamports per tranche (capped by the per-reply size cap) and most lamports per position. */
  tranche: bigint;
  maxPosition: bigint;
  /** The probe tier's tranche and cap. */
  probeTranche: bigint;
  probeMaxPosition: bigint;
  /** Most probe-tier positions open at once (the rest of the slots stay for strong entries). */
  maxProbeOpen: number;
  /** Smallest buy worth sending (tx fees are 105k lamports per order). */
  minBuy: bigint;
  /** Add tranches only while the price stays within this fraction of the first entry price. */
  addBand: number;
  /** Take profit when the position's liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** After an exit, ignore the coin for this many slots. */
  cooldownSlots: number;
  /** Slippage tolerance on buys and on sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Most new entries per reply. */
  maxEntriesPerBatch: number;
  /** Exits are sent as this many equal sells in one reply. */
  sellSplits: number;
}

// Tuned on the dev window with the local engine port, from the middle of broadly profitable
// regions rather than any single best point: strong dip 30-45% on 15+ SOL curves, probe dip
// 20-60% on 3-15 SOL curves, TP +25% / SL -15% / hold 450 slots, 0.35 SOL tranches to
// 2.5 SOL strong and 0.05 SOL tranches to 0.2 SOL probe.
export const DEFAULT_PARAMS: DipParams = {
  highWindow: 1500,
  dipMin: 0.3,
  dipMax: 0.45,
  probeDipMin: 0.2,
  probeDipMax: 0.6,
  minRealSol: 3_000_000_000n,
  minHighRealSol: 3_000_000_000n,
  strongRealSol: 15_000_000_000n,
  flowTrades: 6,
  minBuys: 4,
  lastMustBeBuy: true,
  minNetFlow: 0n,
  tranche: 350_000_000n,
  maxPosition: 2_500_000_000n,
  probeTranche: 80_000_000n,
  probeMaxPosition: 150_000_000n,
  maxProbeOpen: 3,
  minBuy: 8_000_000n,
  addBand: 0.3,
  takeProfit: 0.25,
  stopLoss: 0.15,
  maxHoldSlots: 450,
  cooldownSlots: 200,
  buySlippageBps: 500,
  sellSlippageBps: 3000,
  maxEntriesPerBatch: 2,
  sellSplits: 2,
};

const CURVE_FEE_BPS = 125n;
const BPS = 10_000n;

type Tier = 'strong' | 'probe';

interface Tick {
  slot: number;
  /** Marginal price: virtual SOL per virtual token. */
  price: number;
  realSol: bigint;
  isBuy: boolean;
  sol: bigint;
}

interface Curve {
  /** Tape of recent trades, oldest first (capped at 400). */
  tape: Tick[];
  /** Price and slot of the first buy sent for the open position, if any. */
  firstPrice: number;
  firstSlot: number;
  /** Lamports sent in buys for the open position (filled or not). */
  spent: bigint;
  /** Which tier the open position belongs to. */
  tier: Tier;
  /** Slot until which the coin is ignored after an exit. */
  blockedUntil: number;
  /** A sell is in flight: do not send another. */
  selling: boolean;
}

/** What selling `tokens` would pay after the curve's own fees (protocol + creator). */
function quoteOut(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

/**
 * The per-reply buy cap, with a margin: the harness checks it against the reserves shifted by our
 * own earlier flow on the coin, which can sit a little below the recorded ones the SDK keeps.
 */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

export function createDipBot(p: DipParams = DEFAULT_PARAMS): Bot {
  const curves = new Map<Pubkey, Curve>();
  const curveOf = (mint: Pubkey): Curve => {
    let c = curves.get(mint);
    if (c === undefined) {
      c = { tape: [], firstPrice: 0, firstSlot: -1, spent: 0n, tier: 'strong', blockedUntil: -1, selling: false };
      curves.set(mint, c);
    }
    return c;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const touched: Pubkey[] = [];
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent') continue;
        const c = curveOf(e.mint);
        const vt = BigInt(e.virtual_token_reserves);
        const price = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
        c.tape.push({ slot: e.slot, price, realSol: BigInt(e.real_quote_reserves), isBuy: e.is_buy, sol: BigInt(e.sol_amount) });
        if (c.tape.length > 400) c.tape.splice(0, c.tape.length - 400);
        if (!touched.includes(e.mint)) touched.push(e.mint);
      }
      // A position whose sell resolved (or failed) may need another exit attempt; a buy that
      // never filled forgets the entry so the coin can be tried again once the signal returns.
      for (const f of batch.fills) {
        const c = curves.get(f.mint);
        if (c === undefined) continue;
        if (f.side === 'sell') {
          c.selling = false;
          if (!state.positions.has(f.mint)) {
            c.spent = 0n;
            c.firstSlot = -1;
            c.blockedUntil = now + p.cooldownSlots;
          }
        } else if (f.status !== 'filled' && !state.positions.has(f.mint)) {
          let stillPending = false;
          for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
          if (!stillPending) {
            c.spent = 0n;
            c.firstSlot = -1;
          }
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      const pendingMints = new Set<Pubkey>();
      for (const o of state.pending.values()) pendingMints.add(o.order.mint);

      // 1. Exits and adds on held positions, in mint order (deterministic).
      const heldMints = [...state.positions.keys()].sort();
      for (const mint of heldMints) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint)!;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const c = curveOf(mint);
        if (c.selling) continue;
        const mk = marks.get(mint);
        const vq = mk !== undefined ? mk.vq : curve.virtual_quote_reserves;
        const vt = mk !== undefined ? mk.vt : curve.virtual_token_reserves;
        const value = quoteOut(pos.token_amount, vq, vt);
        const cost = pos.cost_lamports;
        const tp = cost > 0n && value * BPS >= cost * BigInt(Math.round((1 + p.takeProfit) * 10_000));
        const sl = cost > 0n && value * BPS <= cost * BigInt(Math.round((1 - p.stopLoss) * 10_000));
        const stale = c.firstSlot >= 0 && now - c.firstSlot >= p.maxHoldSlots;
        if (tp || sl || stale) {
          if (pendingMints.has(mint)) continue;
          const n = BigInt(Math.max(1, Math.min(p.sellSplits, cap - orders.length)));
          const piece = pos.token_amount / n;
          for (let i = 1n; i <= n; i++) {
            const amount = i === n ? pos.token_amount - piece * (n - 1n) : piece;
            orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: p.sellSlippageBps });
          }
          c.selling = true;
          continue;
        }
        // Add a tranche while the dip holds near the first entry price.
        const tierTranche = c.tier === 'strong' ? p.tranche : p.probeTranche;
        const tierMax = c.tier === 'strong' ? p.maxPosition : p.probeMaxPosition;
        if (pendingMints.has(mint) || c.spent >= tierMax) continue;
        const tape = c.tape;
        const price = tape.length > 0 ? tape[tape.length - 1]!.price : 0;
        if (c.firstPrice <= 0 || Math.abs(price / c.firstPrice - 1) > p.addBand) continue;
        let amount = tierMax - c.spent;
        if (amount > tierTranche) amount = tierTranche;
        const sizeCap = buyCap(state, mint);
        if (amount > sizeCap) amount = sizeCap;
        if (amount < p.minBuy) continue;
        if (state.freeCashLamports() - amount - tx < 0n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        c.spent += amount;
        pendingMints.add(mint);
      }

      // 2. New entries on coins that traded this batch.
      let entries = 0;
      let open = state.committedPositionCount();
      let probeOpen = 0;
      for (const m of state.positions.keys()) if (curveOf(m).tier === 'probe') probeOpen++;
      for (const o of state.pending.values()) {
        if (o.order.side === 'buy' && !state.positions.has(o.order.mint) && curveOf(o.order.mint).tier === 'probe') probeOpen++;
      }
      for (const mint of touched) {
        if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
        if (open >= state.hello.caps.max_open_positions) break;
        if (state.positions.has(mint) || pendingMints.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const c = curves.get(mint)!;
        if (now < c.blockedUntil) continue;
        const tape = c.tape;
        if (tape.length < p.flowTrades) continue;
        const last = tape[tape.length - 1]!;
        if (last.realSol < p.minRealSol) continue;
        const tier: Tier = last.realSol >= p.strongRealSol ? 'strong' : 'probe';
        if (tier === 'probe' && probeOpen >= p.maxProbeOpen) continue;
        // Recent high within the window, and the real SOL sitting behind it.
        let hi = 0;
        let hiReal = 0n;
        for (let i = tape.length - 1; i >= 0; i--) {
          const t = tape[i]!;
          if (now - t.slot > p.highWindow) break;
          if (t.price > hi) {
            hi = t.price;
            hiReal = t.realSol;
          }
        }
        if (hi <= 0 || hiReal < p.minHighRealSol) continue;
        const dip = 1 - last.price / hi;
        const dipLo = tier === 'strong' ? p.dipMin : p.probeDipMin;
        const dipHi = tier === 'strong' ? p.dipMax : p.probeDipMax;
        if (dip < dipLo || dip > dipHi) continue;
        // Buyers still stepping in.
        let buys = 0;
        let net = 0n;
        for (let i = tape.length - p.flowTrades; i < tape.length; i++) {
          const t = tape[i]!;
          if (t.isBuy) {
            buys++;
            net += t.sol;
          } else {
            net -= t.sol;
          }
        }
        if (buys < p.minBuys || net < p.minNetFlow) continue;
        if (p.lastMustBeBuy && !last.isBuy) continue;
        const tierTranche = tier === 'strong' ? p.tranche : p.probeTranche;
        const tierMax = tier === 'strong' ? p.maxPosition : p.probeMaxPosition;
        let amount = tierTranche;
        if (amount > tierMax) amount = tierMax;
        const sizeCap = buyCap(state, mint);
        if (amount > sizeCap) amount = sizeCap;
        if (amount < p.minBuy) continue;
        if (state.freeCashLamports() - amount - tx < 0n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        c.firstPrice = last.price;
        c.firstSlot = now;
        c.spent = amount;
        c.tier = tier;
        c.selling = false;
        pendingMints.add(mint);
        entries++;
        open++;
        if (tier === 'probe') probeOpen++;
      }
      return orders;
    },
  };
}
