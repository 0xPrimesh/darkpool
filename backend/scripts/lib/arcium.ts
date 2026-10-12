/**
 * Arcium helpers: comp-def registration, client-side order encryption and
 * commitments, queueing the match computation and waiting for the callback.
 */
import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import {
  awaitComputationFinalization,
  getArciumAccountBaseSeed,
  getArciumProgram,
  getArciumProgramId,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getLookupTableAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  RescueCipher,
  deserializeLE,
  uploadCircuit,
  x25519,
} from "@arcium-hq/client";
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Ctx, ROOT } from "./config";
import { batchPda } from "./settlement";

export const CIRCUIT = "match_orders_v2";

export async function getMXEPublicKeyWithRetry(
  ctx: Ctx,
  maxRetries = 30,
  delayMs = 1000
): Promise<Uint8Array> {
  let last: unknown = "MXE account has no x25519 key yet";
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const k = await getMXEPublicKey(ctx.provider, ctx.darkpool.programId);
      if (k) return k;
    } catch (e) {
      // MXE account may not be initialised yet on a fresh localnet, or the
      // RPC is rate limiting us; keep the last error for the final message.
      last = e;
    }
    if (i % 5 === 0)
      console.warn(
        `MXE key fetch attempt ${i}/${maxRetries} failed: ${
          (last as any)?.message ?? last
        }`
      );
    await new Promise((r) => setTimeout(r, delayMs));
  }
  const rpc = ctx.connection.rpcEndpoint.replace(/api-key=[^&]+/, "api-key=…");
  throw new Error(
    `Failed to fetch MXE x25519 public key for ${ctx.darkpool.programId.toBase58()} ` +
      `on ${ctx.cluster} (offset ${ctx.clusterOffset}) via ${rpc}: ` +
      `${
        (last as any)?.message ?? last
      }. Check RPC_URL / rate limits and that ` +
      "`arcium deploy` initialised the MXE."
  );
}

/** One-time per deployment: register the circuit and upload its bytecode. */
export async function initMatchOrdersCompDef(ctx: Ctx): Promise<string> {
  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset(CIRCUIT);
  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeed, ctx.darkpool.programId.toBuffer(), offset],
    getArciumProgramId()
  )[0];

  const arciumProgram = getArciumProgram(ctx.provider);
  const mxeAccount = getMXEAccAddress(ctx.darkpool.programId);
  const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
  const lutAddress = getLookupTableAddress(
    ctx.darkpool.programId,
    mxeAcc.lutOffsetSlot
  );

  // Idempotent: skip the init tx if the comp-def account already exists
  // (e.g. a previous run registered it but failed during the circuit upload).
  let sig = "already-initialised";
  const existing = await ctx.connection.getAccountInfo(compDefPDA);
  if (existing === null) {
    sig = await ctx.darkpool.methods
      .initMatchOrdersCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: ctx.payer.publicKey,
        mxeAccount,
        addressLookupTable: lutAddress,
      })
      .signers([ctx.payer])
      .rpc({ preflightCommitment: "confirmed", commitment: "confirmed" });
    console.log("comp def account created:", sig);
  } else {
    console.log("comp def account already exists, resuming circuit upload");
  }

  // uploadCircuit is resumable: it skips raw-circuit accounts that already
  // exist with sufficient size and finalizes the definition at the end.
  const raw = fs.readFileSync(path.join(ROOT, "build", `${CIRCUIT}.arcis`));
  await uploadCircuit(ctx.provider, CIRCUIT, ctx.darkpool.programId, raw, true);
  return sig;
}

// ---------------------------------------------------------------- orders

/** Plaintext order as the circuit sees it. */
export interface Order {
  isBuy: boolean;
  /** USDC 6 dp per whole base unit. */
  price: bigint;
  /** Base-mock units (9 dp). */
  qty: bigint;
}

/**
 * One party's encrypted order: ephemeral x25519 pubkey, nonce and the three
 * ciphertexts for `OrderInput { is_buy, price, qty }`, in circuit order.
 */
export interface EncryptedOrder {
  pubkey: number[]; // x25519 public key, 32 bytes
  nonce: anchor.BN; // u128
  ciphertexts: [number[], number[], number[]]; // [is_buy, price, qty], 32 bytes each
}

/** Wire form used by the HTTP API / browser (nonce as a decimal string). */
export interface EncryptedOrderWire {
  pubkey: number[];
  nonce: string;
  ciphertexts: number[][];
}

