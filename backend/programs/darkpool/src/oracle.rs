//! On-chain read of a Pyth `PriceUpdateV2` account (pyth-solana-receiver).
//!
//! The account is parsed directly from its Borsh layout so this crate does
//! not depend on the Pyth SDK (which pins an older anchor-lang). Layout:
//!
//!   8  discriminator  sha256("account:PriceUpdateV2")[..8]
//!   32 write_authority
//!   1  verification_level tag (0 = Partial { num_signatures: u8 }, 1 = Full)
//!   PriceFeedMessage { feed_id [u8;32], price i64, conf u64, exponent i32,
//!                      publish_time i64, prev_publish_time i64,
//!                      ema_price i64, ema_conf u64 }
//!   8  posted_slot
//!
//! Checks performed, in order: owner, discriminator, verification level,
//! feed id, price sign, confidence interval, staleness. Any failure aborts
//! the instruction, so a transaction can never queue a computation with a
//! reference price the relayer chose.

use anchor_lang::prelude::*;
use crate::ErrorCode as OracleError;

/// pyth-solana-receiver program (same id on devnet and mainnet).
pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey = pubkey!("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");

/// Pyth SOL/USD feed id (ef0d8b6f...b56d). Each market's feed id lives in
/// its `MarketConfig`; this constant is only a convenience for tests.
pub const SOL_USD_FEED_ID: [u8; 32] = [
    239, 13, 139, 111, 218, 44, 235, 164, 29, 161, 93, 64, 149, 209, 218, 57, 42, 13, 47, 142,
    208, 198, 199, 188, 15, 76, 250, 200, 194, 128, 181, 109,
];

/// sha256("account:PriceUpdateV2")[..8]
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

/// Serialized size of a PriceUpdateV2 with `VerificationLevel::Full`.
pub const PRICE_UPDATE_V2_FULL_LEN: usize = 8 + 32 + 1 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8;

/// Reject prices published more than this many seconds before the current
/// slot's unix timestamp. The sponsored SOL/USD feed updates every few
/// seconds; equity feeds only tick during market hours, so an equity market
/// cannot match while its exchange is closed.
pub const MAX_PRICE_AGE_SECS: i64 = 60;

/// Reject prices whose confidence interval exceeds this fraction of the
/// price (basis points). 100 bps = 1 %.
pub const MAX_CONFIDENCE_BPS: u128 = 100;

#[derive(AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum VerificationLevel {
    Partial { num_signatures: u8 },
    Full,
}

#[derive(AnchorDeserialize, Clone, Copy, Debug)]
pub struct PriceFeedMessage {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
    pub prev_publish_time: i64,
    pub ema_price: i64,
    pub ema_conf: u64,
}

#[derive(AnchorDeserialize, Clone, Copy, Debug)]
pub struct PriceUpdateV2 {
    pub write_authority: Pubkey,
    pub verification_level: VerificationLevel,
    pub price_message: PriceFeedMessage,
    pub posted_slot: u64,
}

/// A reference price that passed every check, in USDC base units (6 dp) per
/// whole unit of the market's base asset.
#[derive(Clone, Copy, Debug)]
pub struct VerifiedPrice {
    pub price_micro: u64,
    pub publish_time: i64,
}

/// Scale a Pyth (price, exponent) pair to 6 decimals.
pub fn to_micro(price: i64, exponent: i32) -> Result<u64> {
    require!(price > 0, OracleError::NonPositivePrice);
    let shift = exponent + 6;
    let v: i128 = if shift >= 0 {
        (price as i128)
            .checked_mul(10i128.pow(shift as u32))
            .ok_or(OracleError::MathOverflow)?
    } else {
        (price as i128) / 10i128.pow((-shift) as u32)
    };
    u64::try_from(v).map_err(|_| OracleError::MathOverflow.into())
}

/// Parse and validate a Pyth price account for `feed_id` (the market's feed,
/// e.g. SOL/USD or XAU/USD). `allow_self_owned` lets a mock account owned by
/// this program through; the caller only sets it when the `mock-oracle`
/// feature is compiled in.
pub fn read_price_feed(
    acc: &AccountInfo,
    clock: &Clock,
    feed_id: &[u8; 32],
    allow_self_owned: bool,
) -> Result<VerifiedPrice> {
    let owner_ok = *acc.owner == PYTH_RECEIVER_PROGRAM_ID
        || (allow_self_owned && *acc.owner == crate::ID);
    require!(owner_ok, OracleError::BadOwner);

    let data = acc.try_borrow_data()?;
    require!(data.len() >= 8, OracleError::BadLayout);
    require!(data[..8] == PRICE_UPDATE_V2_DISCRIMINATOR, OracleError::BadDiscriminator);

    let mut slice: &[u8] = &data[8..];
    let update = PriceUpdateV2::deserialize(&mut slice).map_err(|_| OracleError::BadLayout)?;

    require!(update.verification_level == VerificationLevel::Full, OracleError::NotFullyVerified);
    let m = update.price_message;
    require!(m.feed_id == *feed_id, OracleError::WrongFeed);
    require!(m.price > 0, OracleError::NonPositivePrice);

    // conf / price <= MAX_CONFIDENCE_BPS / 10_000
    let conf_bps = (m.conf as u128)
        .checked_mul(10_000)
        .ok_or(OracleError::MathOverflow)?
        / (m.price as u128);
    require!(conf_bps <= MAX_CONFIDENCE_BPS, OracleError::ConfidenceTooWide);

    let age = clock.unix_timestamp.saturating_sub(m.publish_time);
    require!(age <= MAX_PRICE_AGE_SECS, OracleError::StalePrice);

    Ok(VerifiedPrice {
        price_micro: to_micro(m.price, m.exponent)?,
        publish_time: m.publish_time,
    })
}

/// Serialize a `PriceUpdateV2` with `VerificationLevel::Full` exactly as the
/// Pyth receiver would. Used by the mock oracle on localnet.
pub fn encode_full_update(
    write_authority: Pubkey,
    feed_id: [u8; 32],
    price: i64,
    conf: u64,
    exponent: i32,
    publish_time: i64,
    posted_slot: u64,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(PRICE_UPDATE_V2_FULL_LEN);
    out.extend_from_slice(&PRICE_UPDATE_V2_DISCRIMINATOR);
    let update = PriceUpdateV2 {
        write_authority,
        verification_level: VerificationLevel::Full,
        price_message: PriceFeedMessage {
            feed_id,
            price,
            conf,
            exponent,
            publish_time,
            prev_publish_time: publish_time - 1,
            ema_price: price,
            ema_conf: conf,
        },
        posted_slot,
    };
    out.extend_from_slice(&write_authority.to_bytes());
    out.push(1); // VerificationLevel::Full
    // PriceFeedMessage + posted_slot, field by field (Borsh LE)
    out.extend_from_slice(&update.price_message.feed_id);
    out.extend_from_slice(&update.price_message.price.to_le_bytes());
    out.extend_from_slice(&update.price_message.conf.to_le_bytes());
    out.extend_from_slice(&update.price_message.exponent.to_le_bytes());
    out.extend_from_slice(&update.price_message.publish_time.to_le_bytes());
    out.extend_from_slice(&update.price_message.prev_publish_time.to_le_bytes());
    out.extend_from_slice(&update.price_message.ema_price.to_le_bytes());
    out.extend_from_slice(&update.price_message.ema_conf.to_le_bytes());
    out.extend_from_slice(&update.posted_slot.to_le_bytes());
    out
}
