/**
 * Batch coordinator, one independent batch engine per market.
 *
 * Parties connect their own wallet in the browser, encrypt their whole order
 * {side, price, qty} client-side with the MXE public key, commit to that
 * ciphertext in their escrow deposit, and sign the deposit themselves. This
 * server only ever sees ciphertext and cannot substitute orders: the darkpool
 * program checks the ciphertexts it is given against the on-chain
 * commitments. Per market it:
 *   - opens a batch on the first order and runs a 30 s window
 *   - builds unsigned deposit transactions for wallets to sign
 *   - when the window closes with two parties, queues the MXE (passing the
 *     market's Pyth price account, which the program validates on-chain
 *     against the feed registered for the pool), awaits the callback and
 *     settles (or refunds)
 *   - streams batch state to all browsers over Server-Sent Events
 *
 * It does not know which party is buying or how much until the MXE reveals
 * the fill.
 *
 * Endpoints
 *   GET  /status                 config + MXE pubkey + markets + current batches
 *   GET  /events                 SSE stream: { now, markets: { SOL: state, XAU: state } }
 *   GET  /balance/:wallet        SOL + every mock token balance
 *   POST /faucet  {wallet}       fund a wallet with SOL for fees + all mock tokens (demo)
 *   POST /order/prepare {wallet, commitment, market}
 *        -> {batchId, market, solBucket, usdcBucket, closesAt, tx}  (base64 unsigned deposit tx)
 *   POST /order/submit  {batchId, wallet, signedTx, enc:{pubkey,nonce,ciphertexts}}
 *   GET  /history?market=SOL     last results
 *   GET  /trades?market=SOL      on-chain trade book (all markets without the filter)
 */
import express from "express";
import cors from "cors";
import { getTradeBook, invalidateTradeBook } from "./tradebook";
import * as anchor from "@anchor-lang/core";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  ctxFromEnv,
  readDeployment,
  explorerAddress,
} from "../scripts/lib/config";
import {
  getMXEPublicKeyWithRetry,
  EncryptedOrder,
  encryptedOrderFromWire,
  orderCommitment,
} from "../scripts/lib/arcium";
import {
  buildDepositTx,
  cancel,
  createBatch,
  Payouts,
} from "../scripts/lib/settlement";
import {
  finishBatch,
  bucketsFor,
  ESCROW_BOUND_PCT,
  Step,
  BatchOutput,
} from "../scripts/lib/flow";
import {
  fmt,
  fundSol,
  mintToWallet,
  tokenBalance,
} from "../scripts/lib/tokens";
import {
  ageSec,
  getMarketHours,
  getReferencePrice,
  configuredSource,
  refreshPythFeed,
  HERMES_API_KEY,
  MarketHours,
  ON_CHAIN_MAX_AGE_SEC,
  ReferencePrice,
} from "../scripts/lib/price";
import {
  bucketLamports,
  ensureMarkets,
  loadMarkets,
  Market,
  marketBySymbol,
} from "../scripts/lib/markets";

const ctx = ctxFromEnv();
const dep = readDeployment();
const markets = loadMarkets(ctx, dep);
if (!markets.length)
  throw new Error("no market has a mint in deployment.json; run `yarn setup:tokens`");
const usdcMint = new PublicKey(dep.usdcMint);
const WINDOW_MS = Number(process.env.BATCH_WINDOW_MS ?? 30_000);
const PREPARE_TTL_MS = 90_000;
/** Keep a self-maintained (non-sponsored) feed this fresh while its market is open. */
const SELF_REFRESH_MS = Number(process.env.PYTH_SELF_REFRESH_MS ?? 45_000);

type Phase =
  | "idle"
  | "collecting"
  | "matching"
  | "settled"
  | "cancelled"
  | "error";

interface Order {
  wallet: string;
  payout: string;
  enc: EncryptedOrder;
  depositSig: string;
  at: number;
}
interface Reservation {
  wallet: string;
  commitment: string; // hex
  expires: number;
}
interface Batch {
  id: anchor.BN;
  idStr: string;
  solBucket: bigint;
  usdcBucket: bigint;
  reference: ReferencePrice;
  openedAt: number;
  closesAt: number;
  createSig: string;
  /** Slot order = deposit order; nothing here says who buys or sells. */
  orders: Order[];
  reserved: Reservation[];
  timer?: NodeJS.Timeout;
}

