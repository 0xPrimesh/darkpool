/**
 * Settlement program helpers: PDAs and the five instructions.
 */
import * as anchor from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Ctx } from "./config";

const SYSVAR_RENT = anchor.web3.SYSVAR_RENT_PUBKEY;

/** A market's mint pair. `solMint` is the base mock (SOL-mock, XAU-mock, ...). */
export interface Mints {
  solMint: PublicKey;
  usdcMint: PublicKey;
}

export function poolPda(ctx: Ctx, mints: Mints) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mints.solMint.toBuffer(), mints.usdcMint.toBuffer()],
    ctx.settlement.programId
  )[0];
}
export function poolAuthorityPda(ctx: Ctx, pool: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority"), pool.toBuffer()],
    ctx.settlement.programId
  )[0];
}
export function poolVaultPda(ctx: Ctx, pool: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), pool.toBuffer(), mint.toBuffer()],
    ctx.settlement.programId
  )[0];
}
export function batchPda(ctx: Ctx, batchId: anchor.BN) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("batch"), batchId.toArrayLike(Buffer, "le", 8)],
    ctx.settlement.programId
  )[0];
}

/** All pool-level addresses for a mint pair. */
export function poolAccounts(ctx: Ctx, mints: Mints) {
  const pool = poolPda(ctx, mints);
  return {
    pool,
    vaultAuthority: poolAuthorityPda(ctx, pool),
    solVault: poolVaultPda(ctx, pool, mints.solMint),
    usdcVault: poolVaultPda(ctx, pool, mints.usdcMint),
  };
}

/** Create the shared vaults for a mint pair if they do not exist yet. */
export async function ensurePool(
  ctx: Ctx,
  mints: Mints
): Promise<{ pool: PublicKey; sig?: string }> {
  const pa = poolAccounts(ctx, mints);
  const info = await ctx.connection.getAccountInfo(pa.pool);
  if (info) return { pool: pa.pool };
  const sig = await ctx.settlement.methods
    .initPool()
    .accountsPartial({
      payer: ctx.payer.publicKey,
      solMint: mints.solMint,
      usdcMint: mints.usdcMint,
      pool: pa.pool,
      vaultAuthority: pa.vaultAuthority,
      solVault: pa.solVault,
      usdcVault: pa.usdcVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: SYSVAR_RENT,
    })
    .signers([ctx.payer])
    .rpc({ commitment: "confirmed" });
  return { pool: pa.pool, sig };
}

