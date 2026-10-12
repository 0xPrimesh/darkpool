/**
 * The end-to-end flow for one batch:
 *   ensure pool -> create batch -> encrypt both orders -> both deposit
 *   -> queue MXE (oracle account) -> await callback -> settle | cancel
 *
 * Reports progress through `onStep` so the script, the test and the API
 * server can all reuse it.
 */
import * as anchor from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Ctx, explorerTx, explorerAddress } from "./config";
import {
  awaitMatch,
  encryptOrder,
  EncryptedOrder,
  getMXEPublicKeyWithRetry,
  Order,
  orderCommitment,
  queueMatch,
} from "./arcium";
import {
  cancel,
  createBatch,
  deposit,
  ensurePool,
  settle,
  Payouts,
} from "./settlement";
import { ensureReferencePrice } from "./price";
import { ensureMarket } from "./arcium";
import type { Market } from "./markets";

export type StepName =
  | "ensure_pool"
  | "ensure_market"
  | "create_batch"
  | "encrypt"
  | "deposit_a"
  | "deposit_b"
  | "oracle"
  | "queue_mxe"
  | "await_mpc"
  | "settle"
  | "cancel";

export interface Step {
  name: StepName;
  status: "running" | "done" | "error";
  detail?: string;
  sig?: string;
  explorer?: string;
  at: number;
}

export interface PartyInput {
  keypair: Keypair;
  order: Order;
  /** Phase 1/2: the party's own wallet. Phase 3: a stealth destination. */
  payout?: PublicKey;
}

export interface BatchInput {
  a: PartyInput;
  b: PartyInput;
  /** Public collateral every party escrows, in both assets. */
  solBucket: bigint;
  usdcBucket: bigint;
}

export interface BatchOutput {
  batchId: string;
  matched: boolean;
  clearingPrice: bigint;
  qty: bigint;
  usdcPaid: bigint;
  /** Oracle reference verified on-chain at queue time. */
  referencePrice: bigint;
  /** Slot 0 (first depositor) was the buyer. Only meaningful when matched. */
  aIsBuyer: boolean;
  matchResult: string;
  matchResultExplorer: string;
  queueSig: string;
  finalizeSig: string;
  settleSig?: string;
  cancelSig?: string;
  settleExplorer?: string;
  steps: Step[];
}

/**
 * Collateral buckets for a tier. Base bucket = the tier's max order size;
 * USDC bucket = max size x reference x ESCROW_BOUND_PCT/100, from the PUBLIC
 * reference price (never from a bid). A fill whose qty x price exceeds the
 * USDC bucket simply does not match in the circuit. Default 125 %.
 */
export const ESCROW_BOUND_PCT = BigInt(process.env.ESCROW_BOUND_PCT ?? "125");
export function bucketsFor(
  maxQtyLamports: bigint,
  referencePrice: bigint
): { solBucket: bigint; usdcBucket: bigint } {
  const ref = referencePrice > 0n ? referencePrice : 150_000_000n;
  return {
    solBucket: maxQtyLamports,
    usdcBucket:
      (maxQtyLamports * ref * ESCROW_BOUND_PCT) / 100n / 1_000_000_000n,
  };
}

export function usdcPaidFor(qty: bigint, clearingPrice: bigint): bigint {
  return (qty * clearingPrice) / 1_000_000_000n;
}

function stepper(push: (s: Step) => void, cluster: Ctx["cluster"]) {
  return {
    start: (name: StepName, detail?: string) =>
      push({ name, status: "running", detail, at: Date.now() }),
    done: (name: StepName, sig?: string, detail?: string) =>
      push({
        name,
        status: "done",
        sig,
        explorer: sig ? explorerTx(sig, cluster) : undefined,
        detail,
        at: Date.now(),
      }),
  };
}

/**
 * Second half of a batch, once both parties have deposited with their
 * commitments: pick the oracle account, queue the MXE, await the callback,
 * then settle or refund. Used by the coordinator and by runBatch.
 */
