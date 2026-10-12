/**
 * Reference prices, one per market.
 *
 * The darkpool program reads the reference price ON-CHAIN from the Pyth
 * `PriceUpdateV2` account passed to `match_orders` (owner, feed id,
 * staleness and confidence are all checked there, and the feed id must be
 * the one registered for the batch's pool). Nothing in this process ever
 * sends a price number to the chain. This module only decides WHICH account
 * to pass, keeps it fresh, and reads it for display / escrow sizing.
 *
 * PRICE_SOURCE=pyth  Each market's account is the Pyth push-oracle PDA for
 *                    its feed (shard 0). SOL/USD's is sponsored by Pyth on
 *                    devnet (refreshed ~once a minute). Equity feeds are not
 *                    sponsored, so the coordinator refreshes those itself:
 *                    it fetches the latest signed update from Hermes and
 *                    submits it through the push oracle's permissionless
 *                    `update_price_feed`. The receiver verifies the Wormhole
 *                    guardian signatures, so nobody can forge a price this
 *                    way. Needs HERMES_API_KEY (Pyth Core, free trial).
 * PRICE_SOURCE=mock  localnet only: `set_mock_price` writes a Pyth-shaped
 *                    account per feed owned by the darkpool program (needs
 *                    the `mock-oracle` cargo feature) with REFERENCE_PRICE.
 */
import { PublicKey } from "@solana/web3.js";
import { HermesClient } from "@pythnetwork/hermes-client";
import {
  PRO_COMPATIBLE_PUSH_ORACLE_PROGRAM_ID,
  PRO_COMPATIBLE_RECEIVER_PROGRAM_ID,
  PRO_COMPATIBLE_WORMHOLE_PROGRAM_ID,
  PythSolanaReceiver,
} from "@pythnetwork/pyth-solana-receiver";
import { Ctx } from "./config";
import { mockPricePda, setMockPrice } from "./arcium";
import type { Market, MarketDef } from "./markets";

/** Upgraded receiver program; mirrors PYTH_RECEIVER_PROGRAM_ID in oracle.rs. */
export const PYTH_RECEIVER_PROGRAM = new PublicKey(
  "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp"
);

/** Mirrors MAX_PRICE_AGE_SECS in programs/darkpool/src/oracle.rs. */
export const ON_CHAIN_MAX_AGE_SEC = 60;

/** Hermes endpoint used to fetch signed price updates for posting. */
export const HERMES_URL =
  process.env.HERMES_URL ?? "https://hermes.pyth.network";
/**
 * Hermes requires an API key since the Pyth Core upgrade (Aug 2026); sign up
 * at Pyth Terminal. Without one the coordinator cannot refresh any feed and
 * can only wait for Pyth's sponsored SOL/USD pushes (PYTH_WAIT_FRESH_SEC).
 */
export const HERMES_API_KEY = process.env.HERMES_API_KEY ?? "";
/** How long to wait for a sponsored feed when refreshing is not possible. */
export const WAIT_FRESH_SEC = Number(process.env.PYTH_WAIT_FRESH_SEC ?? 240);
/**
 * Use the on-chain account as is while it is at most this old; leaves
 * headroom for the match_orders tx to land inside the on-chain 60 s window.
 */
export const SPONSORED_MAX_AGE_SEC = Number(
  process.env.PYTH_SPONSORED_MAX_AGE_SEC ?? 30
);
const PRIORITY_FEE = {
  computeUnitPriceMicroLamports: 50_000,
  tightComputeBudget: true,
};

export type PriceSource = "pyth" | "mock";

export interface ReferencePrice {
  /** USDC per base unit, 6 decimals, as the circuit and escrow sizing expect. 0 = unknown. */
  price: bigint;
  human: string;
  source: PriceSource;
  /** Unix seconds the oracle published this price (mock: now; unknown: 0). */
  publishTime: number;
  /** Pyth confidence interval in the same 6-dp units (mock: 0). */
  conf: bigint;
  /** Account `match_orders` must be given. */
  account: PublicKey;
  note?: string;
}