export function encryptedOrderFromWire(w: EncryptedOrderWire): EncryptedOrder {
  if (!Array.isArray(w?.pubkey) || w.pubkey.length !== 32)
    throw new Error("bad x25519 pubkey");
  if (
    !Array.isArray(w?.ciphertexts) ||
    w.ciphertexts.length !== 3 ||
    w.ciphertexts.some((c) => c.length !== 32)
  ) {
    throw new Error("expected 3 ciphertexts of 32 bytes");
  }
  return {
    pubkey: w.pubkey,
    nonce: new anchor.BN(String(w.nonce)),
    ciphertexts: [w.ciphertexts[0], w.ciphertexts[1], w.ciphertexts[2]],
  };
}

/**
 * Encrypt a whole order for the MXE. The e2e script and the test do this in
 * one process; the browser does the same in frontend/src/crypto.ts.
 */
export function encryptOrder(
  mxePublicKey: Uint8Array,
  order: Order
): EncryptedOrder {
  const sk = x25519.utils.randomSecretKey();
  const pk = x25519.getPublicKey(sk);
  const shared = x25519.getSharedSecret(sk, mxePublicKey);
  const cipher = new RescueCipher(shared);
  const nonce = randomBytes(16);
  const [ctSide, ctPrice, ctQty] = cipher.encrypt(
    [order.isBuy ? 1n : 0n, order.price, order.qty],
    nonce
  );
  return {
    pubkey: Array.from(pk),
    nonce: new anchor.BN(deserializeLE(nonce).toString()),
    ciphertexts: [Array.from(ctSide), Array.from(ctPrice), Array.from(ctQty)],
  };
}

/**
 * sha256(pubkey || nonce_le16 || ct_side || ct_price || ct_qty): what a party
 * records in the settlement Batch at deposit time and what the darkpool
 * program recomputes from the `match_orders` arguments.
 */
export function orderCommitment(enc: EncryptedOrder): Buffer {
  const h = createHash("sha256");
  h.update(Buffer.from(enc.pubkey));
  h.update(enc.nonce.toArrayLike(Buffer, "le", 16));
  for (const ct of enc.ciphertexts) h.update(Buffer.from(ct));
  return h.digest();
}

export function matchResultPda(ctx: Ctx, batchId: anchor.BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("match"), batchId.toArrayLike(Buffer, "le", 8)],
    ctx.darkpool.programId
  )[0];
}

/** `MarketConfig` PDA: which Pyth feed prices a settlement pool. */
export function marketPda(ctx: Ctx, pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), pool.toBuffer()],
    ctx.darkpool.programId
  )[0];
}

export function feedIdBytes(feedIdHex: string): Buffer {
  const b = Buffer.from(feedIdHex.replace(/^0x/, ""), "hex");
  if (b.length !== 32) throw new Error(`feed id must be 32 bytes: ${feedIdHex}`);
  return b;
}

/**
 * Register `pool` -> `feedId` once. If the market already exists its feed id
 * must be the one we expect; a mismatch means this pool was registered with
 * another feed and must not be traded against this market definition.
 */
