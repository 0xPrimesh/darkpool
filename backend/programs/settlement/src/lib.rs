//! Atomic settlement for the dark pool.
//!
//! Flow per batch:
//!   init_pool     -> once per (SOL-mock, USDC-mock) pair: two shared vaults
//!   create_batch  -> Batch PDA with the public collateral buckets for this tier
//!   deposit (x2)  -> each party escrows BOTH buckets into the shared vaults
//!                    and records a commitment to its encrypted order.
//!                    Deposits look identical whichever side the party is on.
//!   settle        -> reads the MXE's MatchResult PDA; nets both parties'
//!                    collateral against the fill and pays everyone out in ONE tx
//!   cancel        -> refunds both parties' buckets when the batch did not match
//!
//! Atomicity is a property of the Solana transaction: if any transfer in
//! `settle` fails the whole instruction rolls back. Escrowing up front means
//! `settle` needs no signer except the cranker, so anyone can run it.
//!
//! Privacy properties of this design:
//!   * no instruction argument or event says which party is buying;
//!   * every deposit in a tier moves the same two amounts, so the deposit
//!     does not reveal order size (the size lives inside the ciphertext);
//!   * funds sit in vaults shared by all batches, not a vault per batch;
//!   * the only on-chain disclosure is the settlement netting itself.
//!
//! Payout destinations are recorded at deposit time. In Phase 1/2 they are the
//! parties' own wallets; Phase 3 swaps in stealth addresses without changing
//! this program.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("c7EkysCndbtFCrEmdivzQJCFJm3LR8Rr85zuQ4NHbH5");

/// The MXE program that owns MatchResult PDAs. Keep in sync with programs/darkpool.
pub const DARKPOOL_PROGRAM_ID: Pubkey = pubkey!("3EzETZhCcKjE85KPLd5HrPqYDgyMyfpq6RhGt43LeptS");

pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_AUTHORITY_SEED: &[u8] = b"pool_authority";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const BATCH_SEED: &[u8] = b"batch";

/// SOL-mock has 9 decimals; prices are USDC-mock (6 dp) per whole SOL.
const LAMPORTS_PER_SOL_MOCK: u128 = 1_000_000_000;

#[program]
pub mod settlement {
    use super::*;