export function configuredSource(): PriceSource {
  return (process.env.PRICE_SOURCE ?? "mock").toLowerCase() === "pyth"
    ? "pyth"
    : "mock";
}

export function fmt6(v: bigint): string {
  const s = v.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

/** Scale a Pyth (price, expo) pair to 6 decimals. */
export function pythToMicro(price: bigint, expo: number): bigint {
  const shift = expo + 6;
  return shift >= 0
    ? price * 10n ** BigInt(shift)
    : price / 10n ** BigInt(-shift);
}

/**
 * Parse a pyth-solana-receiver PriceUpdateV2 account.
 * Layout: 8 discriminator | 32 write_authority | verification_level
 * (1 byte tag; tag 0 = Partial carries 1 extra byte) | PriceFeedMessage
 * { feed_id[32], price i64, conf u64, exponent i32, publish_time i64,
 *   prev_publish_time i64, ema_price i64, ema_conf u64 } | posted_slot u64
 */
export function parsePriceUpdateV2(data: Buffer) {
  let off = 8 + 32;
  const tag = data.readUInt8(off);
  off += tag === 0 ? 2 : 1;
  const feedId = data.subarray(off, off + 32).toString("hex");
  off += 32;
  const price = data.readBigInt64LE(off);
  off += 8;
  const conf = data.readBigUInt64LE(off);
  off += 8;
  const expo = data.readInt32LE(off);
  off += 4;
  const publishTime = Number(data.readBigInt64LE(off));
  return { feedId, price, conf, expo, publishTime };
}

/** The account `match_orders` is given for a market under the configured source. */
export function priceAccountFor(ctx: Ctx, m: Market): PublicKey {
  return configuredSource() === "pyth"
    ? m.priceAccount
    : mockPricePda(ctx, m.def.feedId);
}

export function ageSec(r: ReferencePrice): number {
  return r.publishTime ? Math.floor(Date.now() / 1000) - r.publishTime : Infinity;
}

async function readPriceAccount(
  ctx: Ctx,
  m: Market,
  account: PublicKey,
  source: PriceSource
): Promise<ReferencePrice> {
  const info = await ctx.connection.getAccountInfo(account, "confirmed");
  if (!info)
    throw new Error(
      `${m.symbol} price account ${account.toBase58()} does not exist on ${ctx.cluster}`
    );
  if (source === "pyth" && !info.owner.equals(PYTH_RECEIVER_PROGRAM))
    throw new Error("Pyth account has unexpected owner");
  if (source === "mock" && !info.owner.equals(ctx.darkpool.programId))
    throw new Error("mock price account has unexpected owner");
  const p = parsePriceUpdateV2(info.data);
  if (p.feedId !== m.def.feedId)
    throw new Error(`unexpected feed id ${p.feedId} (want ${m.def.feedId})`);
  if (p.price <= 0n) throw new Error("price is not positive");
  const price = pythToMicro(p.price, p.expo);
  return {
    price,
    human: fmt6(price),
    source,
    publishTime: p.publishTime,
    conf: pythToMicro(p.conf, p.expo),
    account,
  };
}

/** Read a market's Pyth account (display only; the program re-reads it on-chain). */
export async function fetchPythPrice(ctx: Ctx, m: Market): Promise<ReferencePrice> {
  const r = await readPriceAccount(ctx, m, m.priceAccount, "pyth");
  const age = ageSec(r);
  if (age > ON_CHAIN_MAX_AGE_SEC)
    r.note = `Pyth price is ${age}s old; match_orders will reject it until the feed updates`;
  return r;
}

function receiverFor(ctx: Ctx): PythSolanaReceiver {
  // The receiver SDK bundles its own Anchor; the wallet/connection shapes are
  // identical, only the nominal types differ.
  // Upgraded (pro-compatible) program ids: Hermes payloads only verify on
  // the contract generation that serves them.
  return new PythSolanaReceiver({
    connection: ctx.connection as any,
    wallet: ctx.provider.wallet as any,
    receiverProgramId: PRO_COMPATIBLE_RECEIVER_PROGRAM_ID,
    wormholeProgramId: PRO_COMPATIBLE_WORMHOLE_PROGRAM_ID,
    pushOracleProgramId: PRO_COMPATIBLE_PUSH_ORACLE_PROGRAM_ID,
  });
}

/**
 * Pull the latest signed update for the market's feed from Hermes and write
 * it into the push-oracle account (shard `def.shard`) through the Pyth
 * receiver (Wormhole-verified, VerificationLevel::Full). The account is a
 * PDA, so it keeps its address across refreshes and its rent (~0.003 SOL)
 * is paid once. Anyone may call this for any feed; the on-chain program
 * only accepts updates newer than the stored one.
 */
export async function refreshPythFeed(ctx: Ctx, m: Market): Promise<void> {
  if (!HERMES_API_KEY)
    throw new Error("HERMES_API_KEY is not set; cannot refresh a Pyth feed");
  const hermes = new HermesClient(HERMES_URL, { accessToken: HERMES_API_KEY });
  const latest = await hermes.getLatestPriceUpdates(["0x" + m.def.feedId], {
    encoding: "base64",
  });
  const receiver = receiverFor(ctx);
  const builder = receiver.newTransactionBuilder({
    closeUpdateAccounts: true,
  });
  await builder.addUpdatePriceFeed(latest.binary.data, m.def.shard);
  const txs = await builder.buildVersionedTransactions(PRIORITY_FEE);
  await receiver.provider.sendAll(txs, { commitment: "confirmed" });
}

/**
 * No Hermes key: poll a sponsored account until it is fresh enough or
 * WAIT_FRESH_SEC elapses.
 */
async function waitForSponsored(
  ctx: Ctx,
  m: Market,
  initialAge: number
): Promise<ReferencePrice> {
  const deadline = Date.now() + WAIT_FRESH_SEC * 1000;
  console.log(
    `${m.symbol}: sponsored Pyth feed is ${initialAge}s old and HERMES_API_KEY is not set; ` +
      `waiting up to ${WAIT_FRESH_SEC}s for a push`
  );
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const r = await fetchPythPrice(ctx, m);
    const age = ageSec(r);
    if (age <= SPONSORED_MAX_AGE_SEC) {
      r.note = `waited for the sponsored feed (was ${initialAge}s old)`;
      return r;
    }
  }
  throw new Error(
    `${m.symbol}: Pyth sponsored feed stayed stale for ${WAIT_FRESH_SEC}s. Set HERMES_API_KEY ` +
      `(Pyth Terminal) so the coordinator can refresh feeds itself.`
  );
}