export async function createBatch(
  ctx: Ctx,
  batchId: anchor.BN,
  mints: Mints,
  solBucket: bigint,
  usdcBucket: bigint
): Promise<string> {
  return ctx.settlement.methods
    .createBatch(
      batchId,
      new anchor.BN(solBucket.toString()),
      new anchor.BN(usdcBucket.toString())
    )
    .accountsPartial({
      creator: ctx.payer.publicKey,
      pool: poolPda(ctx, mints),
      batch: batchPda(ctx, batchId),
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([ctx.payer])
    .rpc({ commitment: "confirmed" });
}

/**
 * Build a party's deposit instruction (signed by `depositor`, who may be a
 * browser wallet). The same instruction for buyers and sellers: both buckets
 * move into the shared vaults and the order commitment is recorded.
 */
export async function depositIx(
  ctx: Ctx,
  batchId: anchor.BN,
  mints: Mints,
  depositor: PublicKey,
  commitment: Buffer | Uint8Array,
  payoutDest: PublicKey
): Promise<TransactionInstruction> {
  const pa = poolAccounts(ctx, mints);
  return ctx.settlement.methods
    .deposit(batchId, Array.from(commitment), payoutDest)
    .accountsPartial({
      depositor,
      batch: batchPda(ctx, batchId),
      pool: pa.pool,
      depositorSolAta: getAssociatedTokenAddressSync(mints.solMint, depositor),
      depositorUsdcAta: getAssociatedTokenAddressSync(
        mints.usdcMint,
        depositor
      ),
      solVault: pa.solVault,
      usdcVault: pa.usdcVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/** Build an unsigned deposit transaction for a wallet to sign in the browser. Returns base64. */
export async function buildDepositTx(
  ctx: Ctx,
  batchId: anchor.BN,
  mints: Mints,
  wallet: PublicKey,
  commitment: Buffer | Uint8Array,
  payoutDest: PublicKey
): Promise<string> {
  const ix = await depositIx(
    ctx,
    batchId,
    mints,
    wallet,
    commitment,
    payoutDest
  );
  const { blockhash } = await ctx.connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: wallet,
    recentBlockhash: blockhash,
  }).add(ix);
  return tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

/** Script/test path: sign and send a deposit with a local Keypair. */
export async function deposit(
  ctx: Ctx,
  batchId: anchor.BN,
  mints: Mints,
  depositor: Keypair,
  commitment: Buffer | Uint8Array,
  payoutDest: PublicKey
): Promise<string> {
  const ix = await depositIx(
    ctx,
    batchId,
    mints,
    depositor.publicKey,
    commitment,
    payoutDest
  );
  const tx = new Transaction().add(ix);
  return ctx.provider.sendAndConfirm(tx, [depositor], {
    commitment: "confirmed",
  });
}

/** Payout destinations in slot order (slot 0 = first depositor). */
export type Payouts = [PublicKey, PublicKey];

function partyAtas(mints: Mints, payouts: Payouts) {
  return {
    partyAPayout: payouts[0],
    partyBPayout: payouts[1],
    partyASolAta: getAssociatedTokenAddressSync(
      mints.solMint,
      payouts[0],
      true
    ),
    partyAUsdcAta: getAssociatedTokenAddressSync(
      mints.usdcMint,
      payouts[0],
      true
    ),
    partyBSolAta: getAssociatedTokenAddressSync(
      mints.solMint,
      payouts[1],
      true
    ),
    partyBUsdcAta: getAssociatedTokenAddressSync(
      mints.usdcMint,
      payouts[1],
      true
    ),
  };
}

export async function settle(
  ctx: Ctx,
  batchId: anchor.BN,
  mints: Mints,
  matchResult: PublicKey,
  payouts: Payouts
): Promise<string> {
  const pa = poolAccounts(ctx, mints);
  return ctx.settlement.methods
    .settle(batchId)
    .accountsPartial({
      cranker: ctx.payer.publicKey,
      batch: batchPda(ctx, batchId),
      pool: pa.pool,
      matchResult,
      vaultAuthority: pa.vaultAuthority,
      solMint: mints.solMint,
      usdcMint: mints.usdcMint,
      solVault: pa.solVault,
      usdcVault: pa.usdcVault,
      ...partyAtas(mints, payouts),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([ctx.payer])
    .rpc({ commitment: "confirmed" });
}

/**
 * Refund both parties. For an empty slot pass any pubkey (the cranker is
 * fine): the program transfers nothing for it.
 */
export async function cancel(
  ctx: Ctx,
  batchId: anchor.BN,
  mints: Mints,
  matchResult: PublicKey | null,
  payouts: Payouts
): Promise<string> {
  const pa = poolAccounts(ctx, mints);
  return ctx.settlement.methods
    .cancel(batchId)
    .accountsPartial({
      cranker: ctx.payer.publicKey,
      batch: batchPda(ctx, batchId),
      pool: pa.pool,
      matchResult,
      vaultAuthority: pa.vaultAuthority,
      solMint: mints.solMint,
      usdcMint: mints.usdcMint,
      solVault: pa.solVault,
      usdcVault: pa.usdcVault,
      ...partyAtas(mints, payouts),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([ctx.payer])
    .rpc({ commitment: "confirmed" });
}

/** Read a Batch and return its party slots (undeposited slots are null). */
export async function fetchBatchParties(ctx: Ctx, batchId: anchor.BN) {
  const b: any = await ctx.settlement.account.batch.fetch(
    batchPda(ctx, batchId)
  );
  const parties = (b.parties as any[]).map((p) =>
    (p.wallet as PublicKey).equals(PublicKey.default)
      ? null
      : { wallet: p.wallet as PublicKey, payout: p.payout as PublicKey }
  );
  return {
    batch: b,
    parties: [parties[0], parties[1]] as [
      (typeof parties)[0],
      (typeof parties)[1]
    ],
  };
}
