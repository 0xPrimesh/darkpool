/**
 * Markets: one settlement pool (base-mock / USDC-mock) + one Pyth feed each.
 *
 * The darkpool program only accepts a price account that carries the feed id
 * registered for the batch's pool (`MarketConfig` PDA), so a batch in the
 * gold pool can never be priced with SOL/USD and vice versa.
 *
 * Every base mock has 9 decimals, so the circuit and the settlement program
 * are unchanged: prices are USDC (6 dp) per whole base unit.
 *
 * Price accounts are Pyth push-oracle PDAs (shard 0 of the upgraded push
 * oracle program). SOL/USD's is sponsored by Pyth on devnet (pushed roughly
 * once a minute). XAU/USD's exists on devnet but nobody keeps it fresh, so
 * the coordinator maintains it itself through Hermes (HERMES_API_KEY) using
 * the same permissionless `update_price_feed` path, and only while the
 * metals market is open (Hermes' listing carries the schedule). Hermes
 * entitlements are per asset class: the key must cover metals.
 *
 * Each market has its own collateral tier (`bucket`, in whole base units):
 * every party escrows `bucket` base-mock plus `bucket x reference x
 * ESCROW_BOUND_PCT` USDC-mock, so one ounce of gold would need ~5k USDC.
 */
import { PublicKey } from "@solana/web3.js";
import {
  PRO_COMPATIBLE_PUSH_ORACLE_PROGRAM_ID,
  getPriceFeedAccountForProgram,
} from "@pythnetwork/pyth-solana-receiver";
import { Ctx, Deployment } from "./config";
import { Mints, ensurePool, poolPda } from "./settlement";
import { ensureMarket, marketPda } from "./arcium";

/** Hermes `asset_type` values. Everything but crypto has trading hours. */
export type MarketKind = "crypto" | "equity" | "metal" | "fx";

export interface MarketDef {
  /** Ticker shown in the UI and used in API routes, e.g. "SOL". */
  symbol: string;
  name: string;
  kind: MarketKind;
  /** Pyth feed id, hex without 0x. */
  feedId: string;
  /** Hermes `display_symbol` + asset_type, for the public market-hours lookup. */
  hermesQuery: { query: string; assetType: MarketKind };
  /** True when Pyth itself keeps the devnet push account fresh. */
  sponsored: boolean;
  /** Push-oracle shard whose account the program is handed. */
  shard: number;
  decimals: 9;
  /** Collateral tier in whole base units (env `<SYMBOL>_BUCKET` overrides). */
  bucket: number;
}

export const SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
/** Metal.XAU/USD: gold, one troy ounce in USD. */
export const XAU_USD_FEED_ID =
  "765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2";

function envBucket(symbol: string, dflt: number): number {
  const raw = process.env[`${symbol}_BUCKET`];
  const n = raw === undefined ? dflt : Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${symbol}_BUCKET must be a positive number`);
  return n;
}

export const MARKET_DEFS: MarketDef[] = [
  {
    symbol: "SOL",
    name: "Solana",
    kind: "crypto",
    feedId: process.env.SOL_FEED_ID ?? SOL_USD_FEED_ID,
    hermesQuery: { query: "SOL/USD", assetType: "crypto" },
    sponsored: true,
    shard: 0,
    decimals: 9,
    bucket: envBucket("SOL", 1),
  },
  {
    symbol: "XAU",
    name: "Gold",
    kind: "metal",
    feedId: process.env.XAU_FEED_ID ?? XAU_USD_FEED_ID,
    hermesQuery: { query: "XAU/USD", assetType: "metal" },
    sponsored: false,
    shard: 0,
    decimals: 9,
    bucket: envBucket("XAU", 0.1),
  },
];

/** Markets enabled for this deployment (MARKETS=SOL,XAU). */
export function enabledMarketDefs(): MarketDef[] {
  const want = (process.env.MARKETS ?? "SOL,XAU")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const defs = MARKET_DEFS.filter((d) => want.includes(d.symbol));
  if (!defs.length) throw new Error(`MARKETS=${process.env.MARKETS} matches no known market`);
  return defs;
}

/** Collateral tier in base-mock lamports (9 dp). */
export function bucketLamports(def: MarketDef): bigint {
  return BigInt(Math.round(def.bucket * 1e9));
}

export function pythPushAccount(def: MarketDef): PublicKey {
  return getPriceFeedAccountForProgram(
    def.shard,
    def.feedId,
    PRO_COMPATIBLE_PUSH_ORACLE_PROGRAM_ID
  );
}

export interface Market {
  def: MarketDef;
  symbol: string;
  /** `solMint` is the base mock mint (name kept from the single-market days). */
  mints: Mints;
  pool: PublicKey;
  marketConfig: PublicKey;
  /** Pyth push-oracle account the program reads for this market. */
  priceAccount: PublicKey;
}

/** Markets whose base mint exists in deployment.json. */
export function loadMarkets(ctx: Ctx, dep: Deployment): Market[] {
  const usdcMint = new PublicKey(dep.usdcMint);
  return enabledMarketDefs()
    .filter((def) => dep.markets[def.symbol]?.mint)
    .map((def) => {
      const mints = {
        solMint: new PublicKey(dep.markets[def.symbol].mint),
        usdcMint,
      };
      const pool = poolPda(ctx, mints);
      return {
        def,
        symbol: def.symbol,
        mints,
        pool,
        marketConfig: marketPda(ctx, pool),
        priceAccount: pythPushAccount(def),
      };
    });
}

export function marketBySymbol(markets: Market[], symbol: unknown): Market {
  const s = String(symbol ?? markets[0].symbol).toUpperCase();
  const m = markets.find((x) => x.symbol === s);
  if (!m)
    throw new Error(
      `unknown market ${s}; available: ${markets.map((x) => x.symbol).join(", ")}`
    );
  return m;
}

/** Pool + MarketConfig for every market (idempotent). */
export async function ensureMarkets(
  ctx: Ctx,
  markets: Market[]
): Promise<{ symbol: string; pool: string; poolSig?: string; marketSig?: string }[]> {
  const out = [];
  for (const m of markets) {
    const p = await ensurePool(ctx, m.mints);
    const r = await ensureMarket(ctx, m.pool, m.def.feedId);
    out.push({ symbol: m.symbol, pool: p.pool.toBase58(), poolSig: p.sig, marketSig: r.sig });
  }
  return out;
}
