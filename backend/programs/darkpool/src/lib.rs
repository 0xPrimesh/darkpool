//! Dark pool MXE program.
//!
//! One encrypted instruction, `match_orders`, with the usual three handlers:
//!   * `init_match_orders_comp_def`  - one-time registration of the circuit
//!   * `match_orders`                - queue a computation for a batch
//!   * `match_orders_callback`       - Arcium cluster posts the signed result
//!
//! `match_orders` is permissionless but constrained:
//!   * the two encrypted orders must hash to the commitments each party
//!     recorded in the settlement `Batch` when they deposited, so nobody (the
//!     coordinator included) can substitute orders;
//!   * the reference price is read from the Pyth price account passed in,
//!     with owner / feed / staleness / confidence checks, and is never an
//!     instruction argument. Which feed is the right one for a batch comes
//!     from the `MarketConfig` registered for the batch's settlement pool
//!     (SOL/USD for the SOL-mock pool, XAU/USD for the XAU-mock pool, ...);
//!   * the collateral buckets come from the `Batch`, not from the caller.
//!
//! The callback writes the revealed fill into a `MatchResult` PDA seeded by
//! `batch_id`. The settlement program reads that PDA.

pub mod oracle;

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;
use oracle::read_price_feed;

const COMP_DEF_OFFSET_MATCH_ORDERS: u32 = comp_def_offset("match_orders_v2");

pub const MATCH_SEED: &[u8] = b"match";
pub const MARKET_SEED: &[u8] = b"market";
pub const MOCK_PRICE_SEED: &[u8] = b"mock_price";

/// The settlement program that owns `Batch` PDAs. Keep in sync with programs/settlement.
pub const SETTLEMENT_PROGRAM_ID: Pubkey = pubkey!("c7EkysCndbtFCrEmdivzQJCFJm3LR8Rr85zuQ4NHbH5");
pub const BATCH_SEED: &[u8] = b"batch";

declare_id!("3EzETZhCcKjE85KPLd5HrPqYDgyMyfpq6RhGt43LeptS");

/// Commitment a party records at deposit time: sha256 of the exact
/// ciphertext tuple that `match_orders` must later be called with.
pub fn order_commitment(
    pubkey: &[u8; 32],
    nonce: u128,
    ct_side: &[u8; 32],
    ct_price: &[u8; 32],
    ct_qty: &[u8; 32],
) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[pubkey, &nonce.to_le_bytes(), ct_side, ct_price, ct_qty]).to_bytes()
}

#[arcium_program]
pub mod darkpool {
    use super::*;