interface MarketState {
  symbol: string;
  phase: Phase;
  windowMs: number;
  now: number;
  price: {
    source: string;
    human: string;
    publishTime: number;
    note?: string;
    boundPct: string;
    account: string;
  };
  hours: { isOpen: boolean; nextOpen: number | null; nextClose: number | null };
  /** Whether a batch opened now could be matched (fresh or refreshable price). */
  tradable: boolean;
  untradableReason?: string;
  tier: { solBucket: string; solBucketLamports: string };
  batch?: {
    id: string;
    closesAt: number;
    referencePrice: string;
    solBucket: string;
    usdcBucket: string;
    parties: { wallet: string; depositSig: string }[];
    reserved: string[];
  };
  steps: Step[];
  result?: Record<string, unknown>;
  error?: string;
}

let mxePublicKey: Uint8Array;

/** One batch pipeline. Markets never share a batch. */
class Engine {
  phase: Phase = "idle";
  batch: Batch | null = null;
  steps: Step[] = [];
  result: Record<string, unknown> | undefined;
  lastError: string | undefined;
  history: Record<string, unknown>[] = [];
  latestPrice: ReferencePrice = {
    price: 0n,
    human: "0.000000",
    source: configuredSource(),
    publishTime: 0,
    conf: 0n,
    account: PublicKey.default,
    note: "starting",
  };
  hours: MarketHours = { isOpen: true, nextOpen: null, nextClose: null, fetchedAt: 0 };

  /** Collateral tier in base lamports: per market, so gold's tier can be 0.1 oz. */
  readonly bucket: bigint;

  constructor(public m: Market) {
    this.bucket = bucketLamports(m.def);
  }

  get symbol() {
    return this.m.symbol;
  }