    /// Creates the shared vault pair for a mint pair. Permissionless; the PDA
    /// makes it idempotent (a second call fails on `init`).
    pub fn init_pool(ctx: Context<InitPool>) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        p.bump = ctx.bumps.pool;
        p.authority_bump = ctx.bumps.vault_authority;
        p.sol_mint = ctx.accounts.sol_mint.key();
        p.usdc_mint = ctx.accounts.usdc_mint.key();
        p.sol_vault = ctx.accounts.sol_vault.key();
        p.usdc_vault = ctx.accounts.usdc_vault.key();
        emit!(PoolCreated { pool: p.key() });
        Ok(())
    }

    /// Creates the batch record. `sol_bucket` / `usdc_bucket` are the public
    /// collateral amounts every participant of this batch escrows, in both
    /// assets. They cap the fill (qty <= sol_bucket, qty * price <= usdc_bucket)
    /// but say nothing about which side a party is on or how much it wants.
    pub fn create_batch(
        ctx: Context<CreateBatch>,
        batch_id: u64,
        sol_bucket: u64,
        usdc_bucket: u64,
    ) -> Result<()> {
        require!(sol_bucket > 0 && usdc_bucket > 0, SettlementError::ZeroQuantity);

        let b = &mut ctx.accounts.batch;
        b.bump = ctx.bumps.batch;
        b.batch_id = batch_id;
        b.creator = ctx.accounts.creator.key();
        b.pool = ctx.accounts.pool.key();
        b.sol_bucket = sol_bucket;
        b.usdc_bucket = usdc_bucket;
        b.parties = [Party::default(), Party::default()];
        b.state = BatchState::Open;
        b.clearing_price = 0;
        b.qty = 0;
        b.usdc_paid = 0;

        emit!(BatchCreated { batch_id, sol_bucket, usdc_bucket });
        Ok(())
    }

    /// A party escrows `sol_bucket` SOL-mock AND `usdc_bucket` USDC-mock,
    /// records where to be paid, and commits to its encrypted order
    /// (`commitment = sha256(x25519_pubkey || nonce_le || ct_side || ct_price || ct_qty)`).
    /// The first depositor takes slot 0, the second slot 1. Nothing here
    /// depends on the side of the order.
    pub fn deposit(
        ctx: Context<Deposit>,
        _batch_id: u64,
        commitment: [u8; 32],
        payout_dest: Pubkey,
    ) -> Result<()> {
        let b = &ctx.accounts.batch;
        require!(b.state == BatchState::Open, SettlementError::BatchNotOpen);
        require!(commitment != [0u8; 32], SettlementError::EmptyCommitment);
        let who = ctx.accounts.depositor.key();
        require!(
            b.parties.iter().all(|p| p.wallet != who),
            SettlementError::AlreadyDeposited
        );
        let slot = b
            .parties
            .iter()
            .position(|p| p.wallet == Pubkey::default())
            .ok_or(SettlementError::BatchFull)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.depositor_sol_ata.to_account_info(),
                    to: ctx.accounts.sol_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            b.sol_bucket,
        )?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.depositor_usdc_ata.to_account_info(),
                    to: ctx.accounts.usdc_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            b.usdc_bucket,
        )?;

        let b = &mut ctx.accounts.batch;
        b.parties[slot] = Party { wallet: who, payout: payout_dest, commitment };
        emit!(Deposited { batch_id: b.batch_id, wallet: who });
        Ok(())
    }

    /// Executes the fill using the MXE's revealed result. Permissionless:
    /// anyone can crank it once the MatchResult is finalized. Each party gets
    /// its two buckets back, netted by the fill:
    ///   buyer : sol_bucket + qty,  usdc_bucket - qty * price
    ///   seller: sol_bucket - qty,  usdc_bucket + qty * price
    pub fn settle(ctx: Context<Settle>, batch_id: u64) -> Result<()> {
        let b = &ctx.accounts.batch;
        require!(b.state == BatchState::Open, SettlementError::BatchNotOpen);
        require!(
            b.parties[0].wallet != Pubkey::default() && b.parties[1].wallet != Pubkey::default(),
            SettlementError::MissingDeposit
        );

        let r = MatchResultView::load(&ctx.accounts.match_result)?;
        require!(r.batch_id == batch_id, SettlementError::BatchMismatch);
        require!(r.finalized, SettlementError::NotFinalized);
        require!(r.matched, SettlementError::NotMatched);
        require!(r.clearing_price > 0 && r.qty > 0, SettlementError::NotMatched);

        // Defence in depth: the circuit already enforced these.
        require!(r.qty <= b.sol_bucket, SettlementError::BoundExceeded);
        let usdc_owed_u128 = (r.qty as u128)
            .checked_mul(r.clearing_price as u128)
            .ok_or(SettlementError::MathOverflow)?
            / LAMPORTS_PER_SOL_MOCK;
        let usdc_owed = u64::try_from(usdc_owed_u128).map_err(|_| SettlementError::MathOverflow)?;
        require!(usdc_owed <= b.usdc_bucket, SettlementError::BoundExceeded);

        let (buyer_sol, buyer_usdc) = (b.sol_bucket + r.qty, b.usdc_bucket - usdc_owed);
        let (seller_sol, seller_usdc) = (b.sol_bucket - r.qty, b.usdc_bucket + usdc_owed);
        let (a_sol, a_usdc, b_sol, b_usdc) = if r.a_is_buyer {
            (buyer_sol, buyer_usdc, seller_sol, seller_usdc)
        } else {
            (seller_sol, seller_usdc, buyer_sol, buyer_usdc)
        };

        let pool_key = ctx.accounts.pool.key();
        let seeds: &[&[u8]] = &[POOL_AUTHORITY_SEED, pool_key.as_ref(), &[ctx.accounts.pool.authority_bump]];
        let signer = &[seeds];
        let tp = ctx.accounts.token_program.key();
        let auth = ctx.accounts.vault_authority.to_account_info();
        let sol_vault = ctx.accounts.sol_vault.to_account_info();
        let usdc_vault = ctx.accounts.usdc_vault.to_account_info();

        pay(&tp, &sol_vault, &ctx.accounts.party_a_sol_ata.to_account_info(), &auth, signer, a_sol)?;
        pay(&tp, &usdc_vault, &ctx.accounts.party_a_usdc_ata.to_account_info(), &auth, signer, a_usdc)?;
        pay(&tp, &sol_vault, &ctx.accounts.party_b_sol_ata.to_account_info(), &auth, signer, b_sol)?;
        pay(&tp, &usdc_vault, &ctx.accounts.party_b_usdc_ata.to_account_info(), &auth, signer, b_usdc)?;

        let b = &mut ctx.accounts.batch;
        b.state = BatchState::Settled;
        b.clearing_price = r.clearing_price;
        b.qty = r.qty;
        b.usdc_paid = usdc_owed;

        // Only the batch id: the transfers above are the record.
        emit!(Settled { batch_id });
        Ok(())
    }

    /// Refunds both parties' buckets. Allowed when the MXE reported no match,
    /// or by the batch creator (coordinator) if the batch never completed.
    pub fn cancel(ctx: Context<Cancel>, batch_id: u64) -> Result<()> {
        let b = &ctx.accounts.batch;
        require!(b.state == BatchState::Open, SettlementError::BatchNotOpen);

        let creator_cancel = ctx.accounts.cranker.key() == b.creator;
        let no_match = match &ctx.accounts.match_result {
            Some(acc) => {
                let r = MatchResultView::load(acc)?;
                r.batch_id == batch_id && r.finalized && !r.matched
            }
            None => false,
        };
        require!(creator_cancel || no_match, SettlementError::Unauthorized);

        let pool_key = ctx.accounts.pool.key();
        let seeds: &[&[u8]] = &[POOL_AUTHORITY_SEED, pool_key.as_ref(), &[ctx.accounts.pool.authority_bump]];
        let signer = &[seeds];
        let tp = ctx.accounts.token_program.key();
        let auth = ctx.accounts.vault_authority.to_account_info();
        let sol_vault = ctx.accounts.sol_vault.to_account_info();
        let usdc_vault = ctx.accounts.usdc_vault.to_account_info();

        if b.parties[0].wallet != Pubkey::default() {
            pay(&tp, &sol_vault, &ctx.accounts.party_a_sol_ata.to_account_info(), &auth, signer, b.sol_bucket)?;
            pay(&tp, &usdc_vault, &ctx.accounts.party_a_usdc_ata.to_account_info(), &auth, signer, b.usdc_bucket)?;
        }
        if b.parties[1].wallet != Pubkey::default() {
            pay(&tp, &sol_vault, &ctx.accounts.party_b_sol_ata.to_account_info(), &auth, signer, b.sol_bucket)?;
            pay(&tp, &usdc_vault, &ctx.accounts.party_b_usdc_ata.to_account_info(), &auth, signer, b.usdc_bucket)?;
        }

        let b = &mut ctx.accounts.batch;
        b.state = BatchState::Cancelled;
        emit!(Cancelled { batch_id });
        Ok(())
    }
}

