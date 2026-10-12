/**
 * Runtime context shared by scripts, the API server and the mocha test.
 * Builds an Anchor provider + both program clients from .env (devnet) or from
 * the `arcium test` environment (localnet).
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getArciumEnv } from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as dotenv from "dotenv";

import type { Darkpool } from "../../target/types/darkpool";
import type { Settlement } from "../../target/types/settlement";

dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

export const ROOT = path.join(__dirname, "..", "..");

export interface Ctx {
  cluster: "localnet" | "devnet";
  provider: anchor.AnchorProvider;
  connection: Connection;
  payer: Keypair;
  darkpool: Program<Darkpool>;
  settlement: Program<Settlement>;
  clusterOffset: number;
  /** REFERENCE_PRICE for the mock oracle (localnet), USDC 6dp per base unit. */
  referencePrice: bigint;
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function readKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(expandHome(p), "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

function loadIdl(name: string): anchor.Idl {
  const p = path.join(ROOT, "target", "idl", `${name}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`IDL not found at ${p}. Run \`arcium build\` first.`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Context from .env — used by scripts and the server. */
export function ctxFromEnv(): Ctx {
  const cluster = (process.env.CLUSTER ?? "devnet") as Ctx["cluster"];
  const rpcUrl =
    process.env.RPC_URL ??
    (cluster === "localnet" ? "http://127.0.0.1:8899" : "https://api.devnet.solana.com");
  const wsUrl = process.env.WS_URL;
  const payer = readKeypair(process.env.WALLET_PATH ?? "~/.config/solana/id.json");

  const connection = new Connection(rpcUrl, { commitment: "confirmed", wsEndpoint: wsUrl });
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const darkpool = new Program<Darkpool>(loadIdl("darkpool") as Darkpool, provider);
  const settlement = new Program<Settlement>(loadIdl("settlement") as Settlement, provider);

  const clusterOffset = process.env.CLUSTER_OFFSET
    ? Number(process.env.CLUSTER_OFFSET)
    : getArciumEnv().arciumClusterOffset;

  return {
    cluster,
    provider,
    connection,
    payer,
    darkpool,
    settlement,
    clusterOffset,
    referencePrice: BigInt(process.env.REFERENCE_PRICE ?? "150000000"),
  };
}

/** Context from the anchor/arcium test harness — used by tests/darkpool.ts. */
export function ctxFromWorkspace(): Ctx {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const darkpool = anchor.workspace.Darkpool as Program<Darkpool>;
  const settlement = anchor.workspace.Settlement as Program<Settlement>;
  const payer = readKeypair(
    process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`
  );
  return {
    cluster: "localnet",
    provider,
    connection: provider.connection,
    payer,
    darkpool,
    settlement,
    clusterOffset: getArciumEnv().arciumClusterOffset,
    referencePrice: BigInt(process.env.REFERENCE_PRICE ?? "150000000"),
  };
}

/** deployment.json, normalised. Older files only had `solMint`. */
export interface Deployment {
  usdcMint: string;
  /** Base mock mint per market symbol (SOL, XAU, ...). */
  markets: Record<string, { mint: string }>;
  buyer: string;
  seller: string;
}

export const DEPLOYMENT_PATH = path.join(ROOT, "deployment.json");

export function readDeployment(): Deployment {
  if (!fs.existsSync(DEPLOYMENT_PATH)) {
    throw new Error(`deployment.json not found. Run \`yarn setup:tokens\` first.`);
  }
  const raw = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
  const markets: Deployment["markets"] = { ...(raw.markets ?? {}) };
  if (raw.solMint && !markets.SOL) markets.SOL = { mint: raw.solMint };
  return { usdcMint: raw.usdcMint, markets, buyer: raw.buyer, seller: raw.seller };
}

export function writeDeployment(d: Deployment) {
  // `solMint` is kept for anything still reading the old single-market shape.
  const out = { ...d, solMint: d.markets.SOL?.mint };
  fs.writeFileSync(DEPLOYMENT_PATH, JSON.stringify(out, null, 2));
}

export const KEYS_DIR = path.join(ROOT, ".keys");

/** Load or create a demo keypair under backend/.keys/<name>.json. */
export function demoKeypair(name: string): Keypair {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const p = path.join(KEYS_DIR, `${name}.json`);
  if (fs.existsSync(p)) return readKeypair(p);
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

export function explorerTx(sig: string, cluster: Ctx["cluster"]): string {
  const q = cluster === "localnet" ? "?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899" : "?cluster=devnet";
  return `https://explorer.solana.com/tx/${sig}${q}`;
}

export function explorerAddress(addr: PublicKey | string, cluster: Ctx["cluster"]): string {
  const q = cluster === "localnet" ? "?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899" : "?cluster=devnet";
  return `https://explorer.solana.com/address/${addr.toString()}${q}`;
}