/**
 * Make sure the market's price account exists and is fresh, and return its
 * value. Pyth: the push account as is if fresh, otherwise refreshed from
 * Hermes (or, for a sponsored feed without a key, waited for). Mock:
 * (re)writes the mock account with REFERENCE_PRICE and a fresh publish time,
 * which only a `mock-oracle` build (localnet) accepts.
 */
export async function ensureReferencePrice(ctx: Ctx, m: Market): Promise<ReferencePrice> {
  if (configuredSource() === "pyth") {
    let current: ReferencePrice | null = null;
    try {
      current = await fetchPythPrice(ctx, m);
    } catch {
      current = null; // account not created yet (first refresh creates it)
    }
    const age = current ? ageSec(current) : Infinity;
    if (current && age <= SPONSORED_MAX_AGE_SEC) return current;
    if (!HERMES_API_KEY) {
      if (m.def.sponsored && current) return waitForSponsored(ctx, m, age);
      throw new Error(
        `${m.symbol}: no fresh Pyth price on ${ctx.cluster} and no HERMES_API_KEY to refresh ` +
          `${m.priceAccount.toBase58()}. ${m.def.name} is not sponsored on devnet; set ` +
          `HERMES_API_KEY (https://pythdata.app/signup) so the coordinator can push updates itself.`
      );
    }
    await refreshPythFeed(ctx, m);
    const fresh = await fetchPythPrice(ctx, m);
    fresh.note = current
      ? `feed was ${age}s old; refreshed from Hermes`
      : "price account created from a Hermes update";
    if (ageSec(fresh) > ON_CHAIN_MAX_AGE_SEC)
      throw new Error(
        `${m.symbol}: Hermes' latest update is ${ageSec(fresh)}s old` +
          (m.def.kind !== "crypto" ? " (market closed?)" : "") +
          "; the program would reject it"
      );
    return fresh;
  }
  try {
    await setMockPrice(ctx, m.def.feedId, ctx.referencePrice);
  } catch (e: any) {
    throw new Error(
      `PRICE_SOURCE=mock needs a darkpool build with the mock-oracle feature (localnet). ` +
        `On devnet set PRICE_SOURCE=pyth. Underlying error: ${e?.message ?? e}`
    );
  }
  return readPriceAccount(ctx, m, mockPricePda(ctx, m.def.feedId), "mock");
}