/// Vault -> destination transfer signed by the pool authority; no-op for 0.
fn pay<'info>(
    token_program: &Pubkey,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    signer: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new_with_signer(
            *token_program,
            Transfer { from: from.clone(), to: to.clone(), authority: authority.clone() },
            signer,
        ),
        amount,
    )
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum BatchState {
    Open,
    Settled,
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub bump: u8,
    pub authority_bump: u8,
    pub sol_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub sol_vault: Pubkey,
    pub usdc_vault: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Party {
    pub wallet: Pubkey,
    pub payout: Pubkey,
    pub commitment: [u8; 32],
}

/// The darkpool program keeps a Borsh mirror of the leading fields of this
/// struct (through `state`): do not reorder them.
#[account]
#[derive(InitSpace)]
pub struct Batch {
    pub bump: u8,
    pub batch_id: u64,
    pub creator: Pubkey,
    pub pool: Pubkey,
    pub sol_bucket: u64,
    pub usdc_bucket: u64,
    pub parties: [Party; 2],
    pub state: BatchState,
    pub clearing_price: u64,
    pub qty: u64,
    pub usdc_paid: u64,
}

/// Borsh mirror of `darkpool::MatchResult` (after the 8-byte discriminator).
/// Kept local so this crate does not depend on the arcium toolchain.
#[derive(AnchorDeserialize)]
pub struct MatchResultView {
    pub bump: u8,
    pub batch_id: u64,
    pub computation_offset: u64,
    pub matched: bool,
    pub clearing_price: u64,
    pub finalized: bool,
    pub qty: u64,
    pub a_is_buyer: bool,
    pub reference_price: u64,
    pub oracle_publish_time: i64,
    pub queued_slot: u64,
}

impl MatchResultView {
    pub fn load(acc: &UncheckedAccount) -> Result<Self> {
        require_keys_eq!(*acc.owner, DARKPOOL_PROGRAM_ID, SettlementError::BadMatchResultOwner);
        let data = acc.try_borrow_data()?;
        require!(data.len() > 8, SettlementError::BadMatchResult);
        let mut slice: &[u8] = &data[8..];
        MatchResultView::deserialize(&mut slice).map_err(|_| SettlementError::BadMatchResult.into())
    }
}

// ---------------------------------------------------------------------------
// Accounts
//
// Every Mint / TokenAccount / Batch is Box<Account<..>>. Anchor deserialises
// all accounts on the 4 KB BPF stack frame; `Settle` and `Cancel` carry enough
// of them that the unboxed version overflowed it, which on Solana does not
// error but silently corrupts memory. Keep them boxed.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub sol_mint: Box<Account<'info, Mint>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, sol_mint.key().as_ref(), usdc_mint.key().as_ref()],
        bump,
    )]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: PDA signer for vault transfers; no data.
    #[account(seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        seeds = [POOL_VAULT_SEED, pool.key().as_ref(), sol_mint.key().as_ref()],
        bump,
        token::mint = sol_mint,
        token::authority = vault_authority,
    )]
    pub sol_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = payer,
        seeds = [POOL_VAULT_SEED, pool.key().as_ref(), usdc_mint.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = vault_authority,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(batch_id: u64)]
