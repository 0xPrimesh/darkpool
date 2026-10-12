/**
 * Devnet setup, idempotent (re-run it after adding a market):
 *   - create the USDC-mock mint and one base mock mint per enabled market
 *     (SOL-mock, XAU-mock, ...), reusing any already in deployment.json
 *   - create demo buyer/seller keypairs under backend/.keys/
 *   - fund them with SOL for fees and with every mock token (both buckets)
 *   - create each market's settlement pool and register its Pyth feed
 *   - write deployment.json
 *
 * Usage: yarn setup:tokens
 */
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import {
  ctxFromEnv,
  demoKeypair,
  DEPLOYMENT_PATH,
  readDeployment,
  writeDeployment,
  Deployment,
} from "./lib/config";
import { createBaseMint, createUsdcMint, fundSol, mintToWallet } from "./lib/tokens";
import { enabledMarketDefs, ensureMarkets, loadMarkets } from "./lib/markets";

async function main() {
  const ctx = ctxFromEnv();
  console.log(`cluster=${ctx.cluster} rpc=${ctx.connection.rpcEndpoint.replace(/api-key=[^&]+/, "api-key=…")}`);
  console.log(`payer=${ctx.payer.publicKey.toBase58()}`);

  const bal = await ctx.connection.getBalance(ctx.payer.publicKey);
  console.log(`payer balance: ${bal / 1e9} SOL`);
  if (bal < 0.5e9)
    throw new Error(
      "Fund the payer with at least 0.5 SOL first (solana airdrop 2)"
    );

  const buyer = demoKeypair("buyer");
  const seller = demoKeypair("seller");
  console.log(`buyer=${buyer.publicKey.toBase58()}`);
  console.log(`seller=${seller.publicKey.toBase58()}`);

  const dep: Deployment = fs.existsSync(DEPLOYMENT_PATH)
    ? readDeployment()
    : { usdcMint: "", markets: {}, buyer: "", seller: "" };

  if (!dep.usdcMint) {
    dep.usdcMint = (await createUsdcMint(ctx)).toBase58();
    console.log(`USDC-mock mint  = ${dep.usdcMint} (created)`);
  } else console.log(`USDC-mock mint  = ${dep.usdcMint}`);

  const defs = enabledMarketDefs();
  for (const d of defs) {
    if (!dep.markets[d.symbol]?.mint) {
      dep.markets[d.symbol] = { mint: (await createBaseMint(ctx)).toBase58() };
      console.log(`${d.symbol}-mock mint ${" ".repeat(Math.max(0, 4 - d.symbol.length))}= ${dep.markets[d.symbol].mint} (created)`);
    } else console.log(`${d.symbol}-mock mint ${" ".repeat(Math.max(0, 4 - d.symbol.length))}= ${dep.markets[d.symbol].mint}`);
  }
  dep.buyer = buyer.publicKey.toBase58();
  dep.seller = seller.publicKey.toBase58();
  writeDeployment(dep);
  console.log("wrote deployment.json");

  console.log("funding demo wallets with SOL for fees...");
  for (const kp of [buyer, seller]) {
    const have = await ctx.connection.getBalance(kp.publicKey);
    if (have < 0.03e9) await fundSol(ctx, kp.publicKey, 0.05);
  }

  console.log("minting mock tokens...");
  // Every deposit escrows BOTH collateral buckets (so a deposit does not
  // reveal the side), hence both demo wallets hold every asset.
  const usdc = new PublicKey(dep.usdcMint);
  for (const kp of [buyer, seller]) {
    for (const d of defs)
      await mintToWallet(ctx, new PublicKey(dep.markets[d.symbol].mint), kp.publicKey, 100n * 10n ** 9n);
    await mintToWallet(ctx, usdc, kp.publicKey, 100_000n * 10n ** 6n);
  }

  console.log("creating pools and registering Pyth feeds...");
  const markets = loadMarkets(ctx, dep);
  for (const r of await ensureMarkets(ctx, markets)) {
    console.log(
      `  ${r.symbol}: pool ${r.pool}${r.poolSig ? " (created)" : ""}; market ${
        r.marketSig ? "registered " + r.marketSig : "already registered"
      }`
    );
  }
  for (const m of markets)
    console.log(`  ${m.symbol}: feed ${m.def.feedId} price account ${m.priceAccount.toBase58()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
