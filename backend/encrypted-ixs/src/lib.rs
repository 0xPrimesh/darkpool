//! Dark pool matching circuit.
//!
//! Each party encrypts a whole order `{ is_buy, price, qty }` for the MXE
//! (`Enc<Shared, OrderInput>`). Inside MPC we work out which party is the
//! buyer, whether the bid crosses the ask, whether both want the same size,
//! and whether the escrowed collateral buckets cover the fill. Only the
//! `MatchResult` below is revealed: side, limit prices and sizes of an
//! unmatched batch never leave MPC, and for a matched batch only the fill
//! itself (which settlement has to execute anyway) becomes public.
//!
//! Prices are u64 in USDC base units (6 decimals) per 1 SOL. Quantities are
//! SOL-mock base units (9 decimals). `reference_price`, `sol_bucket` and
//! `usdc_bucket` are plaintext: the MXE program reads the reference from the
//! Pyth account on-chain and the buckets from the settlement batch, so none
//! of them is chosen by whoever submits the transaction.

use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// One party's order. `is_buy == true` means "buy SOL for USDC at most
    /// `price` per SOL"; `false` means "sell SOL for USDC at least `price`".
    pub struct OrderInput {
        pub is_buy: bool,
        pub price: u64,
        pub qty: u64,
    }

    /// Public output of a batch. Everything is zero / false when
    /// `matched == false`, so an unmatched batch leaks nothing.
    pub struct MatchResult {
        pub matched: bool,
        pub clearing_price: u64,
        pub qty: u64,
        /// Which slot is the buyer. Settlement needs this to route the legs.
        pub a_is_buyer: bool,
    }

    /// Match two encrypted orders.
    ///
    /// Clearing rule (unchanged from the price-only circuit):
    ///   * no cross (bid < ask)                          -> no match
    ///   * cross and reference_price in [ask, bid]       -> reference_price
    ///   * cross otherwise                               -> (bid + ask) / 2
    ///
    /// Additional conditions for a match:
    ///   * the two orders are on opposite sides
    ///   * both orders have the same quantity (one fill per batch, no partials)
    ///   * qty > 0, qty <= sol_bucket and qty * price <= usdc_bucket (scaled),
    ///     i.e. the escrowed collateral of either party covers the fill.
    ///
    /// In MPC both arms of every `if` are evaluated and the encrypted bool
    /// only selects the result, so control flow leaks nothing.
    #[instruction]
    pub fn match_orders_v2(
        a_ctxt: Enc<Shared, OrderInput>,
        b_ctxt: Enc<Shared, OrderInput>,
        reference_price: u64,
        sol_bucket: u64,
        usdc_bucket: u64,
    ) -> MatchResult {
        let a = a_ctxt.to_arcis();
        let b = b_ctxt.to_arcis();

        let opposite = a.is_buy != b.is_buy;
        let bid = if a.is_buy { a.price } else { b.price };
        let ask = if a.is_buy { b.price } else { a.price };
        let crosses = bid >= ask;
        let same_qty = a.qty == b.qty;
        let qty = a.qty;

        // u64 add cannot overflow for realistic prices (< 2^63 each).
        let midpoint = (bid + ask) / 2;
        let use_reference =
            reference_price != 0 && reference_price >= ask && reference_price <= bid;
        let price = if use_reference { reference_price } else { midpoint };

        // usdc_owed = qty * price / 1e9. Compare without dividing: both sides
        // are scaled by 1e9 so a u128 product is exact.
        let usdc_owed_scaled = (qty as u128) * (price as u128);
        let usdc_bucket_scaled = (usdc_bucket as u128) * 1_000_000_000u128;
        let covered = qty > 0 && qty <= sol_bucket && usdc_owed_scaled <= usdc_bucket_scaled;

        let matched = opposite && crosses && same_qty && covered;

        MatchResult {
            matched,
            clearing_price: if matched { price } else { 0 },
            qty: if matched { qty } else { 0 },
            a_is_buyer: if matched { a.is_buy } else { false },
        }
        .reveal()
    }
}
