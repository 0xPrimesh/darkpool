/**
 * Run one batch end to end from the terminal.
 *
 * Usage:
 *   yarn e2e                       # bid 152, ask 148, qty 1 SOL  -> match
 *   yarn e2e 148 152               # bid 148, ask 152             -> no match, refund
 *   yarn e2e 152 148 2.5           # qty 2.5 SOL
 *   MARKET=XAU yarn e2e 4200 4100 0.1   # gold (needs HERMES_API_KEY; qty at most its tier)
 *
 * The buyer is the first depositor (slot A) and the seller the second (slot B)
 * only because this script submits them in that order; on-chain nothing says
 * which is which until the MXE reveals the fill.
 */
import { ctxFromEnv, demoKeypair, readDeployment } from "./lib/config";
import { bucketsFor, runBatch } from "./lib/flow";
import { fmt, tokenBalance } from "./lib/tokens";
import { getReferencePrice } from "./lib/price";
import { loadMarkets, marketBySymbol } from "./lib/markets";

function toUsdc(s: string): bigint {
  return BigInt(Math.round(parseFloat(s) * 1e6));
}
function toLamports(s: string): bigint {
  return BigInt(Math.round(parseFloat(s) * 1e9));
}

async function main() {
  const [bidArg = "152", askArg = "148", qtyArg = "1"] = process.argv.slice(2);
  const ctx = ctxFromEnv();
  const dep = readDeployment();
  const market = marketBySymbol(loadMarkets(ctx, dep), process.env.MARKET);
  const { mints, symbol } = market;
  const buyer = demoKeypair("buyer");
  const seller = demoKeypair("seller");

  const balances = async () => ({
    buyerSol: await tokenBalance(ctx, mints.solMint, buyer.publicKey),
    buyerUsdc: await tokenBalance(ctx, mints.usdcMint, buyer.publicKey),
    sellerSol: await tokenBalance(ctx, mints.solMint, seller.publicKey),
    sellerUsdc: await tokenBalance(ctx, mints.usdcMint, seller.publicKey),
  });
  const before = await balances();

  const ref = await getReferencePrice(ctx, market);
  const qty = toLamports(qtyArg);
  const buckets = bucketsFor(qty, ref.price);
  console.log(
    `\n${symbol}: BID ${bidArg}   ASK ${askArg}   QTY ${qtyArg} ${symbol}   REF ${ref.human} (${
      ref.source
    }${ref.note ? ", " + ref.note : ""})`
  );
  console.log(
    `each party escrows ${fmt(buckets.solBucket, 9)} ${symbol}-mock + ${fmt(
      buckets.usdcBucket,
      6
    )} USDC-mock\n`
  );

  const out = await runBatch(
    ctx,
    market,
    {
      a: { keypair: buyer, order: { isBuy: true, price: toUsdc(bidArg), qty } },
      b: {
        keypair: seller,
        order: { isBuy: false, price: toUsdc(askArg), qty },
      },
      ...buckets,
    },
    (s) => {
      const tag =
        s.status === "running" ? "..." : s.status === "done" ? " ok" : "ERR";
      console.log(
        `[${tag}] ${s.name}${s.detail ? "  " + s.detail : ""}${
          s.explorer ? "\n       " + s.explorer : ""
        }`
      );
    }
  );

  const after = await balances();

  console.log("\n=== RESULT ===");
  console.log(
    out.matched
      ? `FILLED ${fmt(out.qty, 9)} ${symbol} @ ${fmt(
          out.clearingPrice,
          6
        )} USDC (on-chain ref ${fmt(out.referencePrice, 6)})`
      : "NO MATCH - refunded"
  );
  console.log(`MatchResult PDA: ${out.matchResultExplorer}`);
  if (out.settleExplorer) console.log(`Settlement tx:   ${out.settleExplorer}`);
  console.log("\nbalances (before -> after)");
  console.log(
    `  buyer  ${symbol}-mock  ${fmt(before.buyerSol, 9)} -> ${fmt(after.buyerSol, 9)}`
  );
  console.log(
    `  buyer  USDC-mock ${fmt(before.buyerUsdc, 6)} -> ${fmt(
      after.buyerUsdc,
      6
    )}`
  );
  console.log(
    `  seller ${symbol}-mock  ${fmt(before.sellerSol, 9)} -> ${fmt(
      after.sellerSol,
      9
    )}`
  );
  console.log(
    `  seller USDC-mock ${fmt(before.sellerUsdc, 6)} -> ${fmt(
      after.sellerUsdc,
      6
    )}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
