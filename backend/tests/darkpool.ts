/**
 * Localnet end-to-end test, run by `yarn test:local` (arcium build, then a
 * darkpool build with the `mock-oracle` feature, then `arcium test
 * --skip-build`, which spins up a Solana validator and a 2-node Arcium
 * cluster in Docker). The mock oracle is a Pyth-shaped account owned by the
 * darkpool program; the production build refuses it.
 *
 * Cases:
 *   1. bid 152 >= ask 148, ref 150 inside the spread -> matched @ 150, settled, balances netted
 *   2. bid 160 >= ask 158, ref 150 outside           -> matched @ 159 (midpoint)
 *   3. bid 148 <  ask 152                            -> not matched, both refunded
 *   4. two buys                                      -> not matched (side is inside the ciphertext)
 *   5. different quantities                          -> not matched (no partial fills)
 *   6. ciphertext != commitment                      -> match_orders rejected on-chain
 *   7. stale oracle                                  -> match_orders rejected on-chain
 *   8. another market's feed                         -> match_orders rejected on-chain
 *   9. settle twice                                  -> second settle rejected
 */
import * as anchor from "@anchor-lang/core";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import { ctxFromWorkspace } from "../scripts/lib/config";
import {
  encryptOrder,
  getMXEPublicKeyWithRetry,
  initMatchOrdersCompDef,
  mockPricePda,
  orderCommitment,
  queueMatch,
  setMockPrice,
} from "../scripts/lib/arcium";
import { createMints, mintToWallet, tokenBalance } from "../scripts/lib/tokens";
import { bucketsFor, runBatch, usdcPaidFor } from "../scripts/lib/flow";
import {
  createBatch,
  deposit,
  ensurePool,
  settle,
  Mints,
} from "../scripts/lib/settlement";
import { Market, MARKET_DEFS, pythPushAccount } from "../scripts/lib/markets";
import { marketPda } from "../scripts/lib/arcium";

process.env.PRICE_SOURCE = "mock";