pub struct CreateBatch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init,
        payer = creator,
        space = 8 + Batch::INIT_SPACE,
        seeds = [BATCH_SEED, &batch_id.to_le_bytes()],
        bump,
    )]
    pub batch: Box<Account<'info, Batch>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(batch_id: u64)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [BATCH_SEED, &batch_id.to_le_bytes()], bump = batch.bump, has_one = pool)]
    pub batch: Box<Account<'info, Batch>>,
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, token::mint = pool.sol_mint, token::authority = depositor)]
    pub depositor_sol_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = pool.usdc_mint, token::authority = depositor)]
    pub depositor_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = pool.sol_vault)]
    pub sol_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = pool.usdc_vault)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(batch_id: u64)]
pub struct Settle<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [BATCH_SEED, &batch_id.to_le_bytes()], bump = batch.bump, has_one = pool)]
    pub batch: Box<Account<'info, Batch>>,
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: owner + layout verified in MatchResultView::load; PDA of the darkpool program for this batch.
    #[account(seeds = [b"match", &batch_id.to_le_bytes()], bump, seeds::program = DARKPOOL_PROGRAM_ID)]
    pub match_result: UncheckedAccount<'info>,
    /// CHECK: PDA signer.
    #[account(seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()], bump = pool.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(address = pool.sol_mint)]
    pub sol_mint: Box<Account<'info, Mint>>,
    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = pool.sol_vault)]
    pub sol_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = pool.usdc_vault)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: recorded at deposit time; only used as ATA owner.
    #[account(address = batch.parties[0].payout)]
    pub party_a_payout: UncheckedAccount<'info>,
    /// CHECK: recorded at deposit time; only used as ATA owner.
    #[account(address = batch.parties[1].payout)]
    pub party_b_payout: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = cranker, associated_token::mint = sol_mint, associated_token::authority = party_a_payout)]
    pub party_a_sol_ata: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = cranker, associated_token::mint = usdc_mint, associated_token::authority = party_a_payout)]
    pub party_a_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = cranker, associated_token::mint = sol_mint, associated_token::authority = party_b_payout)]
    pub party_b_sol_ata: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = cranker, associated_token::mint = usdc_mint, associated_token::authority = party_b_payout)]
    pub party_b_usdc_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(batch_id: u64)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [BATCH_SEED, &batch_id.to_le_bytes()], bump = batch.bump, has_one = pool)]
    pub batch: Box<Account<'info, Batch>>,
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: optional; verified in MatchResultView::load when present.
    pub match_result: Option<UncheckedAccount<'info>>,
    /// CHECK: PDA signer.
    #[account(seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()], bump = pool.authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(address = pool.sol_mint)]
    pub sol_mint: Box<Account<'info, Mint>>,
    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = pool.sol_vault)]
    pub sol_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = pool.usdc_vault)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: refund target for slot 0. Must be the recorded payout; if the slot
    /// is empty any account may be passed since nothing is transferred.
    #[account(constraint = batch.parties[0].wallet == Pubkey::default() || party_a_payout.key() == batch.parties[0].payout @ SettlementError::Unauthorized)]
    pub party_a_payout: UncheckedAccount<'info>,
    /// CHECK: refund target for slot 1, same rule.
    #[account(constraint = batch.parties[1].wallet == Pubkey::default() || party_b_payout.key() == batch.parties[1].payout @ SettlementError::Unauthorized)]
    pub party_b_payout: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = cranker, associated_token::mint = sol_mint, associated_token::authority = party_a_payout)]
    pub party_a_sol_ata: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = cranker, associated_token::mint = usdc_mint, associated_token::authority = party_a_payout)]
    pub party_a_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = cranker, associated_token::mint = sol_mint, associated_token::authority = party_b_payout)]
    pub party_b_sol_ata: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = cranker, associated_token::mint = usdc_mint, associated_token::authority = party_b_payout)]
    pub party_b_usdc_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
}