/** Display path: never throws. Unknown price => price 0n with a note. */
export async function getReferencePrice(ctx: Ctx, m: Market): Promise<ReferencePrice> {
  try {
    if (configuredSource() === "pyth") return await fetchPythPrice(ctx, m);
    const pda = mockPricePda(ctx, m.def.feedId);
    const info = await ctx.connection.getAccountInfo(pda, "confirmed");
    if (info) return await readPriceAccount(ctx, m, pda, "mock");
    return unknown(ctx, m, "mock price account not written yet");
  } catch (e: any) {
    return unknown(ctx, m, `price unavailable: ${e?.message ?? e}`);
  }
}

function unknown(ctx: Ctx, m: Market, note: string): ReferencePrice {
  return {
    price: 0n,
    human: "0.000000",
    source: configuredSource(),
    publishTime: 0,
    conf: 0n,
    account: priceAccountFor(ctx, m),
    note,
  };
}

// ---------------------------------------------------------------- market hours

export interface MarketHours {
  isOpen: boolean;
  nextOpen: number | null;
  nextClose: number | null;
  fetchedAt: number;
}

const hoursCache = new Map<string, MarketHours>();

/**
 * Trading schedule from Hermes' public feed listing (no API key needed).
 * Equity, metal and FX feeds only publish while their market is open, so
 * outside those hours the on-chain staleness check makes the market untradable.
 */
export async function getMarketHours(def: MarketDef): Promise<MarketHours> {
  if (def.kind === "crypto")
    return { isOpen: true, nextOpen: null, nextClose: null, fetchedAt: Date.now() };
  const cached = hoursCache.get(def.feedId);
  if (cached && Date.now() - cached.fetchedAt < 5 * 60_000) return cached;
  // Keep any path prefix (e.g. https://pyth.dourolabs.app/hermes).
  const q = new URLSearchParams({
    query: def.hermesQuery.query,
    asset_type: def.hermesQuery.assetType,
  });
  const res = await fetch(`${HERMES_URL.replace(/\/$/, "")}/v2/price_feeds?${q}`);
  if (!res.ok) throw new Error(`Hermes price_feeds ${res.status}`);
  const list = (await res.json()) as {
    id: string;
    market_hours?: { is_open: boolean; next_open: number | null; next_close: number | null };
  }[];
  const row = list.find((r) => r.id === def.feedId);
  if (!row?.market_hours) throw new Error(`feed ${def.feedId} not in Hermes listing`);
  const h: MarketHours = {
    isOpen: row.market_hours.is_open,
    nextOpen: row.market_hours.next_open,
    nextClose: row.market_hours.next_close,
    fetchedAt: Date.now(),
  };
  hoursCache.set(def.feedId, h);
  return h;
}
