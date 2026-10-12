/**
 * One-time per MXE deployment: register the match_orders circuit on-chain.
 * Run after `arcium deploy`. Usage: yarn init:comp-def
 */
import { ctxFromEnv } from "./lib/config";
import { initMatchOrdersCompDef } from "./lib/arcium";

async function main() {
  const ctx = ctxFromEnv();
  console.log(`cluster=${ctx.cluster} offset=${ctx.clusterOffset} darkpool=${ctx.darkpool.programId.toBase58()}`);
  const sig = await initMatchOrdersCompDef(ctx);
  console.log("comp def initialised:", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