#[event]
pub struct BatchCreated {
    pub batch_id: u64,
    pub sol_bucket: u64,
    pub usdc_bucket: u64,
}

/// No side, no amount: a deposit is the same whichever side the party is on.
#[event]
pub struct Deposited {
    pub batch_id: u64,
    pub wallet: Pubkey,
}

#[event]
pub struct Settled {
    pub batch_id: u64,
}

#[event]
pub struct Cancelled {
    pub batch_id: u64,
}

#[error_code]
pub enum SettlementError {
    #[msg("Quantity must be > 0")]
    ZeroQuantity,
    #[msg("Batch is not open")]
    BatchNotOpen,
    #[msg("This wallet already deposited into this batch")]
    AlreadyDeposited,
    #[msg("Both party slots are already taken")]
    BatchFull,
    #[msg("Order commitment must not be empty")]
    EmptyCommitment,
    #[msg("Both parties must deposit before settlement")]
    MissingDeposit,
    #[msg("MatchResult batch_id does not match")]
    BatchMismatch,
    #[msg("MatchResult is not finalized yet")]
    NotFinalized,
    #[msg("MXE reported no match")]
    NotMatched,
    #[msg("Fill exceeds the escrowed collateral bucket")]
    BoundExceeded,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("MatchResult account is not owned by the darkpool program")]
    BadMatchResultOwner,
    #[msg("MatchResult account could not be decoded")]
    BadMatchResult,
    #[msg("Unauthorized")]
    Unauthorized,
}
