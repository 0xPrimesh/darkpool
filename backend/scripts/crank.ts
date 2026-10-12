/**
 * Settle or cancel an EXISTING batch by id (e.g. one whose settle step failed
 * before a program fix was deployed, leaving funds in escrow).
 *
 * Usage:
 *   yarn crank <batchId>            # settles if MatchResult is matched, else cancels
 *   yarn crank <batchId> cancel     # force cancel (creator only)
 *
 * The market is taken from the batch's pool.
 */
import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { ctxFromEnv, readDeployment, explorerTx } from "./lib/config";
import { matchResultPda } from "./lib/arcium";
import { cancel, fetchBatchParties, settle, Payouts } from "./lib/settlement";
import { loadMarkets } from "./lib/markets";

async function main() {
  const [idArg, mode] = process.argv.slice(2);
  if (!idArg) throw new Error("usage: yarn crank <batchId> [cancel]");
  const ctx = ctxFromEnv();
  const markets = loadMarkets(ctx, readDeployment());
  const id = new anchor.BN(idArg);

  const { batch, parties } = await fetchBatchParties(ctx, id);
  const market = markets.find((m) => m.pool.equals(batch.pool as PublicKey));
  if (!market)
    throw new Error(
      `batch pool ${(batch.pool as PublicKey).toBase58()} is not one of the configured markets`
    );
  const { mints } = market;
  console.log(
    `batch ${idArg} market=${market.symbol} state=${JSON.stringify(batch.state)} parties=${parties
      .map((p) => p?.wallet.toBase58() ?? "-")
      .join(", ")}`
  );
  if (!("open" in batch.state)) throw new Error("batch is not open");
  const payouts: Payouts = [
    parties[0]?.payout ?? ctx.payer.publicKey,
    parties[1]?.payout ?? ctx.payer.publicKey,
  ];

  const mr = matchResultPda(ctx, id);
  const mrInfo = await ctx.connection.getAccountInfo(mr);
  let matched = false;
  if (mrInfo) {
    const r: any = await ctx.darkpool.account.matchResult.fetch(mr);
    matched = r.finalized && r.matched;
    console.log(
      `matchResult finalized=${r.finalized} matched=${
        r.matched
      } price=${r.clearingPrice.toString()} qty=${r.qty.toString()} ref=${r.referencePrice.toString()}`
    );
  } else {
    console.log("no MatchResult PDA for this batch");
  }

  if (matched && mode !== "cancel") {
    const sig = await settle(ctx, id, mints, mr, payouts);
    console.log("SETTLED", explorerTx(sig, ctx.cluster));
  } else {
    const sig = await cancel(ctx, id, mints, mrInfo ? mr : null, payouts);
    console.log("CANCELLED (refunded)", explorerTx(sig, ctx.cluster));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