  /** Refresh the displayed reference; each batch snapshots it at open. */
  async refreshPrice() {
    try {
      this.latestPrice = await getReferencePrice(ctx, this.m);
    } catch (e) {
      console.warn(`${this.symbol}: price refresh failed`, e);
    }
    try {
      this.hours = await getMarketHours(this.m.def);
    } catch (e: any) {
      console.warn(`${this.symbol}: market hours lookup failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Non-sponsored feeds (equities) have nobody but us pushing updates: keep
   * the on-chain account live while the exchange is open so the ticker is
   * current and a batch can close inside the 60 s window.
   */
  async selfRefresh() {
    if (configuredSource() !== "pyth" || this.m.def.sponsored || !HERMES_API_KEY) return;
    if (!this.hours.isOpen) return;
    if (ageSec(this.latestPrice) <= SELF_REFRESH_MS / 1000 - 5) return;
    try {
      await refreshPythFeed(ctx, this.m);
      this.latestPrice = await getReferencePrice(ctx, this.m);
    } catch (e: any) {
      console.warn(`${this.symbol}: feed refresh failed: ${e?.message ?? e}`);
    }
  }

  assess(): { tradable: boolean; reason?: string } {
    const p = this.latestPrice;
    const age = ageSec(p);
    if (this.phase === "collecting" || this.phase === "matching") return { tradable: true };
    if (age <= ON_CHAIN_MAX_AGE_SEC) return { tradable: true };
    const refreshable = configuredSource() !== "pyth" || this.m.def.sponsored || !!HERMES_API_KEY;
    if (p.price === 0n && !refreshable)
      return {
        tradable: false,
        reason: `No ${this.symbol}/USD price on ${ctx.cluster} yet. ${this.m.def.name} is not sponsored by Pyth on devnet; the coordinator needs HERMES_API_KEY to push one.`,
      };
    if (!refreshable)
      return {
        tradable: false,
        reason: `Reference is ${age}s old and the coordinator has no HERMES_API_KEY to refresh it.`,
      };
    if (this.m.def.kind !== "crypto" && !this.hours.isOpen)
      return {
        tradable: false,
        reason: `${this.m.def.name} is not trading: the ${this.symbol}/USD feed only publishes while its market is open${
          this.hours.nextOpen ? ` (opens ${new Date(this.hours.nextOpen * 1000).toUTCString()})` : ""
        }.`,
      };
    return { tradable: true };
  }

  state(now = Date.now()): MarketState {
    const batch = this.batch;
    const b = batch
      ? {
          id: batch.idStr,
          closesAt: batch.closesAt,
          referencePrice: batch.reference.human,
          solBucket: fmt(batch.solBucket, 9),
          usdcBucket: fmt(batch.usdcBucket, 6),
          parties: batch.orders.map((o) => ({
            wallet: o.wallet,
            depositSig: o.depositSig,
          })),
          reserved: batch.reserved
            .filter(
              (r) =>
                r.expires > now &&
                !batch.orders.some((o) => o.wallet === r.wallet)
            )
            .map((r) => r.wallet),
        }
      : undefined;
    const a = this.assess();
    return {
      symbol: this.symbol,
      phase: this.phase,
      windowMs: WINDOW_MS,
      now,
      price: {
        source: this.latestPrice.source,
        human: this.latestPrice.human,
        publishTime: this.latestPrice.publishTime,
        note: this.latestPrice.note,
        boundPct: ESCROW_BOUND_PCT.toString(),
        account: this.latestPrice.account.toBase58(),
      },
      hours: { isOpen: this.hours.isOpen, nextOpen: this.hours.nextOpen, nextClose: this.hours.nextClose },
      tradable: a.tradable,
      untradableReason: a.reason,
      tier: {
        solBucket: fmt(this.bucket, 9),
        solBucketLamports: this.bucket.toString(),
      },
      batch: b,
      steps: this.steps,
      result: this.result,
      error: this.lastError,
    };
  }

  serialize(o: BatchOutput, b: Batch) {
    const [a, bb] = b.orders;
    const buyer = o.matched ? (o.aIsBuyer ? a.wallet : bb.wallet) : undefined;
    const seller = o.matched ? (o.aIsBuyer ? bb.wallet : a.wallet) : undefined;
    return {
      market: this.symbol,
      batchId: o.batchId,
      matched: o.matched,
      qty: fmt(o.qty, 9),
      referencePrice: fmt(o.referencePrice, 6),
      priceSource: b.reference.source,
      clearingPrice: o.clearingPrice.toString(),
      clearingPriceHuman: fmt(o.clearingPrice, 6),
      usdcPaid: o.usdcPaid.toString(),
      usdcPaidHuman: fmt(o.usdcPaid, 6),
      matchResult: o.matchResult,
      matchResultExplorer: o.matchResultExplorer,
      settleExplorer: o.settleExplorer,
      cancelSig: o.cancelSig,
      parties: b.orders.map((x) => x.wallet),
      buyer,
      seller,
      finishedAt: Date.now(),
    };
  }

  async openBatch(): Promise<Batch> {
    const a = this.assess();
    if (!a.tradable) throw new Error(a.reason);
    const id = new anchor.BN(Date.now());
    const reference = await getReferencePrice(ctx, this.m);
    if (reference.price === 0n)
      throw new Error(`${this.symbol}: ${reference.note ?? "no reference price"}`);
    this.latestPrice = reference;
    const { solBucket, usdcBucket } = bucketsFor(this.bucket, reference.price);
    const createSig = await createBatch(ctx, id, this.m.mints, solBucket, usdcBucket);
    const now = Date.now();
    const b: Batch = {
      id,
      idStr: id.toString(),
      solBucket,
      usdcBucket,
      reference,
      openedAt: now,
      closesAt: now + WINDOW_MS,
      createSig,
      orders: [],
      reserved: [],
    };
    b.timer = setTimeout(
      () => this.closeBatch(b).catch((e) => console.error(`${this.symbol} closeBatch`, e)),
      WINDOW_MS
    );
    this.batch = b;
    this.phase = "collecting";
    this.steps = [];
    this.result = undefined;
    this.lastError = undefined;
    console.log(
      `${this.symbol} batch ${b.idStr} opened buckets=${solBucket}/${usdcBucket} ref=${reference.human} (${reference.source}) window=${WINDOW_MS}ms create=${createSig}`
    );
    broadcast();
    return b;
  }

  async closeBatch(b: Batch) {
    if (this.batch !== b || this.phase !== "collecting") return;
    const push = (s: Step) => {
      this.steps.push(s);
      broadcast();
    };

    if (b.orders.length < 2) {
      this.phase = "cancelled";
      push({
        name: "cancel",
        status: "running",
        detail: `window closed with ${b.orders.length} of 2 parties: refunding`,
        at: Date.now(),
      });
      try {
        const payouts: Payouts = [
          b.orders[0] ? new PublicKey(b.orders[0].payout) : ctx.payer.publicKey,
          b.orders[1] ? new PublicKey(b.orders[1].payout) : ctx.payer.publicKey,
        ];
        const sig = await cancel(ctx, b.id, this.m.mints, null, payouts);
        push({
          name: "cancel",
          status: "done",
          sig,
          detail: "collateral refunded",
          at: Date.now(),
        });
        this.result = {
          market: this.symbol,
          batchId: b.idStr,
          matched: false,
          reason: "incomplete",
          cancelSig: sig,
          parties: b.orders.map((o) => o.wallet),
          finishedAt: Date.now(),
        };
      } catch (e: any) {
        this.phase = "error";
        this.lastError = String(e?.message ?? e);
        push({
          name: "cancel",
          status: "error",
          detail: this.lastError,
          at: Date.now(),
        });
      }
      invalidateTradeBook();
      this.history.unshift(this.result ?? { market: this.symbol, batchId: b.idStr, error: this.lastError });
      broadcast();
      return;
    }

    this.phase = "matching";
    broadcast();
    try {
      const [a, bb] = b.orders;
      const out = await finishBatch(
        ctx,
        this.m,
        b.id,
        a.enc,
        bb.enc,
        [new PublicKey(a.payout), new PublicKey(bb.payout)],
        push,
        this.steps
      );
      this.result = this.serialize(out, b);
      this.phase = out.matched ? "settled" : "cancelled";
      invalidateTradeBook();
      this.history.unshift(this.result);
      console.log(
        `${this.symbol} batch ${b.idStr} ${this.phase} price=${out.clearingPrice} qty=${out.qty}`
      );
    } catch (e: any) {
      this.phase = "error";
      this.lastError = String(e?.message ?? e);
      const last = this.steps[this.steps.length - 1];
      push({
        name: last?.name ?? "queue_mxe",
        status: "error",
        detail: this.lastError,
        at: Date.now(),
      });
      console.error(`${this.symbol} batch ${b.idStr} error`, e);
    }
    broadcast();
  }
}

const engines = new Map<string, Engine>(markets.map((m) => [m.symbol, new Engine(m)]));
function engineFor(symbol: unknown): Engine {
  return engines.get(marketBySymbol(markets, symbol).symbol)!;
}
function engineByBatch(batchId: unknown): Engine | undefined {
  for (const e of engines.values()) if (e.batch?.idStr === batchId) return e;
  return undefined;
}

// ---------------------------------------------------------------- SSE
const clients = new Set<express.Response>();
function publicState() {
  const now = Date.now();
  const out: Record<string, MarketState> = {};
  for (const e of engines.values()) out[e.symbol] = e.state(now);
  return { now, markets: out };
}
function broadcast() {
  const data = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) res.write(data);
}

function marketInfo(e: Engine) {
  const m = e.m;
  return {
    symbol: m.symbol,
    name: m.def.name,
    kind: m.def.kind,
    baseMint: m.mints.solMint.toBase58(),
    pool: m.pool.toBase58(),
    marketConfig: m.marketConfig.toBase58(),
    feedId: m.def.feedId,
    priceAccount: m.priceAccount.toBase58(),
    sponsored: m.def.sponsored,
    solBucket: fmt(bucketLamports(m.def), 9),
  };
}

// ---------------------------------------------------------------- HTTP
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/status", (_req, res) => {
  res.json({
    cluster: ctx.cluster,
    clusterOffset: ctx.clusterOffset,
    configuredPriceSource: configuredSource(),
    hermesConfigured: !!HERMES_API_KEY,
    escrowBoundPct: ESCROW_BOUND_PCT.toString(),
    solBucket: fmt(bucketLamports(markets[0].def), 9),
    windowMs: WINDOW_MS,
    mxePublicKey: Buffer.from(mxePublicKey).toString("hex"),
    programs: {
      darkpool: ctx.darkpool.programId.toBase58(),
      settlement: ctx.settlement.programId.toBase58(),
    },
    usdcMint: dep.usdcMint,
    markets: [...engines.values()].map(marketInfo),
    state: publicState(),
  });
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(publicState())}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

app.get("/history", (req, res) => {
  try {
    const rows = req.query.market
      ? engineFor(req.query.market).history
      : [...engines.values()]
          .flatMap((e) => e.history)
          .sort((a, b) => Number(b.finishedAt ?? 0) - Number(a.finishedAt ?? 0));
    res.json(rows.slice(0, 20));
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});
app.get("/trades", async (req, res) => {
  try {
    const book = await getTradeBook(ctx, markets);
    if (!req.query.market) return res.json(book);
    const sym = marketBySymbol(markets, req.query.market).symbol;
    res.json({ ...book, trades: book.trades.filter((t) => t.market === sym) });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get("/balance/:wallet", async (req, res) => {
  try {
    const w = new PublicKey(req.params.wallet);
    const [lamports, usdc, ...bases] = await Promise.all([
      ctx.connection.getBalance(w),
      tokenBalance(ctx, usdcMint, w),
      ...markets.map((m) => tokenBalance(ctx, m.mints.solMint, w)),
    ]);
    const baseOut: Record<string, string> = {};
    markets.forEach((m, i) => (baseOut[m.symbol] = fmt(bases[i], 9)));
    res.json({
      wallet: w.toBase58(),
      sol: (lamports / 1e9).toFixed(4),
      solMock: baseOut.SOL ?? "0.000000000",
      usdcMock: fmt(usdc, 6),
      bases: baseOut,
      explorer: explorerAddress(w, ctx.cluster),
    });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

/** Demo faucet: a little SOL for fees plus every mock token (every deposit needs the base and USDC). */
app.post("/faucet", async (req, res) => {
  try {
    const w = new PublicKey(req.body?.wallet);
    const sigs: string[] = [];
    const lamports = await ctx.connection.getBalance(w);
    if (lamports < 0.02e9) sigs.push(await fundSol(ctx, w, 0.03));
    const granted: Record<string, string> = {};
    for (const m of markets) {
      await mintToWallet(ctx, m.mints.solMint, w, 10n * 10n ** 9n);
      granted[m.symbol] = "10";
    }
    await mintToWallet(ctx, usdcMint, w, 5_000n * 10n ** 6n);
    res.json({
      ok: true,
      sigs,
      granted: {
        sol: lamports < 0.02e9 ? "0.03" : "0",
        ...granted,
        usdcMock: "5000",
      },
    });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

function parseCommitment(v: unknown): Buffer {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/i.test(v))
    throw new Error("commitment must be 32 bytes hex");
  return Buffer.from(v, "hex");
}

app.post("/order/prepare", async (req, res) => {
  try {
    const wallet = new PublicKey(req.body?.wallet);
    const commitment = parseCommitment(req.body?.commitment);
    const e = engineFor(req.body?.market);
    if (e.phase === "matching")
      throw new Error(`a ${e.symbol} batch is being matched; wait for it to finish`);

    let b = e.batch;
    if (!b || e.phase !== "collecting") {
      b = await e.openBatch();
    } else {
      if (b.orders.some((o) => o.wallet === wallet.toBase58()))
        throw new Error("this wallet already has an order in the batch");
      const live = b.reserved.filter(
        (r) => r.expires > Date.now() && r.wallet !== wallet.toBase58()
      );
      if (b.orders.length + live.length >= 2)
        throw new Error("this batch is full; wait for the next one");
      if (Date.now() > b.closesAt - 3000)
        throw new Error("batch window is closing; wait for the next one");
    }
    b.reserved = b.reserved.filter((r) => r.wallet !== wallet.toBase58());
    b.reserved.push({
      wallet: wallet.toBase58(),
      commitment: commitment.toString("hex"),
      expires: Date.now() + PREPARE_TTL_MS,
    });
    const tx = await buildDepositTx(
      ctx,
      b.id,
      e.m.mints,
      wallet,
      commitment,
      wallet /* Phase 3: stealth payout */
    );
    broadcast();
    res.json({
      batchId: b.idStr,
      market: e.symbol,
      solBucket: fmt(b.solBucket, 9),
      usdcBucket: fmt(b.usdcBucket, 6),
      closesAt: b.closesAt,
      tx,
    });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

app.post("/order/submit", async (req, res) => {
  try {
    const { batchId, wallet, signedTx, enc } = req.body ?? {};
    const e = engineByBatch(batchId);
    const batch = e?.batch;
    if (!e || !batch || e.phase !== "collecting")
      throw new Error("batch is no longer collecting");
    if (batch.orders.some((o) => o.wallet === wallet))
      throw new Error("this wallet already has an order in the batch");
    if (batch.orders.length >= 2) throw new Error("batch is full");
    const reservation = batch.reserved.find((r) => r.wallet === wallet);
    if (!reservation) throw new Error("call /order/prepare first");

    const order = encryptedOrderFromWire(enc);
    // The chain enforces this too (CommitmentMismatch at match time); failing
    // early here saves the party a deposit it would only get refunded.
    if (orderCommitment(order).toString("hex") !== reservation.commitment)
      throw new Error("ciphertext does not match the committed order");

    const raw = Buffer.from(signedTx, "base64");
    const tx = Transaction.from(raw);
    if (!tx.feePayer?.equals(new PublicKey(wallet)))
      throw new Error("fee payer mismatch");
    const sig = await ctx.connection.sendRawTransaction(raw, {
      skipPreflight: false,
    });
    await ctx.connection.confirmTransaction(sig, "confirmed");

    batch.orders.push({
      wallet,
      payout: wallet,
      enc: order,
      depositSig: sig,
      at: Date.now(),
    });
    batch.reserved = batch.reserved.filter((r) => r.wallet !== wallet);
    console.log(
      `${e.symbol} batch ${batch.idStr} party ${batch.orders.length} ${wallet} deposit=${sig}`
    );
    broadcast();
    res.json({ ok: true, depositSig: sig, closesAt: batch.closesAt });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

const port = Number(process.env.PORT ?? 8787);
(async () => {
  mxePublicKey = await getMXEPublicKeyWithRetry(ctx);
  const ensured = await ensureMarkets(ctx, markets);
  for (const e of engines.values()) await e.refreshPrice();
  // Timers start only once the MXE key and first prices are in hand; the
  // broadcast tick used to fire before startup finished and crash on an
  // undefined price (slow RPC / MXE retry).
  setInterval(() => {
    for (const e of engines.values()) e.refreshPrice().catch(() => {});
  }, 10_000);
  setInterval(() => {
    for (const e of engines.values()) e.selfRefresh().catch(() => {});
  }, SELF_REFRESH_MS);
  setInterval(broadcast, 1000);
  app.listen(port, () => {
    console.log(
      `darkpool coordinator on http://localhost:${port}  cluster=${ctx.cluster} offset=${ctx.clusterOffset} window=${WINDOW_MS}ms`
    );
    console.log(
      `tiers ${markets.map((m) => `${m.symbol} ${m.def.bucket}`).join(", ")}; USDC bucket = tier x ref x ${ESCROW_BOUND_PCT}%; hermes key ${
        HERMES_API_KEY ? "set" : "NOT set (only sponsored feeds can match)"
      }`
    );
    for (const e of engines.values()) {
      const r = ensured.find((x) => x.symbol === e.symbol);
      const a = e.assess();
      console.log(
        `  ${e.symbol}: pool ${r?.pool}${r?.poolSig ? " (created)" : ""}${
          r?.marketSig ? " market registered" : ""
        }; ref ${e.latestPrice.human} USDC from ${e.latestPrice.source} ${e.m.priceAccount.toBase58()}${
          e.latestPrice.note ? " (" + e.latestPrice.note + ")" : ""
        }; ${a.tradable ? "tradable" : "NOT tradable: " + a.reason}`
      );
    }
    console.log(
      `mxe x25519 pubkey ${Buffer.from(mxePublicKey).toString("hex")}`
    );
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
