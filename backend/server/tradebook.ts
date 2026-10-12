/**
 * On-chain trade book.
 *
 * Every batch is a settlement `Batch` PDA, so the book is read straight from
 * the chain rather than from coordinator memory: it survives restarts and
 * shows batches created by other coordinators or `yarn e2e`. For settled
 * batches the darkpool `MatchResult` PDA tells which slot bought.
 *
 * Only what settlement already made public is shown (clearing price, size,
 * USDC paid, who bought). Nothing about unmatched batches beyond "cancelled".
 */
import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { Ctx, explorerAddress } from "../scripts/lib/config";
import { matchResultPda } from "../scripts/lib/arcium";
import { batchPda } from "../scripts/lib/settlement";
import { fmt } from "../scripts/lib/tokens";
import type { Market } from "../scripts/lib/markets";

export interface Trade {
  /** Market symbol, from the batch's pool. */
  market: string;
  batchId: string;
  time: number;
  state: "open" | "settled" | "cancelled";
  matched: boolean;
  price?: string;
  qty?: string;
  notional?: string;
  solBucket: string;
  usdcBucket: string;
  parties: string[];
  buyer?: string;
  seller?: string;
  explorer: string;
}

export interface TradeBook {
  updatedAt: number;
  trades: Trade[];
}

const MAX_ROWS = 200;
let cache: TradeBook = { updatedAt: 0, trades: [] };
let inflight: Promise<TradeBook> | null = null;

/** Cached for `maxAgeMs`; concurrent callers share one refresh. */
export async function getTradeBook(
  ctx: Ctx,
  markets: Market[],
  maxAgeMs = 15_000
): Promise<TradeBook> {
  if (Date.now() - cache.updatedAt < maxAgeMs) return cache;
  if (!inflight)
    inflight = load(ctx, markets)
      .then((book) => (cache = book))
      .finally(() => (inflight = null));
  return inflight;
}

/** Drop the cache (call after a batch settles or is cancelled). */
export function invalidateTradeBook(): void {
  cache = { ...cache, updatedAt: 0 };
}

function stateOf(s: Record<string, unknown>): Trade["state"] {
  if ("settled" in s) return "settled";
  if ("cancelled" in s) return "cancelled";
  return "open";
}

async function load(ctx: Ctx, markets: Market[]): Promise<TradeBook> {
  // Batches from before the market registry all belong to the SOL/USDC pool
  // of that time; label anything we cannot map after the first market.
  const byPool = new Map(markets.map((m) => [m.pool.toBase58(), m.symbol]));
  const legacy = markets[0]?.symbol ?? "SOL";
  const accounts = await ctx.connection.getProgramAccounts(
    ctx.settlement.programId,
    { commitment: "confirmed" }
  );
  const coder = ctx.settlement.coder.accounts;
  const rows: {
    id: anchor.BN;
    state: Trade["state"];
    b: any;
    parties: string[];
  }[] = [];
  for (const a of accounts) {
    let b: any;
    try {
      b = coder.decode("batch", a.account.data);
    } catch {
      continue; // pool account, or a batch from an older program layout
    }
    const parties = (b.parties as { wallet: PublicKey }[])
      .map((p) => p.wallet)
      .filter((w) => !w.equals(PublicKey.default))
      .map((w) => w.toBase58());
    rows.push({
      id: b.batchId as anchor.BN,
      state: stateOf(b.state),
      b,
      parties,
    });
  }
  rows.sort((x, y) => y.id.cmp(x.id));
  const top = rows.slice(0, MAX_ROWS);

  // Which slot bought, for settled batches only.
  const settled = top.filter((r) => r.state === "settled");
  const aIsBuyer = new Map<string, boolean>();
  if (settled.length) {
    const pdas = settled.map((r) => matchResultPda(ctx, r.id));
    const results = await ctx.darkpool.account.matchResult.fetchMultiple(pdas);
    results.forEach((mr: any, i) => {
      if (mr) aIsBuyer.set(settled[i].id.toString(), !!mr.aIsBuyer);
    });
  }

  const trades: Trade[] = top.map(({ id, state, b, parties }) => {
    const key = id.toString();
    const t: Trade = {
      market: byPool.get((b.pool as PublicKey).toBase58()) ?? legacy,
      batchId: key,
      time: id.toNumber(),
      state,
      matched: state === "settled",
      solBucket: fmt(BigInt(b.solBucket.toString()), 9),
      usdcBucket: fmt(BigInt(b.usdcBucket.toString()), 6),
      parties,
      explorer: explorerAddress(batchPda(ctx, id), ctx.cluster),
    };
    if (state === "settled") {
      t.price = fmt(BigInt(b.clearingPrice.toString()), 6);
      t.qty = fmt(BigInt(b.qty.toString()), 9);
      t.notional = fmt(BigInt(b.usdcPaid.toString()), 6);
      const ab = aIsBuyer.get(key);
      if (ab !== undefined && parties.length === 2) {
        t.buyer = ab ? parties[0] : parties[1];
        t.seller = ab ? parties[1] : parties[0];
      }
    }
    return t;
  });
  return { updatedAt: Date.now(), trades };
}