export async function finishBatch(
  ctx: Ctx,
  m: Market,
  batchId: anchor.BN,
  a: EncryptedOrder,
  b: EncryptedOrder,
  payouts: Payouts,
  push: (s: Step) => void,
  steps: Step[]
): Promise<BatchOutput> {
  const { start, done } = stepper(push, ctx.cluster);

  start("oracle", `resolving the ${m.symbol}/USD price account the program will read`);
  const ref = await ensureReferencePrice(ctx, m);
  done(
    "oracle",
    undefined,
    `${ref.source} ${ref.account.toBase58()} = ${ref.human}${
      ref.note ? " (" + ref.note + ")" : ""
    }`
  );

  start(
    "queue_mxe",
    "match_orders -> commitments checked, oracle read on-chain, Arcium queue_computation"
  );
  const q = await queueMatch(ctx, batchId, a, b, ref.account, m.pool);
  done("queue_mxe", q.sig, `MatchResult PDA ${q.matchResult.toBase58()}`);

  start("await_mpc", "waiting for the MPC cluster callback");
  const out = await awaitMatch(ctx, q);
  done(
    "await_mpc",
    out.finalizeSig,
    out.matched
      ? `matched ${out.qty} @ ${out.clearingPrice} (ref ${out.referencePrice})`
      : "no match"
  );

  const base: BatchOutput = {
    batchId: batchId.toString(),
    matched: out.matched,
    clearingPrice: out.clearingPrice,
    qty: out.qty,
    usdcPaid: 0n,
    referencePrice: out.referencePrice,
    aIsBuyer: out.aIsBuyer,
    matchResult: q.matchResult.toBase58(),
    matchResultExplorer: explorerAddress(q.matchResult, ctx.cluster),
    queueSig: q.sig,
    finalizeSig: out.finalizeSig,
    steps,
  };

  if (out.matched) {
    start(
      "settle",
      "netting both parties' collateral against the fill, one tx"
    );
    const settleSig = await settle(ctx, batchId, m.mints, q.matchResult, payouts);
    done("settle", settleSig);
    return {
      ...base,
      usdcPaid: usdcPaidFor(out.qty, out.clearingPrice),
      settleSig,
      settleExplorer: explorerTx(settleSig, ctx.cluster),
    };
  }

  start("cancel", "no match: refunding both parties' collateral");
  const cancelSig = await cancel(ctx, batchId, m.mints, q.matchResult, payouts);
  done("cancel", cancelSig);
  return { ...base, cancelSig };
}

export async function runBatch(
  ctx: Ctx,
  m: Market,
  input: BatchInput,
  onStep: (s: Step) => void = () => {}
): Promise<BatchOutput> {
  const steps: Step[] = [];
  const push = (s: Step) => {
    steps.push(s);
    onStep(s);
  };
  const { start, done } = stepper(push, ctx.cluster);

  const batchId = new anchor.BN(Date.now());
  const payouts: Payouts = [
    input.a.payout ?? input.a.keypair.publicKey,
    input.b.payout ?? input.b.keypair.publicKey,
  ];

  try {
    start("ensure_pool");
    const pool = await ensurePool(ctx, m.mints);
    done(
      "ensure_pool",
      pool.sig,
      `pool ${pool.pool.toBase58()}${pool.sig ? " (created)" : ""}`
    );

    start("ensure_market", `pool -> Pyth feed ${m.def.feedId.slice(0, 8)}… (${m.symbol}/USD)`);
    const mk = await ensureMarket(ctx, m.pool, m.def.feedId);
    done("ensure_market", mk.sig, `MarketConfig ${mk.market.toBase58()}${mk.sig ? " (created)" : ""}`);

    start(
      "create_batch",
      `batch ${batchId.toString()} buckets ${input.solBucket} ${m.symbol}-mock / ${
        input.usdcBucket
      } USDC-mock`
    );
    const createSig = await createBatch(
      ctx,
      batchId,
      m.mints,
      input.solBucket,
      input.usdcBucket
    );
    done("create_batch", createSig);

    start(
      "encrypt",
      "x25519 ECDH with MXE key + Rescue cipher: {side, price, qty} per party"
    );
    const mxePk = await getMXEPublicKeyWithRetry(ctx);
    const a = encryptOrder(mxePk, input.a.order);
    const b = encryptOrder(mxePk, input.b.order);
    done(
      "encrypt",
      undefined,
      "side, limit price and size never leave this process in plaintext"
    );

    start(
      "deposit_a",
      "party A escrows both buckets + commits to its ciphertext"
    );
    const depASig = await deposit(
      ctx,
      batchId,
      m.mints,
      input.a.keypair,
      orderCommitment(a),
      payouts[0]
    );
    done("deposit_a", depASig);

    start(
      "deposit_b",
      "party B escrows both buckets + commits to its ciphertext"
    );
    const depBSig = await deposit(
      ctx,
      batchId,
      m.mints,
      input.b.keypair,
      orderCommitment(b),
      payouts[1]
    );
    done("deposit_b", depBSig);

    return await finishBatch(ctx, m, batchId, a, b, payouts, push, steps);
  } catch (e: any) {
    const last = steps[steps.length - 1];
    push({
      name: last?.name ?? "create_batch",
      status: "error",
      detail: String(e?.message ?? e),
      at: Date.now(),
    });
    throw e;
  }
}