export async function ensureMarket(
  ctx: Ctx,
  pool: PublicKey,
  feedIdHex: string
): Promise<{ market: PublicKey; sig?: string }> {
  const market = marketPda(ctx, pool);
  const feedId = feedIdBytes(feedIdHex);
  const existing = await ctx.darkpool.account.marketConfig.fetchNullable(market);
  if (existing) {
    const have = Buffer.from(existing.feedId as number[]).toString("hex");
    if (have !== feedId.toString("hex"))
      throw new Error(
        `pool ${pool.toBase58()} is registered with feed ${have}, expected ${feedIdHex}`
      );
    return { market };
  }
  const sig = await ctx.darkpool.methods
    .registerMarket(Array.from(feedId))
    .accountsPartial({
      payer: ctx.payer.publicKey,
      pool,
      market,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([ctx.payer])
    .rpc({ commitment: "confirmed" });
  return { market, sig };
}

export function mockPricePda(ctx: Ctx, feedIdHex: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mock_price"), feedIdBytes(feedIdHex)],
    ctx.darkpool.programId
  )[0];
}

/**
 * Localnet only: write a Pyth-shaped account for `feedId` owned by the
 * darkpool program. Fails with MockOracleDisabled on a build without
 * `mock-oracle`. `priceMicro` is USDC 6 dp per base unit; stored with
 * exponent -8 like Pyth.
 */
export async function setMockPrice(
  ctx: Ctx,
  feedIdHex: string,
  priceMicro: bigint,
  opts: { publishTime?: number; confBps?: number } = {}
): Promise<string> {
  const price = priceMicro * 100n; // 6 dp -> 8 dp
  const conf = (price * BigInt(opts.confBps ?? 5)) / 10_000n;
  const publishTime = opts.publishTime ?? Math.floor(Date.now() / 1000);
  return ctx.darkpool.methods
    .setMockPrice(
      Array.from(feedIdBytes(feedIdHex)),
      new anchor.BN(price.toString()),
      new anchor.BN(conf.toString()),
      -8,
      new anchor.BN(publishTime)
    )
    .accountsPartial({
      payer: ctx.payer.publicKey,
      mockPrice: mockPricePda(ctx, feedIdHex),
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([ctx.payer])
    .rpc({ commitment: "confirmed" });
}

export interface QueueResult {
  sig: string;
  computationOffset: anchor.BN;
  matchResult: PublicKey;
}

/**
 * Queue `match_orders` for a batch. `priceUpdate` is the Pyth PriceUpdateV2
 * account for the market's feed (or the mock PDA on localnet); the program
 * reads the reference price from it, so no price is passed here. `pool` is
 * the batch's settlement pool, whose `MarketConfig` names the feed.
 */
export async function queueMatch(
  ctx: Ctx,
  batchId: anchor.BN,
  a: EncryptedOrder,
  b: EncryptedOrder,
  priceUpdate: PublicKey,
  pool: PublicKey
): Promise<QueueResult> {
  const computationOffset = new anchor.BN(randomBytes(8), "hex");
  const matchResult = matchResultPda(ctx, batchId);

  const sig = await ctx.darkpool.methods
    .matchOrders(
      computationOffset,
      batchId,
      a.pubkey,
      a.nonce,
      a.ciphertexts[0],
      a.ciphertexts[1],
      a.ciphertexts[2],
      b.pubkey,
      b.nonce,
      b.ciphertexts[0],
      b.ciphertexts[1],
      b.ciphertexts[2]
    )
    .accountsPartial({
      payer: ctx.payer.publicKey,
      matchResult,
      batch: batchPda(ctx, batchId),
      market: marketPda(ctx, pool),
      priceUpdate,
      computationAccount: getComputationAccAddress(
        ctx.clusterOffset,
        computationOffset
      ),
      clusterAccount: getClusterAccAddress(ctx.clusterOffset),
      mxeAccount: getMXEAccAddress(ctx.darkpool.programId),
      mempoolAccount: getMempoolAccAddress(ctx.clusterOffset),
      executingPool: getExecutingPoolAccAddress(ctx.clusterOffset),
      compDefAccount: getCompDefAccAddress(
        ctx.darkpool.programId,
        Buffer.from(getCompDefAccOffset(CIRCUIT)).readUInt32LE()
      ),
    })
    .signers([ctx.payer])
    .rpc({ commitment: "confirmed" });

  return { sig, computationOffset, matchResult };
}

export interface MatchOutcome {
  finalizeSig: string;
  matched: boolean;
  clearingPrice: bigint;
  qty: bigint;
  aIsBuyer: boolean;
  /** Oracle reference the program verified on-chain when queueing. */
  referencePrice: bigint;
}

/** Wait for the MPC cluster to call back, then read the MatchResult PDA. */
export async function awaitMatch(
  ctx: Ctx,
  q: QueueResult
): Promise<MatchOutcome> {
  const finalizeSig = await awaitComputationFinalization(
    ctx.provider,
    q.computationOffset,
    ctx.darkpool.programId,
    "confirmed"
  );
  const acc = await ctx.darkpool.account.matchResult.fetch(
    q.matchResult,
    "confirmed"
  );
  if (!acc.finalized)
    throw new Error("MatchResult not finalized after callback");
  return {
    finalizeSig,
    matched: acc.matched,
    clearingPrice: BigInt(acc.clearingPrice.toString()),
    qty: BigInt(acc.qty.toString()),
    aIsBuyer: acc.aIsBuyer,
    referencePrice: BigInt(acc.referencePrice.toString()),
  };
}
