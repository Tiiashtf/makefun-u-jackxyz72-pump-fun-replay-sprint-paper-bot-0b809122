// Runner Hunter — a paper bot for the pump.fun replay sprint.
//
// The dev window teaches one lesson: almost every coin spikes and then fades,
// and chasing a fresh 8% rise buys the top (the median trade hits its stop).
// The only trades that pay are the rare runners: coins that already ran up
// 2x or more from creation and are still alive. So this bot ignores ordinary
// breakouts entirely and only buys a proven runner, either on a dip after its
// run-up or when it breaks out to a new high after that dip, then lets it run
// with a wide trailing stop instead of a fixed take-profit: the payout goes to
// the top 3, so the fat right tail of one 3-5x runner matters more than a
// steady trickle of small wins.
//
// How a batch is handled: the hello message sets the capital and caps; each
// batch delivers the slot's events, marks and fills, and this bot answers with
// its orders for that slot (at most 16). Orders decided on one slot fill two
// slots later, so entries are sized for the fill price, not the decision price.
// Everything is deterministic: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.
//
// Fees decide the trade: a round trip pays ~1.25% of curve fees per leg plus a
// fixed tx fee per order, so positions must be able to clear roughly 3% before
// they are worth opening. Small probes exist only to keep the run above the
// guardrail minimums (20 coins, 0.01 SOL round trips).

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
// Curve fee fallback: protocol 95 bps + creator 30 bps.
const CURVE_FEE = 0.0125;

export interface Params {
  /** Run-up from the create price that marks a coin a runner. */
  minRunup: number;
  /** Dip from the running high that arms a buy. */
  dip: number;
  /** Buy the dip directly, or wait for the price to retake the prior high. */
  mode: 'dip' | 'breakout';
  /** Real SOL reserve bounds at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** Slots since CreateEvent before an entry is allowed. */
  minAge: number;
  /** Position sizing (SOL). */
  firstBuySol: number;
  addSol: number;
  maxStakeSol: number;
  minBuySol: number;
  /** Slippage on buys in bps; sells go out at any price. */
  buySlipBps: number;
  /** Exits (fractions of cost / peak value). */
  stopLoss: number;
  trailArm: number;
  trailDrop: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on a single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots unless the position is up at least holdIfUp. */
  maxHold: number;
  holdIfUp: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Most main positions open at once (the rest of the 5-position cap is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing: keep fills / coins on pace over the window. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minRunup: 2.0,
  dip: 0.1,
  mode: 'dip',
  minRealSol: 2,
  maxRealSol: 100,
  minAge: 0,
  firstBuySol: 0.2,
  addSol: 0.2,
  maxStakeSol: 0.8,
  minBuySol: 0.01,
  buySlipBps: 800,
  stopLoss: 0.2,
  trailArm: 0.2,
  trailDrop: 0.3,
  fadeWindow: 60,
  fadeNetSol: 2.0,
  bigSellSol: 3,
  maxHold: 3600,
  holdIfUp: 0.1,
  maxEntries: 1,
  maxMain: 4,
  maxExposureSol: 4,
  targetCoins: 25,
  targetFills: 120,
  paceSecs: 86400,
  probeSol: 0.02,
  maxProbes: 1,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  /** Price of the first trade seen (the create price). */
  firstPrice: number;
  /** Highest price since creation. */
  high: number;
  /** The high the price dipped from (0 until a qualifying dip happens). */
  dipHigh: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastBuyPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  // Probe round trips in flight, by mint: false while the buy is pending, true once selling.
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.fadeWindow, 300) + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, firstPrice: 0, high: 0, dipHigh: 0, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          if (t.firstPrice === 0) t.firstPrice = price;
          if (price > t.high) t.high = price;
          // A qualifying dip arms the tape: the coin ran up, then pulled back.
          if (t.dipHigh === 0 && t.firstPrice > 0 && t.high >= t.firstPrice * (1 + p.minRunup) && price <= t.high * (1 - p.dip)) {
            t.dipHigh = t.high;
          }
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      // Trim tapes to the lookback we still need.
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Close value of a position now: what selling all its tokens would return
      // after the curve fee and one tx fee.
      const closeValue = (mint: Pubkey): number => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        if (vt + tokens <= 0) return 0;
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // 1. Exits first: stop, trailing stop, fade, big sell, time limit.
      // No fixed take-profit: a runner is held until its trailing stop fires.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(mint);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trailDrop)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      // 2. Probe sells: dump a probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        if (!selling) probes.set(mint, true);
      }

      // 3. Entries and adds: only proven runners, on a dip or a breakout retake.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries) continue;
          if (t.created === null || now - t.created < p.minAge) continue;
          if (realSol < p.minRealSol || realSol > p.maxRealSol) continue;
          if (t.dipHigh === 0) continue;
          if (p.mode === 'dip') {
            // Buy the dip itself: price still below the high it fell from.
            if (price > t.dipHigh * (1 - p.dip / 2)) continue;
          } else {
            // Breakout: price retook the high it dipped from.
            if (price < t.dipHigh) continue;
          }
          want = p.firstBuySol;
        } else {
          // Add only into strength: price stepped up from the last buy, the
          // position is not underwater, and inflow is still positive.
          if (h.exiting || !h.filled || h.invested >= p.maxStakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastBuyPrice * 1.1) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
          if (flow(t, now, p.fadeWindow) < 0) continue;
          if (realSol > p.maxRealSol) continue;
          want = Math.min(p.addSol, p.maxStakeSol - h.invested);
        }
        // One mint's buys in one reply share 1% of its real SOL reserve.
        const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.99) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastBuyPrice: price, lastValue: 0 });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastBuyPrice = price;
        }
      }

      // 4. Guardrail pacing: a tiny probe round trip when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minReal = (p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minReal * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