describe("darkpool", () => {
  const ctx = ctxFromWorkspace();
  let mints: Mints;
  let market: Market;
  const SOL = MARKET_DEFS[0];
  const FEED = SOL.feedId;
  const buyer = Keypair.generate();
  const seller = Keypair.generate();

  const REF = 150_000_000n;
  const QTY = 1_000_000_000n; // 1 SOL-mock
  const buckets = bucketsFor(QTY, REF); // 1 SOL-mock + 187.5 USDC-mock per party
  const order = (kp: Keypair, isBuy: boolean, price: bigint, qty = QTY) => ({
    keypair: kp,
    order: { isBuy, price, qty },
  });

  const bal = async (kp: Keypair) => ({
    sol: await tokenBalance(ctx, mints.solMint, kp.publicKey),
    usdc: await tokenBalance(ctx, mints.usdcMint, kp.publicKey),
  });

  before(async () => {
    ctx.referencePrice = REF;
    for (const kp of [buyer, seller]) {
      const sig = await ctx.connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await ctx.connection.confirmTransaction(sig);
    }
    mints = await createMints(ctx);
    // Both parties hold both assets: every deposit escrows both buckets.
    for (const kp of [buyer, seller]) {
      await mintToWallet(ctx, mints.solMint, kp.publicKey, 10n * 10n ** 9n);
      await mintToWallet(
        ctx,
        mints.usdcMint,
        kp.publicKey,
        10_000n * 10n ** 6n
      );
    }
    const pool = (await ensurePool(ctx, mints)).pool;
    market = {
      def: SOL,
      symbol: SOL.symbol,
      mints,
      pool,
      marketConfig: marketPda(ctx, pool),
      priceAccount: pythPushAccount(SOL),
    };
    console.log("initialising match_orders comp def...");
    await initMatchOrdersCompDef(ctx);
  });

  it("matches a crossing bid/ask at the on-chain reference price and settles atomically", async () => {
    const b0 = await bal(buyer);
    const s0 = await bal(seller);

    const out = await runBatch(
      ctx,
      market,
      {
        a: order(buyer, true, 152_000_000n),
        b: order(seller, false, 148_000_000n),
        ...buckets,
      },
      (s) => console.log(`  [${s.status}] ${s.name} ${s.detail ?? ""}`)
    );

    expect(out.matched).to.equal(true);
    expect(out.clearingPrice).to.equal(REF);
    expect(out.referencePrice).to.equal(REF);
    expect(out.qty).to.equal(QTY);
    expect(out.aIsBuyer).to.equal(true);
    expect(out.settleSig).to.be.a("string");

    const b1 = await bal(buyer);
    const s1 = await bal(seller);
    const paid = usdcPaidFor(QTY, REF); // 150 USDC
    expect(b1.sol - b0.sol).to.equal(QTY);
    expect(b0.usdc - b1.usdc).to.equal(paid);
    expect(s0.sol - s1.sol).to.equal(QTY);
    expect(s1.usdc - s0.usdc).to.equal(paid);
  });

  it("clears at the midpoint when the reference price is outside the spread", async () => {
    // Seller deposits first this time: slot A is the seller.
    const out = await runBatch(ctx, market, {
      a: order(seller, false, 158_000_000n),
      b: order(buyer, true, 160_000_000n),
      ...buckets,
    });
    expect(out.matched).to.equal(true);
    expect(out.clearingPrice).to.equal(159_000_000n);
    expect(out.aIsBuyer).to.equal(false);
  });

  it("does not match when bid < ask and refunds both parties", async () => {
    const b0 = await bal(buyer);
    const s0 = await bal(seller);
    const out = await runBatch(ctx, market, {
      a: order(buyer, true, 148_000_000n),
      b: order(seller, false, 152_000_000n),
      ...buckets,
    });
    expect(out.matched).to.equal(false);
    expect(out.clearingPrice).to.equal(0n);
    expect(out.qty).to.equal(0n);
    expect(out.cancelSig).to.be.a("string");
    expect(await bal(buyer)).to.deep.equal(b0);
    expect(await bal(seller)).to.deep.equal(s0);
  });

  it("does not match two orders on the same side", async () => {
    const out = await runBatch(ctx, market, {
      a: order(buyer, true, 152_000_000n),
      b: order(seller, true, 148_000_000n),
      ...buckets,
    });
    expect(out.matched).to.equal(false);
    expect(out.cancelSig).to.be.a("string");
  });

  it("does not match orders of different size (no partial fills)", async () => {
    const out = await runBatch(ctx, market, {
      a: order(buyer, true, 152_000_000n),
      b: order(seller, false, 148_000_000n, QTY / 2n),
      ...buckets,
    });
    expect(out.matched).to.equal(false);
  });

  it("rejects match_orders when a ciphertext does not match the deposit commitment", async () => {
    await ensurePool(ctx, mints);
    const batchId = new anchor.BN(Date.now());
    await createBatch(
      ctx,
      batchId,
      mints,
      buckets.solBucket,
      buckets.usdcBucket
    );
    const mxePk = await getMXEPublicKeyWithRetry(ctx);
    const a = encryptOrder(mxePk, {
      isBuy: true,
      price: 152_000_000n,
      qty: QTY,
    });
    const b = encryptOrder(mxePk, {
      isBuy: false,
      price: 148_000_000n,
      qty: QTY,
    });
    await deposit(
      ctx,
      batchId,
      mints,
      buyer,
      orderCommitment(a),
      buyer.publicKey
    );
    await deposit(
      ctx,
      batchId,
      mints,
      seller,
      orderCommitment(b),
      seller.publicKey
    );
    await setMockPrice(ctx, FEED, REF);

    const forged = encryptOrder(mxePk, {
      isBuy: false,
      price: 1_000_000n,
      qty: QTY,
    }); // "sell at 1 USDC"
    let err = "";
    try {
      await queueMatch(ctx, batchId, a, forged, mockPricePda(ctx, FEED), market.pool);
    } catch (e: any) {
      err = String(e?.message ?? e);
    }
    expect(err).to.include("CommitmentMismatch");
  });

  it("rejects match_orders when the oracle price is stale", async () => {
    const batchId = new anchor.BN(Date.now());
    await createBatch(
      ctx,
      batchId,
      mints,
      buckets.solBucket,
      buckets.usdcBucket
    );
    const mxePk = await getMXEPublicKeyWithRetry(ctx);
    const a = encryptOrder(mxePk, {
      isBuy: true,
      price: 152_000_000n,
      qty: QTY,
    });
    const b = encryptOrder(mxePk, {
      isBuy: false,
      price: 148_000_000n,
      qty: QTY,
    });
    await deposit(
      ctx,
      batchId,
      mints,
      buyer,
      orderCommitment(a),
      buyer.publicKey
    );
    await deposit(
      ctx,
      batchId,
      mints,
      seller,
      orderCommitment(b),
      seller.publicKey
    );
    await setMockPrice(ctx, FEED, REF, {
      publishTime: Math.floor(Date.now() / 1000) - 600,
    });

    let err = "";
    try {
      await queueMatch(ctx, batchId, a, b, mockPricePda(ctx, FEED), market.pool);
    } catch (e: any) {
      err = String(e?.message ?? e);
    }
    expect(err).to.include("StalePrice");
    await setMockPrice(ctx, FEED, REF); // restore for later cases
  });

  it("rejects match_orders when the price account carries another market's feed", async () => {
    const batchId = new anchor.BN(Date.now());
    await createBatch(ctx, batchId, mints, buckets.solBucket, buckets.usdcBucket);
    const mxePk = await getMXEPublicKeyWithRetry(ctx);
    const a = encryptOrder(mxePk, { isBuy: true, price: 152_000_000n, qty: QTY });
    const b = encryptOrder(mxePk, { isBuy: false, price: 148_000_000n, qty: QTY });
    await deposit(ctx, batchId, mints, buyer, orderCommitment(a), buyer.publicKey);
    await deposit(ctx, batchId, mints, seller, orderCommitment(b), seller.publicKey);
    // A perfectly fresh, well-formed NVDA/USD account handed to a SOL batch.
    const NVDA = MARKET_DEFS[1].feedId;
    await setMockPrice(ctx, NVDA, 185_000_000n);

    let err = "";
    try {
      await queueMatch(ctx, batchId, a, b, mockPricePda(ctx, NVDA), market.pool);
    } catch (e: any) {
      err = String(e?.message ?? e);
    }
    expect(err).to.include("WrongFeed");
  });

  it("refuses to settle a batch twice", async () => {
    const out = await runBatch(ctx, market, {
      a: order(buyer, true, 152_000_000n),
      b: order(seller, false, 148_000_000n),
      ...buckets,
    });
    expect(out.matched).to.equal(true);
    let err = "";
    try {
      await settle(
        ctx,
        new anchor.BN(out.batchId),
        mints,
        new anchor.web3.PublicKey(out.matchResult),
        [buyer.publicKey, seller.publicKey]
      );
    } catch (e: any) {
      err = String(e?.message ?? e);
    }
    expect(err).to.include("BatchNotOpen");
  });
});