    /// Registers the `match_orders` circuit with the MXE. Run once per deployment.
    pub fn init_match_orders_comp_def(ctx: Context<InitMatchOrdersCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    /// Binds a settlement pool to the Pyth feed its batches must be priced
    /// with. One `MarketConfig` per pool, created once and never changed:
    /// a pool whose market was registered with the wrong feed simply gets a
    /// fresh pool (new mint) instead. Permissionless, like `init_pool`.
    pub fn register_market(ctx: Context<RegisterMarket>, feed_id: [u8; 32]) -> Result<()> {
        require!(feed_id != [0u8; 32], ErrorCode::EmptyFeedId);
        let m = &mut ctx.accounts.market;
        m.bump = ctx.bumps.market;
        m.pool = ctx.accounts.pool.key();
        m.feed_id = feed_id;
        emit!(MarketRegistered { pool: m.pool, feed_id });
        Ok(())
    }

    /// Queues the matching computation for `batch_id`.
    ///
    /// Argument order must match the circuit signature exactly:
    ///   Enc<Shared, OrderInput>  = x25519 pubkey + nonce + 3 ciphertexts (is_buy, price, qty)
    ///   Enc<Shared, OrderInput>  = same for party B
    ///   reference_price          = plaintext u64, read from Pyth here
    ///   sol_bucket, usdc_bucket  = plaintext u64, read from the Batch here
    #[allow(clippy::too_many_arguments)]
    pub fn match_orders(
        ctx: Context<MatchOrders>,
        computation_offset: u64,
        batch_id: u64,
        a_pubkey: [u8; 32],
        a_nonce: u128,
        a_ct_side: [u8; 32],
        a_ct_price: [u8; 32],
        a_ct_qty: [u8; 32],
        b_pubkey: [u8; 32],
        b_nonce: u128,
        b_ct_side: [u8; 32],
        b_ct_price: [u8; 32],
        b_ct_qty: [u8; 32],
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // 1. Bind the ciphertexts to what the parties committed to on deposit.
        let batch = BatchView::load(&ctx.accounts.batch)?;
        require!(batch.batch_id == batch_id, ErrorCode::BatchMismatch);
        require!(batch.state == BATCH_STATE_OPEN, ErrorCode::BatchNotOpen);
        require!(
            batch.parties[0].wallet != Pubkey::default() && batch.parties[1].wallet != Pubkey::default(),
            ErrorCode::MissingDeposit
        );
        require!(
            order_commitment(&a_pubkey, a_nonce, &a_ct_side, &a_ct_price, &a_ct_qty) == batch.parties[0].commitment,
            ErrorCode::CommitmentMismatch
        );
        require!(
            order_commitment(&b_pubkey, b_nonce, &b_ct_side, &b_ct_price, &b_ct_qty) == batch.parties[1].commitment,
            ErrorCode::CommitmentMismatch
        );

        // 2. Reference price from the oracle account, never from the caller.
        //    The feed it must carry is the one registered for the batch's pool.
        let market = &ctx.accounts.market;
        require!(market.pool == batch.pool, ErrorCode::MarketMismatch);
        let clock = Clock::get()?;
        let price = read_price_feed(
            &ctx.accounts.price_update,
            &clock,
            &market.feed_id,
            cfg!(feature = "mock-oracle"),
        )?;

        let result = &mut ctx.accounts.match_result;
        result.bump = ctx.bumps.match_result;
        result.batch_id = batch_id;
        result.computation_offset = computation_offset;
        result.matched = false;
        result.clearing_price = 0;
        result.finalized = false;
        result.qty = 0;
        result.a_is_buyer = false;
        result.reference_price = price.price_micro;
        result.oracle_publish_time = price.publish_time;
        result.queued_slot = clock.slot;

        let args = ArgBuilder::new()
            .x25519_pubkey(a_pubkey)
            .plaintext_u128(a_nonce)
            .encrypted_bool(a_ct_side)
            .encrypted_u64(a_ct_price)
            .encrypted_u64(a_ct_qty)
            .x25519_pubkey(b_pubkey)
            .plaintext_u128(b_nonce)
            .encrypted_bool(b_ct_side)
            .encrypted_u64(b_ct_price)
            .encrypted_u64(b_ct_qty)
            .plaintext_u64(price.price_micro)
            .plaintext_u64(batch.sol_bucket)
            .plaintext_u64(batch.usdc_bucket)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![MatchOrdersV2Callback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.match_result.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;

        emit!(BatchQueuedEvent {
            batch_id,
            match_result: ctx.accounts.match_result.key(),
            reference_price: price.price_micro,
        });

        Ok(())
    }

    /// Invoked by the Arcium cluster with the signed, revealed `MatchResult`.
    #[arcium_callback(encrypted_ix = "match_orders_v2")]
    pub fn match_orders_v2_callback(
        ctx: Context<MatchOrdersV2Callback>,
        output: SignedComputationOutputs<MatchOrdersV2Output>,
    ) -> Result<()> {
        // The circuit reveals { matched: bool, clearing_price: u64, qty: u64,
        // a_is_buyer: bool }. arcium-anchor generates nested `field_N`
        // wrappers for it. If `arcium build` complains, open target/ for the
        // generated `MatchOrdersV2Output` and adjust this pattern.
        let (matched, clearing_price, qty, a_is_buyer) = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(MatchOrdersV2Output {
                field_0:
                    MatchOrdersV2OutputStruct0 {
                        field_0: matched,
                        field_1: clearing_price,
                        field_2: qty,
                        field_3: a_is_buyer,
                    },
            }) => (matched, clearing_price, qty, a_is_buyer),
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let result = &mut ctx.accounts.match_result;
        result.matched = matched;
        result.clearing_price = clearing_price;
        result.qty = qty;
        result.a_is_buyer = a_is_buyer;
        result.finalized = true;

        emit!(MatchEvent {
            batch_id: result.batch_id,
            matched,
        });

        Ok(())
    }

    /// Localnet only. Writes a Pyth-shaped price account for `feed_id` owned
    /// by this program so `arcium test` can exercise the oracle path without
    /// the Pyth receiver. Compiled to a hard error unless the `mock-oracle`
    /// feature is on.
    pub fn set_mock_price(
        ctx: Context<SetMockPrice>,
        feed_id: [u8; 32],
        price: i64,
        conf: u64,
        exponent: i32,
        publish_time: i64,
    ) -> Result<()> {
        #[cfg(not(feature = "mock-oracle"))]
        {
            let _ = (ctx, feed_id, price, conf, exponent, publish_time);
            return Err(ErrorCode::MockOracleDisabled.into());
        }
        #[cfg(feature = "mock-oracle")]
        {
            use anchor_lang::system_program::{create_account, CreateAccount};
            let len = oracle::PRICE_UPDATE_V2_FULL_LEN;
            let acc = &ctx.accounts.mock_price;
            if acc.data_is_empty() {
                let bump = ctx.bumps.mock_price;
                let seeds: &[&[u8]] = &[MOCK_PRICE_SEED, &feed_id, &[bump]];
                create_account(
                    CpiContext::new_with_signer(
                        ctx.accounts.system_program.key(),
                        CreateAccount {
                            from: ctx.accounts.payer.to_account_info(),
                            to: acc.to_account_info(),
                        },
                        &[seeds],
                    ),
                    Rent::get()?.minimum_balance(len),
                    len as u64,
                    &crate::ID,
                )?;
            }
            let bytes = oracle::encode_full_update(
                ctx.accounts.payer.key(),
                feed_id,
                price,
                conf,
                exponent,
                publish_time,
                Clock::get()?.slot,
            );
            let mut data = acc.try_borrow_mut_data()?;
            require!(data.len() >= bytes.len(), ErrorCode::MockAccountTooSmall);
            data[..bytes.len()].copy_from_slice(&bytes);
            Ok(())
        }
    }
}

/// Public outcome of one batch. Read by the settlement program, which keeps a
/// Borsh mirror of this struct: do not reorder fields.
#[account]
#[derive(InitSpace)]
pub struct MatchResult {
    pub bump: u8,
    pub batch_id: u64,
    pub computation_offset: u64,
    pub matched: bool,
    pub clearing_price: u64,
    pub finalized: bool,
    /// Fill size in base-asset units, 9 dp (0 when not matched).
    pub qty: u64,
    /// Whether party slot 0 of the batch is the buyer (false when not matched).
    pub a_is_buyer: bool,
    /// Oracle reference price (USDC 6 dp per base unit) verified on-chain at queue time.
    pub reference_price: u64,
    /// Pyth publish time of that reference price.
    pub oracle_publish_time: i64,
    /// Slot in which the computation was queued.
    pub queued_slot: u64,
}

/// Which Pyth feed prices a settlement pool. Seeded by the pool key.
#[account]
#[derive(InitSpace)]
pub struct MarketConfig {
    pub bump: u8,
    pub pool: Pubkey,
    pub feed_id: [u8; 32],
}

/// Borsh prefix of `settlement::Batch` (after the 8-byte discriminator).
/// Only the leading fields are needed here; trailing fields are ignored by
/// the deserializer. Keep in sync with programs/settlement.
#[derive(AnchorDeserialize, Clone, Copy)]
pub struct PartyView {
    pub wallet: Pubkey,
    pub payout: Pubkey,
    pub commitment: [u8; 32],
}

#[derive(AnchorDeserialize, Clone)]
pub struct BatchView {
    pub bump: u8,
    pub batch_id: u64,
    pub creator: Pubkey,
    pub pool: Pubkey,
    pub sol_bucket: u64,
    pub usdc_bucket: u64,
    pub parties: [PartyView; 2],
    pub state: u8,
}

/// `settlement::BatchState::Open` as a Borsh enum tag.
pub const BATCH_STATE_OPEN: u8 = 0;

impl BatchView {
    pub fn load(acc: &UncheckedAccount) -> Result<Self> {
        let data = acc.try_borrow_data()?;
        require!(data.len() > 8, ErrorCode::BadBatch);
        let mut slice: &[u8] = &data[8..];
        BatchView::deserialize(&mut slice).map_err(|_| ErrorCode::BadBatch.into())
    }
}

#[queue_computation_accounts("match_orders_v2", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, batch_id: u64)]
pub struct MatchOrders<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + MatchResult::INIT_SPACE,
        seeds = [MATCH_SEED, &batch_id.to_le_bytes()],
        bump,
    )]
    pub match_result: Box<Account<'info, MatchResult>>,
    /// CHECK: settlement Batch PDA; owner + seeds enforced here, layout in BatchView::load.
    #[account(
        owner = SETTLEMENT_PROGRAM_ID,
        seeds = [BATCH_SEED, &batch_id.to_le_bytes()],
        bump,
        seeds::program = SETTLEMENT_PROGRAM_ID,
    )]
    pub batch: UncheckedAccount<'info>,
    /// Feed registered for `batch.pool`; the pool equality is checked in the handler.
    #[account(seeds = [MARKET_SEED, market.pool.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, MarketConfig>>,
    /// CHECK: Pyth PriceUpdateV2 for the market's feed; fully validated in oracle::read_price_feed.
    pub price_update: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_MATCH_ORDERS))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("match_orders_v2")]
