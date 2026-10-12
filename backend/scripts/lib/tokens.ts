/**
 * Mock SPL tokens for devnet/localnet: base mocks (SOL-mock, NVDA-mock; 9 dp)
 * and USDC-mock (6 dp).
 */
import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Ctx } from "./config";

export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;

export const BASE_DECIMALS = SOL_DECIMALS;

export function createBaseMint(ctx: Ctx) {
  return createMint(ctx.connection, ctx.payer, ctx.payer.publicKey, null, BASE_DECIMALS);
}
export function createUsdcMint(ctx: Ctx) {
  return createMint(ctx.connection, ctx.payer, ctx.payer.publicKey, null, USDC_DECIMALS);
}

/** One base mock + USDC-mock (the localnet test's single SOL market). */
export async function createMints(ctx: Ctx) {
  const solMint = await createBaseMint(ctx);
  const usdcMint = await createUsdcMint(ctx);
  return { solMint, usdcMint };
}

/** Send lamports from the payer so demo wallets can pay fees (no airdrop rate limits). */
export async function fundSol(ctx: Ctx, to: PublicKey, sol: number) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: ctx.payer.publicKey,
      toPubkey: to,
      lamports: Math.round(sol * LAMPORTS_PER_SOL),
    })
  );
  return ctx.provider.sendAndConfirm(tx, [ctx.payer]);
}

export async function mintToWallet(ctx: Ctx, mint: PublicKey, owner: PublicKey, amount: bigint) {
  const ata = await getOrCreateAssociatedTokenAccount(ctx.connection, ctx.payer, mint, owner);
  await mintTo(ctx.connection, ctx.payer, mint, ata.address, ctx.payer, amount);
  return ata.address;
}

export async function tokenBalance(ctx: Ctx, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  try {
    const ata = await getOrCreateAssociatedTokenAccount(ctx.connection, ctx.payer, mint, owner);
    const acc = await getAccount(ctx.connection, ata.address);
    return acc.amount;
  } catch {
    return 0n;
  }
}

export function fmt(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}