#[derive(Accounts)]
pub struct MatchOrdersV2Callback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_MATCH_ORDERS))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: UncheckedAccount<'info>,
    // Custom callback account: must be the first after the six standard ones.
    #[account(mut)]
    pub match_result: Account<'info, MatchResult>,
}

#[init_computation_definition_accounts("match_orders_v2", payer)]
#[derive(Accounts)]
pub struct InitMatchOrdersCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: a settlement Pool account; only its key is recorded.
    #[account(owner = SETTLEMENT_PROGRAM_ID)]
    pub pool: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + MarketConfig::INIT_SPACE,
        seeds = [MARKET_SEED, pool.key().as_ref()],
        bump,
    )]
    pub market: Account<'info, MarketConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct SetMockPrice<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: raw PDA holding a PriceUpdateV2 image; created on first use (mock-oracle builds only).
    #[account(mut, seeds = [MOCK_PRICE_SEED, &feed_id], bump)]
    pub mock_price: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct MarketRegistered {
    pub pool: Pubkey,
    pub feed_id: [u8; 32],
}

#[event]
pub struct BatchQueuedEvent {
    pub batch_id: u64,
    pub match_result: Pubkey,
    pub reference_price: u64,
}

/// Deliberately minimal: the fill details live in the MatchResult PDA and in
/// the settlement transfers; repeating them in a log adds nothing but noise.
#[event]
pub struct MatchEvent {
    pub batch_id: u64,
    pub matched: bool,
}

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Batch account could not be decoded")]
    BadBatch,
    #[msg("Batch id does not match")]
    BatchMismatch,
    #[msg("Batch is not open")]
    BatchNotOpen,
    #[msg("Both parties must deposit before matching")]
    MissingDeposit,
    #[msg("Encrypted order does not match the commitment recorded at deposit")]
    CommitmentMismatch,
    #[msg("Feed id must not be empty")]
    EmptyFeedId,
    #[msg("Market config does not belong to the batch's pool")]
    MarketMismatch,
    #[msg("Mock oracle is not compiled into this build")]
    MockOracleDisabled,
    #[msg("Mock price account is too small")]
    MockAccountTooSmall,
    // --- oracle (see oracle.rs) ---
    #[msg("Price account is not owned by the Pyth receiver program")]
    BadOwner,
    #[msg("Price account has the wrong discriminator")]
    BadDiscriminator,
    #[msg("Price account could not be decoded")]
    BadLayout,
    #[msg("Price update is not fully verified")]
    NotFullyVerified,
    #[msg("Price account does not carry the market's feed")]
    WrongFeed,
    #[msg("Oracle price is not positive")]
    NonPositivePrice,
    #[msg("Oracle confidence interval is too wide")]
    ConfidenceTooWide,
    #[msg("Oracle price is stale")]
    StalePrice,
    #[msg("Math overflow")]
    MathOverflow,
}
