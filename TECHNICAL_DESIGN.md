# PriMesh (dark pool on Solana): Technical Design

**Status:** Hackathon design doc · **As of:** 2026-10-10 (revised after the devnet transaction review) · **Target:** Solana devnet + Arcium devnet cluster (offset 456)

> **Revision 2026-10-10.** A review of the devnet transactions found four things worth fixing before anything else: the relayer passed the reference price as a plain number; order size was public in `create_batch`; side was public through two deposit instructions; one vault per batch linked the whole lifecycle. Sections 2, 3.4, 3.5, 3.7, 4.1, 4.3 and 5.6 below describe the revised design: the reference price is read from Pyth **on-chain**, the whole order `{side, price, qty}` is encrypted and bound to the deposit by a hash commitment, every party escrows identical collateral buckets of **both** assets into **shared** pool vaults, and the settlement event carries only the batch id. Code blocks are abridged; the source is authoritative.

A minimal institutional dark pool: two parties submit encrypted limit orders, an Arcium MXE
(Multi-party eXecution Environment) decides privately whether they cross and at what price, and a
Solana program settles the swap atomically into Umbra stealth addresses. No one on-chain sees the
bid, the ask, or which institution received the fill.

The work is split into **three phases**. Phase 1 is the core and must ship first; Phases 2 and 3 are
additive layers on top of it. Each phase has its own exit criteria and can be demoed on its own.

| Phase | Name | Delivers | Demo-able as |
| --- | --- | --- | --- |
| **1** | **Core: encrypted match + atomic settlement** | Arcis circuit, MXE Anchor program, settlement program, mock tokens, one end-to-end script | "Two encrypted limit orders match privately on Arcium and settle atomically on devnet" |
| 2 | Coordinator + terminal UI + mock price | 30 s batching server, two-terminal CLI, hardcoded SOL/USDC reference price | "A live dark pool you can trade on from two terminals" |
| 3 | Privacy settlement + oracle + polish | Umbra stealth payouts, optional Pyth feed, demo script, README | "Fills land on stealth addresses with no link to the institution's wallet" |

---

## 1. Overview

### Goal

Demonstrate end to end, on devnet, that a limit-order match can be computed on **encrypted** prices
and settled **atomically** and **unlinkably**:

| Property | Mechanism | Phase |
| --- | --- | --- |
| Side, limit price and size never leave the client in plaintext | Arcis circuit over `Enc<Shared, OrderInput>` inputs, MPC on Arcium | 1 |
| Only the fill becomes public; an unmatched batch reveals nothing | `.reveal()` on `{matched, clearing_price, qty, a_is_buyer}`, all zero when unmatched | 1 |
| Deposits do not reveal side or size | Every party escrows the same two collateral buckets; side and size are in the ciphertext | 1 (rev.) |
| Nobody can substitute orders or the reference price | Deposit commits to the ciphertext hash; `match_orders` recomputes it and reads Pyth on-chain | 1 (rev.) |
| Both legs settle or neither | Single Solana transaction, collateral netted out of shared pool vaults | 1 |
| Orders are collected and matched in timed batches | Node.js coordinator, 30 s window | 2 |
| Fill is not linked to the recipient's main wallet | Payout to a one-time Umbra stealth destination | 3 |

### Non-goals (explicitly out for the hackathon)

- Multi-order books, partial fills, price-time priority. **One buyer, one seller per batch.**
- Market orders. **Limit orders only.**
- Decentralized or trust-minimized coordinator (it is a single Node process).
- Mainnet deployment, audits, fee model.

---

## 2. System Architecture (all phases)

```
┌──────────────┐        ┌──────────────┐
│  Buyer CLI   │        │  Seller CLI  │        Phase 2
│  bid, qty    │        │  ask, qty    │
└──────┬───────┘        └──────┬───────┘
       │ encrypted order (x25519 + Rescue)   │
       ▼                                     ▼
┌─────────────────────────────────────────────────────┐
│           Batch coordinator (Node.js)   Phase 2     │
│  • 30 s window   • encrypt inputs   • queue MXE     │
│  • await callback • call settlement • notify CLIs   │
└──────┬──────────────────────────────┬───────────────┘
       │ queue_computation (CPI)       │ settle(batch_id)
       ▼                               ▼
┌──────────────────────┐     ┌──────────────────────────┐
│  MXE Anchor program  │     │  Settlement program       │
│  Phase 1             │     │  Phase 1                  │
│  match_orders ix     │     │  escrow PDAs (SOL, USDC)  │
│  match_orders_cb  ◄──┼──┐  │  atomic 2-leg transfer    │
└──────────────────────┘  │  │  → Umbra stealth dest     │ Phase 3
                          │  └──────────────────────────┘
┌──────────────────────┐  │
│  Arcium MPC cluster  │──┘  signed output
│  (devnet, offset 456)│     (matched, clearing_price)
│  runs Arcis circuit  │     Phase 1
└──────────────────────┘
```

In Phase 1 the "coordinator" is a single TypeScript script run by hand; in Phase 2 it becomes a server
with a batch window; in Phase 3 its payout leg targets stealth addresses.

### Data flow for one batch

1. Each party encrypts `{is_buy, limit_price, qty}` for the MXE in its own client and hashes the ciphertext
   tuple into a 32-byte commitment.
2. Each party deposits the batch's two collateral buckets (`sol_bucket` SOL-mock **and** `usdc_bucket`
   USDC-mock, identical for both parties) into the shared pool vaults with that commitment and a payout
   destination. The deposit is the same instruction with the same amounts whichever side the party is on.
3. The coordinator holds the ciphertexts for a 30 s window (Phase 2). When the window closes with two
   parties it calls `match_orders` with both ciphertexts and the Pyth SOL/USD account.
4. `match_orders` recomputes both commitments against the `Batch`, parses and validates the Pyth account
   (owner, feed, full verification, confidence ≤ 1 %, age ≤ 60 s), records the verified reference in the
   `MatchResult` PDA, and CPIs into Arcium `queue_computation` with the reference and buckets as plaintext.
5. The cluster invokes `match_orders_callback` with signed outputs. The callback verifies the signature and
   stores `{matched, clearing_price, qty, a_is_buyer}` in the `MatchResult` PDA.
6. The coordinator (or anyone) calls `settle`. The settlement program re-reads the `MatchResult` PDA, checks
   it is the darkpool program's PDA for this batch, and pays each party its two buckets netted by the fill
   (buyer `+qty` SOL-mock / `−qty × price` USDC-mock, seller the reverse) in one transaction. If unmatched,
   `cancel` refunds both buckets.
7. UIs show the fill and the Explorer link (Phase 2). Recipients later scan/claim via Umbra (Phase 3).

### Trust boundaries

| Party | Sees | Does not see |
| --- | --- | --- |
| Arcium nodes (individually) | Ciphertexts, secret shares | Any plaintext side / price / size (dishonest-majority MPC assumption) |
| Coordinator | Who deposited into which batch, the fill once revealed | Side, limit price and size before the fill; it cannot substitute orders (commitments) or the reference price (Pyth read on-chain) |
| Relayer wallet | Nothing beyond the coordinator | Cannot choose the reference price; can only choose *when* within the 60 s staleness bound |
| Chain observers | Identical bucket deposits, `MatchResult` PDA (fill + reference), settlement netting | Limit prices; side and size of an unmatched batch; after Phase 3, the link between fill and recipient's primary wallet |
| Counterparty | Clearing price, fill size | The other side's limit price |

**Markets.** The pool/batch machinery is per mint pair, so a market is one settlement pool
(`<base>-mock` / `USDC-mock`) plus one Pyth feed. The darkpool program keeps a `MarketConfig` PDA per
pool (`register_market`, permissionless, write-once) holding the feed id, and `match_orders` takes it
alongside the price account: `market.pool == batch.pool` and `price.feed_id == market.feed_id` are
enforced on-chain, so a gold batch can never be priced with SOL/USD. Base mocks all have 9 dp, so the
circuit and settlement math are market-agnostic. Shipped markets: `SOL` (Pyth-sponsored push account on
devnet, pushed about once a minute) and `XAU`, gold (push account exists on devnet but nobody sponsors
it, so the coordinator writes Hermes updates into it itself and honours the metals schedule from
Hermes' listing). Each market has its own collateral tier (`<SYMBOL>_BUCKET`; gold's is 0.1 oz). Hermes
entitlements are per asset class, so the key must cover the market's class. The coordinator runs an
independent batch engine per market and the trade book is split by the batch's pool.

> **Honest caveat:** once a batch settles, the netting amounts reveal who bought and how much. Deposits
> are from the primary wallets. Umbra (Phase 3) hides the *receive* side of the fill; bucketed refunds and
> deposits from ETAs are the upgrade path for the rest. See section 6.

---

## 3. Phase 1 — Core: Encrypted Match + Atomic Settlement

**Goal:** prove the thesis with the fewest moving parts. One script encrypts a bid and an ask, queues the
MXE on Arcium devnet, waits for the callback, and settles atomically on Solana devnet.

**Exit criteria**

- [ ] `arcium test` passes locally: `(bid=152, ask=148) → (true, 150)`, `(bid=148, ask=152) → (false, 0)`.
- [ ] MXE deployed to Arcium devnet (offset 456); `MatchResult` PDA populated by the callback.
- [ ] Settlement program on devnet: two-leg transfer succeeds; forcing leg 2 to fail reverts leg 1.
- [ ] `scripts/e2e.ts` runs the full flow and prints a devnet Explorer link.

### 3.1 What "Arcium testnet" means today

Arcium's public testnet launched 1 May 2025, and Mainnet Alpha followed in February 2026. For builders,
"testnet" means deploying an MXE against the **Arcium devnet cluster on Solana devnet**. The CLI selects it
with `--cluster-offset 456` (mainnet is `2026`). Sources: [Arcium deployment docs](https://docs.arcium.com/developers/deployment),
[Messari: Mainnet Alpha](https://messari.io/report/arcium-mainnet-alpha-release).

### 3.2 Toolchain

| Tool | Version (per docs) | Notes |
| --- | --- | --- |
| Rust | latest stable | |
| Solana CLI | 3.1.10 | `solana-keygen new` for the deployer |
| Anchor | 1.0.2 | |
| Yarn, Docker + Compose | latest | Docker needed for local `arcium test` |
| arcup / arcium CLI | arcup 0.15.0 | `curl --proto '=https' --tlsv1.2 -sSfL https://install.arcium.com/ \| bash` then `arcup install` |

Windows is unsupported; use WSL2. Source: [Installation](https://docs.arcium.com/developers/installation).

```bash
arcium init darkpool          # Anchor layout + Arcium.toml + encrypted-ixs/
arcium build
arcium test                   # local cluster (Docker)
arcium test --cluster devnet  # against Arcium devnet
```

### 3.3 Project layout

```
darkpool/
├── Arcium.toml
├── encrypted-ixs/
│   └── match_orders.rs            # Arcis circuit (MPC)              Phase 1
├── programs/darkpool/src/lib.rs   # #[arcium_program] wrapper        Phase 1
├── programs/settlement/src/lib.rs # plain Anchor settlement          Phase 1
├── scripts/e2e.ts                 # hand-run end-to-end flow         Phase 1
├── coordinator/                   # Node.js batch coordinator        Phase 2
├── cli/                           # terminal UI                      Phase 2
└── privacy/                       # Umbra / stealth helpers          Phase 3
```

### 3.4 The Arcis matching circuit

Design decisions:

- **Inputs** are `Enc<Shared, OrderInput { is_buy, price, qty }>`: each party encrypts its whole order
  client-side with a shared secret (x25519 ECDH with the MXE key, Rescue cipher, three ciphertexts under
  one nonce). The circuit works out which party is the buyer; nothing outside MPC knows the side.
- **Plaintext inputs** `reference_price`, `sol_bucket`, `usdc_bucket` are supplied by the MXE *program*
  (from the Pyth account and the settlement `Batch`), never by the transaction sender.
- **Output** is **revealed** (`.reveal()`), because the settlement program needs the fill in plaintext
  on-chain. Everything is zero when unmatched, so a failed batch does not even say why it failed.
- **Clearing price rule:** if `bid >= ask`, clear at the **midpoint** `(bid + ask) / 2`. If a reference
  price is supplied (Phase 2) and lies inside `[ask, bid]`, clear at the reference instead (classic
  dark-pool "midpoint of NBBO" behaviour). In Phase 1 pass `reference_price = 0`. Both branches are always
  evaluated in MPC; the condition only selects the result, so no information leaks through control flow.
- Prices are `u64` in USDC base units (6 decimals) per 1 SOL. `u64` avoids float emulation overhead.

```rust
// encrypted-ixs/match_orders.rs
use arcis_imports::*;

#[encrypted]
mod circuits {
    use arcis_imports::*;

    pub struct BidInput {
        pub price: u64,      // max USDC (6 dp) per SOL the buyer will pay
    }

    pub struct AskInput {
        pub price: u64,      // min USDC (6 dp) per SOL the seller will accept
    }

    /// Returns (matched, clearing_price). Both revealed; inputs stay secret.
    #[instruction]
    pub fn match_orders(
        bid_ctxt: Enc<Shared, BidInput>,
        ask_ctxt: Enc<Shared, AskInput>,
        reference_price: u64,          // plaintext, 0 = "no reference, use midpoint"
    ) -> (bool, u64) {
        let bid = bid_ctxt.to_arcis().price;
        let ask = ask_ctxt.to_arcis().price;

        let crosses = bid >= ask;

        // Midpoint; both branches below are evaluated, the secret bool selects.
        let midpoint = (bid + ask) / 2;

        let use_reference = reference_price != 0
            && reference_price >= ask
            && reference_price <= bid;

        let price = if use_reference { reference_price } else { midpoint };

        // If no cross, publish 0 so observers learn nothing about the midpoint.
        let clearing = if crosses { price } else { 0 };

        (crosses.reveal(), clearing.reveal())
    }
}
```

Why this is safe to reveal: when `crosses == false` the output is `(false, 0)`, which leaks nothing about
where bid and ask sit. When `crosses == true` the midpoint is revealed, which is the intended public fill
price. Observers cannot recover `bid` or `ask` individually from the midpoint.

Arcis rules that shaped this (source: [Arcis operations](https://docs.arcium.com/developers/arcis/operations),
[types](https://docs.arcium.com/developers/arcis/types), [input/output](https://arcium.mintlify.app/developers/arcis/input-output)):

- Comparisons `>=`, `<=`, `==` on encrypted ints return encrypted bools.
- `if/else` on an encrypted bool evaluates **both** branches (cost = sum); no early exit, no `break`, no
  variable-length loops. One buyer/one seller means no loops at all here.
- `to_arcis()` converts a ciphertext into secret shares; nodes never see plaintext.
- `reveal()` makes a value public; `owner.from_arcis(v)` would instead re-encrypt for the input's owner.

**Revised circuit (as implemented, `backend/encrypted-ixs/src/lib.rs`):** `match_orders(a: Enc<Shared, OrderInput>, b: Enc<Shared, OrderInput>, reference_price, sol_bucket, usdc_bucket) -> MatchResult { matched, clearing_price, qty, a_is_buyer }`. A match requires opposite sides, `bid >= ask`, equal quantities (no partial fills yet), `qty <= sol_bucket` and `qty × price <= usdc_bucket × 1e9` (u128, no division). Partial fills are the next step and need minimum-fill rules first (see §6.3).

### 3.5 The Anchor MXE program

Use `#[arcium_program]` instead of `#[program]`. Each encrypted instruction needs three handlers:
a one-time `init_*_comp_def`, a queue instruction, and a callback. Source: [Hello World](https://docs.arcium.com/developers/hello-world),
[Callback accounts](https://docs.arcium.com/developers/program/callback-accs).

```rust
// programs/darkpool/src/lib.rs (abridged)
use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

const COMP_DEF_OFFSET_MATCH: u32 = comp_def_offset("match_orders");

declare_id!("DarkPoo1...");

#[arcium_program]
pub mod darkpool {
    use super::*;

    pub fn init_match_orders_comp_def(ctx: Context<InitMatchOrdersCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, true, 0, None, None)?;
        Ok(())
    }

    pub fn match_orders(
        ctx: Context<MatchOrders>,
        computation_offset: u64,
        batch_id: u64,
        bid_pubkey: [u8; 32],   // buyer's x25519 pubkey
        bid_nonce: u128,
        bid_ct: [u8; 32],       // Enc<Shared, BidInput>
        ask_pubkey: [u8; 32],   // seller's x25519 pubkey
        ask_nonce: u128,
        ask_ct: [u8; 32],       // Enc<Shared, AskInput>
        reference_price: u64,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(bid_pubkey)
            .plaintext_u128(bid_nonce)
            .encrypted_u64(bid_ct)
            .x25519_pubkey(ask_pubkey)
            .plaintext_u128(ask_nonce)
            .encrypted_u64(ask_ct)
            .plaintext_u64(reference_price)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![MatchOrdersCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.match_result.key(),
                    is_writable: true,
                }],
            )?],
            1,      // number of txs
            0,      // priority fee
        )?;
        ctx.accounts.match_result.batch_id = batch_id;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "match_orders")]
    pub fn match_orders_callback(
        ctx: Context<MatchOrdersCallback>,
        output: SignedComputationOutputs<MatchOrdersOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(MatchOrdersOutput { field_0: o }) => o,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        let r = &mut ctx.accounts.match_result;
        r.matched = o.field_0;          // bool
        r.clearing_price = o.field_1;   // u64
        r.finalized = true;
        emit!(MatchEvent { batch_id: r.batch_id, matched: r.matched, clearing_price: r.clearing_price });
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct MatchResult {
    pub batch_id: u64,
    pub matched: bool,
    pub clearing_price: u64,
    pub finalized: bool,
}
// seeds = [b"match", batch_id.to_le_bytes()]
```

Account set for the queue instruction (auto-derived by Arcium macros): `payer`, `computation_account`,
`cluster_account`, `mxe_account`, `mempool_account`, `executing_pool`, `comp_def_account`,
`sign_pda_account`, plus our `match_result` PDA. The callback receives six standard Arcium accounts
followed by any `CallbackAccount`s we passed, in order; `is_writable: true` must pair with `#[account(mut)]`.

> Exact generated output type/field names (`MatchOrdersOutput`, `field_0`...) depend on the installed
> `arcium-anchor` version. Check the generated bindings after `arcium build` and adjust.

**Revised `match_orders` (as implemented):** arguments are `computation_offset, batch_id` and, per party,
`x25519_pubkey, nonce, ct_side, ct_price, ct_qty`. No price argument. Two extra accounts: the settlement
`Batch` PDA (owner and seeds checked, Borsh-mirrored as `BatchView`) and the Pyth `PriceUpdateV2`
(`oracle.rs`). Before queueing it requires both party slots filled, `sha256(pubkey || nonce_le || ct_side ||
ct_price || ct_qty)` equal to each slot's commitment, and the oracle checks listed in §2. `MatchResult`
gains `qty, a_is_buyer, reference_price, oracle_publish_time, queued_slot`. The callback event carries only
`batch_id` and `matched`. A `mock-oracle` cargo feature (localnet only) adds `set_mock_price`, which writes
a Pyth-shaped account owned by the program; production builds compile it to a hard error and never accept
a self-owned price account.

### 3.6 Client-side encryption

```ts
import { RescueCipher, x25519, getMXEPublicKeyWithRetry, awaitComputationFinalization } from "@arcium-hq/client";
import { randomBytes } from "crypto";

const mxePub = await getMXEPublicKeyWithRetry(provider, program.programId);

// Buyer side (same for seller)
const sk = x25519.utils.randomSecretKey();
const pk = x25519.getPublicKey(sk);
const shared = x25519.getSharedSecret(sk, mxePub);
const cipher = new RescueCipher(shared);
const nonce = randomBytes(16);
const [bidCt] = cipher.encrypt([BigInt(bidPriceMicroUsdc)], nonce);
```

In Phase 1 the e2e script encrypts both sides in one process. From Phase 2 each party encrypts on its
**own** machine (CLI) so the coordinator only ever handles ciphertext.
Source: [Encrypting inputs](https://docs.arcium.com/developers/js-client-library/encryption).

### 3.7 Settlement program (Solana devnet)

Requirements:

- Input: a finalized `MatchResult` PDA plus the two order records.
- Effect: transfer SOL-mock seller → buyer and USDC-mock buyer → seller **in one transaction**.
- Atomicity comes for free from Solana: a transaction either fully succeeds or is rolled back. The only
  design work is making sure *both transfers are in the same instruction* and that no leg needs a signer
  who is not present. Hence: **escrow first**.

Accounts:

| Account | Seeds | Purpose |
| --- | --- | --- |
| `Pool` | `["pool", sol_mint, usdc_mint]` | One per mint pair; owns the two shared vaults |
| `sol_vault` / `usdc_vault` | `["pool_vault", pool, mint]` | Token accounts shared by **all** batches, owned by `vault_authority` |
| `vault_authority` | `["pool_authority", pool]` | PDA signer for outbound transfers |
| `Batch` | `["batch", batch_id]` | `sol_bucket`, `usdc_bucket`, two party slots `{wallet, payout, commitment}`, state, fill |
| `MatchResult` | darkpool PDA `["match", batch_id]` | Read-only; owner, seeds, `batch_id`, `finalized && matched` checked |

Instructions:

```rust
#[program]
pub mod settlement {
    pub fn init_pool(ctx) -> Result<()>;                                   // once per mint pair
    pub fn create_batch(ctx, batch_id: u64, sol_bucket: u64, usdc_bucket: u64) -> Result<()>;
    pub fn deposit(ctx, batch_id: u64, commitment: [u8; 32], payout_dest: Pubkey) -> Result<()>;
    //   EVERY party escrows sol_bucket SOL-mock AND usdc_bucket USDC-mock, whichever side it is on,
    //   and records the sha256 of its ciphertext tuple. First depositor = slot A, second = slot B.
    pub fn settle(ctx, batch_id: u64) -> Result<()>;   // nets both buckets by the fill, pays both parties
    pub fn cancel(ctx, batch_id: u64) -> Result<()>;   // refunds both buckets if not matched / expired
}
```

The USDC bucket is sized from the **public** reference (`max_qty × reference × 125 %`), never from a bid.
A fill that would exceed either bucket simply does not match inside MPC; `settle` re-checks both bounds.

`settle` logic:

```rust
pub fn settle(ctx: Context<Settle>, batch_id: u64) -> Result<()> {
    let r = &ctx.accounts.match_result;
    require!(r.finalized && r.matched, DarkPoolError::NotMatched);
    require!(ctx.accounts.match_result.batch_id == batch_id, DarkPoolError::BatchMismatch);

    let qty = ctx.accounts.batch.qty_lamports;                      // SOL-mock, 9 dp
    let usdc_owed = (qty as u128 * r.clearing_price as u128 / 1_000_000_000) as u64; // USDC-mock, 6 dp

    let seeds = &[b"authority", &batch_id.to_le_bytes(), &[ctx.bumps.vault_authority]];

    // Leg 1: SOL-mock seller vault -> buyer payout ATA
    token::transfer(ctx.accounts.sol_leg().with_signer(&[seeds]), qty)?;
    // Leg 2: USDC-mock buyer vault -> seller payout ATA
    token::transfer(ctx.accounts.usdc_leg().with_signer(&[seeds]), usdc_owed)?;
    // Refund buyer's unused USDC bound
    token::transfer(ctx.accounts.usdc_refund().with_signer(&[seeds]), vault_balance - usdc_owed)?;

    ctx.accounts.batch.state = BatchState::Settled;
    Ok(())
}
```

Important checks: `match_result` must be owned by the MXE program id **and** be its PDA for this batch id;
`batch_id`, `finalized`, `matched` and both bucket bounds are checked; a batch settles once (`state`
goes `Open → Settled`); destination token accounts must be ATAs of the `payout_dest` pubkeys recorded at
deposit time (so the coordinator cannot redirect funds); `settle` is permissionless (anyone can crank it).
The `Settled` event carries only `batch_id`.

In Phase 1, `payout_dest` is simply each party's own wallet. Phase 3 swaps it for a stealth destination
without changing `settle`.

### 3.8 Mock SPL tokens on devnet

```bash
spl-token create-token --decimals 9   # "mSOL-mock"  -> SOL_MINT
spl-token create-token --decimals 6   # "mUSDC"      -> USDC_MINT
spl-token create-account $SOL_MINT && spl-token mint $SOL_MINT 1000
spl-token create-account $USDC_MINT && spl-token mint $USDC_MINT 100000
```

Mint authority stays with the demo key so test balances can be airdropped to buyer/seller wallets.

### 3.9 Deploy to Arcium devnet

```bash
arcium build
arcium deploy \
  --cluster-offset 456 \
  --recovery-set-size 4 \
  --keypair-path ~/.config/solana/id.json \
  --rpc-url https://devnet.helius-rpc.com/?api-key=...
# then set cluster offset in Arcium.toml and run init_match_orders_comp_def once
anchor deploy --program-name settlement --provider.cluster devnet
```

Budget 2–5 SOL devnet for deploy + account init; use a dedicated RPC (Helius/Triton/QuickNode), the public
devnet RPC drops transactions. Source: [Deployment](https://docs.arcium.com/developers/deployment).

### 3.10 Phase 1 end-to-end script

`scripts/e2e.ts` does, in order: create mints and fund two keypairs → `create_batch` → both `deposit_sell_side`
→ encrypt bid and ask → `match_orders` → `awaitComputationFinalization` → fetch `MatchResult` → `settle`
(or `cancel`) → print Explorer links for the callback tx and the settlement tx. This script is the seed of
the Phase 2 coordinator.

---

## 4. Phase 2 — Batch Coordinator, Terminal UI, Mock Price Feed

**Goal:** turn the Phase 1 script into a live two-terminal demo with a 30 s batch window.

**Exit criteria**

- [ ] Coordinator accepts orders over HTTP/WebSocket, runs a 30 s window, queues the MXE, settles, notifies.
- [ ] Two CLIs on separate terminals: order form → countdown → fill or no-match → Explorer link.
- [ ] Reference price (hardcoded 150 USDC/SOL) passed to the circuit and shown in the UI.
- [ ] A "no cross" batch cancels and refunds cleanly.

### 4.1 Batch coordinator (Node.js)

Single process, TypeScript, no database (in-memory batch state; optional JSON file for crash recovery).

Responsibilities:

1. **Accept orders** from clients: `{wallet, commitment}` to build the deposit, then `{ciphertexts, x25519Pubkey, nonce, signedDeposit}`. The coordinator never learns side or size.
2. **Batch window**: first order opens a 30 s timer; broadcast countdown ticks to connected CLIs.
3. **Close window**: if two parties deposited → proceed; else cancel and refund (call `cancel`). It cannot tell whether the two are a bid and an ask; the MXE decides.
4. **Queue MXE**: build and send `match_orders` with a fresh `computation_offset` (random u64), the batch id, both ciphertexts and the Pyth SOL/USD account.
5. **Await result**: `awaitComputationFinalization(...)` and/or subscribe to `MatchEvent`.
6. **Settle**: if `matched`, send `settle(batch_id)`; else `cancel(batch_id)`.
7. **Notify**: push `{matched, clearingPrice, txSignature}` to both CLIs.

State machine:

```
IDLE ──order──▶ COLLECTING(30s) ──timer──▶ QUEUED ──callback──▶ MATCHED ──settle tx──▶ SETTLED
                      │                              │
                      └── <2 orders / 2 same side ───┴── not matched ──▶ CANCELLED (refund)
```

Sketch:

```ts
// coordinator/src/index.ts
const WINDOW_MS = 30_000;
let batch: Batch | null = null;

app.post("/order", async (req, res) => {
  if (!batch) batch = openBatch();           // starts timer, creates on-chain Batch
  batch.add(req.body);                       // ciphertext only; prices never decrypted here
  res.json({ batchId: batch.id, closesAt: batch.closesAt });
});

async function closeBatch(b: Batch) {
  const bid = b.orders.find(o => o.side === "bid"), ask = b.orders.find(o => o.side === "ask");
  if (!bid || !ask) return cancel(b);
  const offset = new BN(randomBytes(8));
  await mxe.methods.matchOrders(offset, b.id, bid.pk, bid.nonce, bid.ct, ask.pk, ask.nonce, ask.ct, REF_PRICE)
    .accounts(arciumAccounts(offset)).rpc();
  await awaitComputationFinalization(provider, offset, mxe.programId, "confirmed");
  const result = await mxe.account.matchResult.fetch(matchResultPda(b.id));
  if (!result.matched) return cancel(b);
  const sig = await settlement.methods.settle(b.id).accounts({...}).rpc();
  broadcast(b, { matched: true, clearingPrice: result.clearingPrice, sig });
}
```

Why centralized is fine here: the coordinator never sees plaintext orders, cannot substitute them
(commitments), cannot choose the reference price (Pyth read on-chain) and cannot alter the clearing price
(settlement reads the on-chain `MatchResult`). Its remaining powers are liveness (it can refuse to run a
batch), timing within the 60 s oracle window, and knowing which wallets are in a batch. Section 6 lists
the decentralization path.

### 4.2 Terminal UI

Node.js CLI (Ink or plain `readline` + `chalk`). One process per participant.

| Screen | Content |
| --- | --- |
| Setup | wallet path, side (BUY/SELL), mock-token airdrop |
| Order form | `qty` (SOL), `limit price` (USDC/SOL); shows reference price; encrypts locally; deposits to escrow; POSTs ciphertext |
| Countdown | `Batch #12 closes in 23s · 1 bid · 1 ask` (WebSocket ticks from coordinator) |
| Result | `FILLED 1.00 SOL @ 148.25 USDC` or `NO MATCH – refunded`, with `https://explorer.solana.com/tx/<sig>?cluster=devnet` |

Key UX rule: **the limit price is encrypted in the CLI process before any network call**, and the UI says so.
Phase 3 adds Umbra register/scan helpers and a "privacy proof" screen.

### 4.3 Reference price source (revised)

The chain, not the coordinator, supplies the reference price (Pyth's upgraded receiver `rec2HHDD…`, sponsored SOL/USD account `7AviUf9n…`; when that account is stale the coordinator posts a fresh Hermes update through the same receiver, see README): `match_orders` is given the Pyth SOL/USD
`PriceUpdateV2` account and validates it on-chain (`programs/darkpool/src/oracle.rs`). The coordinator's
`PRICE_SOURCE` only selects which account to pass (`pyth` on devnet; `mock` on localnet, where
`set_mock_price` writes a Pyth-shaped account under the `mock-oracle` feature) and reads it for display
and for sizing the USDC bucket. A stale or wide feed makes `match_orders` fail rather than fall back.

---

## 5. Phase 3 — Umbra Stealth Settlement, Oracle, Demo Polish

**Goal:** make the fill unlinkable to the recipient's primary wallet, and finish the demo.

**Exit criteria**

- [ ] Settlement payout lands on a destination with no on-chain link to the recipient's main wallet.
- [ ] Recipient CLI can scan and claim/sweep the payout.
- [ ] (Optional) Reference price read from Pyth on devnet instead of the constant.
- [ ] README, 90-second demo script, recorded video.

### 5.1 What Umbra provides

Umbra is a Solana privacy protocol (built on Arcium's encrypted compute) offering encrypted balances,
stealth-pool transfers, and viewing keys for compliance. Two integration surfaces exist:

| Surface | What it is | Fit for us |
| --- | --- | --- |
| `@umbra-privacy/sdk` (TypeScript, `5.0.0-rc.x`) | Production SDK: ETAs (encrypted token accounts), stealth-pool **notes** with ZK (Groth16) proofs, scanner, relayer-based claim | Primary path. Devnet supported but **wSOL only** on devnet per docs. |
| `umbra-rs` (Rust, v0.1.0 beta) | Classic ECDH stealth addresses: meta-address (viewing + spending keys), one-time address derivation, `StealthAnnouncement` events, scanner | Fallback / conceptual reference; matches the brief's "stealth address generated from the recipient's public key" literally. |

Sources: [Umbra SDK quickstart](https://sdk.umbraprivacy.com/quickstart), [SDK concepts](https://sdk.umbraprivacy.com/),
[umbra-rs](https://github.com/umbra-research/umbra-rs), [Umbra privacy wallet announcement](https://cryptorank.io/news/feed/58992-umbra-unveils-public-privacy-wallet-on-solana-with-arcium-encrypted-compute).

### 5.2 Plan A — Umbra SDK stealth-pool note (devnet)

On fill, the settlement leg lands in a program-held payout account, and the coordinator (acting as the
"sender") creates a receiver-burnable stealth-pool note addressed to the recipient's registered Umbra
`userCommitment`. The recipient scans with viewing keys and burns/claims via the relayer from any wallet.
On-chain: a deposit into the shared mixer tree and, later, a nullifier from an unrelated wallet. No link
to the institution's primary wallet.

```ts
import { getUmbraClient, getUserRegistrationFunction, getUserRegistrationProver,
         getATAIntoReceiverBurnableStealthPoolNoteCreatorFunction, getATAIntoStealthPoolNoteCreatorProver,
         getBurnableStealthPoolNoteScannerFunction } from "@umbra-privacy/sdk";

const client = await getUmbraClient({ signer, network: "devnet", rpcUrl, rpcSubscriptionsUrl, indexerApiEndpoint });

// One-time, per institution (CLI "umbra register")
await getUserRegistrationFunction({ client }, { zkProver: getUserRegistrationProver() })({ confidential: true, anonymous: true });

// On fill, payout leg
const createNote = getATAIntoReceiverBurnableStealthPoolNoteCreatorFunction({ client }, { zkProver: getATAIntoStealthPoolNoteCreatorProver() });
await createNote({ destinationAddress: recipientUmbraAddress, mint, amount });

// Recipient side (CLI "umbra scan")
const found = await getBurnableStealthPoolNoteScannerFunction({ client })();
```

Install: `npm install @umbra-privacy/sdk@5.0.0-rc.6 snarkjs`.

### 5.3 Plan B — ECDH stealth address (if the SDK blocks on devnet mints)

Implement the umbra-rs scheme directly in TypeScript (~80 lines, `@noble/curves` ed25519):

1. Recipient publishes meta-address `(S, V)` = spending pubkey, viewing pubkey.
2. Sender picks ephemeral `r`, computes `R = r·G`, shared `s = H(r·V)`, stealth pubkey `P = S + s·G`.
3. Settlement sends tokens to the ATA of `P` and emits `R` in an announcement.
4. Recipient scans announcements: `s' = H(v·R)`, checks `S + s'·G == P`, derives private key `p = s + s'`.

Plan B keeps the demo fully self-contained and works with any SPL mint, at the cost of not using Umbra's
shielded pool. The on-chain record still shows no link between `P` and the recipient's primary wallet.

**Time-box:** try Plan A for 3 hours; fall back to Plan B if blocked.

### 5.4 Where it plugs in

The `payout_dest` recorded at `deposit_sell_side` time becomes either (A) a program payout account the
coordinator will forward from, or (B) the derived `P`. In both cases `settle` is unchanged from Phase 1.
The CLI gains `umbra register` / `umbra scan` commands and a "privacy proof" screen that prints the stealth
destination and the note "fill not linked to <primary wallet>".

### 5.5 Privacy guarantees and limits

- **Hidden:** which institution received a given fill; limit prices.
- **Visible:** that *some* batch settled at `clearing_price` for `qty`; the escrow deposits from primary
  wallets (unless deposits are also made from stealth/ETA balances, which is the upgrade path).
- umbra-rs is explicitly beta and unaudited; the SDK is a release candidate. Fine for a hackathon.

### 5.6 Oracle (done, moved into Phase 1)

Implemented on-chain as described in §2 and §3.5. Remaining oracle follow-ups: re-check the reference
at `settle` time against a max match age in slots (`MatchResult.queued_slot` is already stored), and
consider the EMA price or a deviation band for the midpoint branch.

### 5.7 Demo script (90 seconds)

1. Terminal A (Buyer): `BUY 1 SOL @ 152` → "encrypted locally, deposited 160 mUSDC".
2. Terminal B (Seller): `SELL 1 SOL @ 148` → "encrypted locally, deposited 1 mSOL".
3. Both show the countdown; at 0 the coordinator queues the MXE.
4. ~10–20 s later: `FILLED 1 SOL @ 150.00` (reference price inside the spread) + Explorer link.
5. Open Explorer: show the settlement tx with two transfers to fresh addresses; show the `MatchResult` PDA
   holds only `matched=true, clearing_price=150000000`; point out no 152 / 148 anywhere on-chain.
6. Re-run with `SELL @ 155`: `NO MATCH – refunded`, PDA shows `(false, 0)`.

---

## 6. Risks, Open Questions, Upgrade Paths

### 6.1 Risks and mitigations

| Risk | Phase | Likelihood | Mitigation |
| --- | --- | --- | --- |
| Arcium devnet latency or dropped callbacks | 1 | Medium | Dedicated RPC; retry `awaitComputationFinalization`; local `arcium test` as backup demo |
| `arcium-anchor` API drift (macro/field names differ from docs) | 1 | High | Read generated code after `arcium build`; pin versions in `Cargo.toml`; keep circuit tiny |
| Bucket sizing leaks the bid | 1 | Medium | USDC bucket is `max_qty × ref × 1.25`, identical for both parties; never derived from a bid |
| Relayer picks a favourable moment to queue | 1 (rev.) | Low | Reference must be ≤ 60 s old; store `queued_slot` for a settle-time age check (follow-up) |
| Settlement netting reveals side and size after the fact | 1 (rev.) | Certain | Inherent to on-chain token transfers; Phase 3 stealth payouts + bucketed refunds |
| Pinging attacks once partial fills exist | post | High | Minimum fill / minimum order size before adding partial fills |
| Compute budget on `settle` (3 token transfers) | 1 | Low | Request 400k CU via `ComputeBudgetProgram` |
| Coordinator crash mid-batch | 2 | Low | Permissionless `settle`/`cancel` cranks; persist batch ids to disk |
| Umbra SDK devnet limited to wSOL | 3 | High | Plan B ECDH stealth addresses; or route only the SOL leg through Umbra and the USDC leg via Plan B |

### 6.2 Open questions

- [ ] Confirm current `@arcium-hq/client` and `arcium-anchor` versions and the generated output struct shape. (Phase 1)
- [x] `qty` is encrypted; the circuit requires equal quantities and reveals `qty` only on a match. (Phase 1, rev.)
- [ ] Confirm Umbra devnet endpoints (`indexerApiEndpoint`) and whether an SPL mint other than wSOL can be used. (Phase 3)
- [ ] Should the buyer's USDC leg also go through escrow deposited from an Umbra ETA, hiding the deposit side? (post-hackathon)

### 6.3 After the hackathon

- Partial fills: order state that outlives a batch, pro-rata matching in the circuit, settle per match,
  **minimum fill size** to make pinging expensive, bucketed or delayed refunds.
- Multi-order batches: fixed-size arrays in the circuit (e.g. 8 orders), uniform clearing price.
- Decentralize the coordinator: `match_orders` is already permissionless and commitment-bound; add an
  on-chain window and a permissionless timeout `cancel`.
- Hide the deposit side with Umbra ETAs so neither leg is linkable.

---

## 7. References

- Arcium docs: [Hello World](https://docs.arcium.com/developers/hello-world) · [Arcis overview](https://docs.arcium.com/developers/arcis) ·
  [Types](https://docs.arcium.com/developers/arcis/types) · [Operations](https://docs.arcium.com/developers/arcis/operations) ·
  [Input/Output](https://arcium.mintlify.app/developers/arcis/input-output) · [Encryption overview](https://docs.arcium.com/developers/encryption) ·
  [Program overview](https://docs.arcium.com/developers/program) · [Callback accounts](https://docs.arcium.com/developers/program/callback-accs) ·
  [JS client encryption](https://docs.arcium.com/developers/js-client-library/encryption) · [Installation](https://docs.arcium.com/developers/installation) ·
  [Deployment](https://docs.arcium.com/developers/deployment) · [Migration v0.3→v0.4](https://docs.arcium.com/developers/migration/migration-v0.3-to-v0.4)
- Crates: [arcis](https://docs.rs/arcis/latest/arcis/) · [arcium_anchor](https://docs.rs/arcium-anchor/latest/arcium_anchor/)
- Example repos: [sip-protocol/sip-arcium-program](https://github.com/sip-protocol/sip-arcium-program) (confidential transfers + swap validation) ·
  [nyakiomaina/proof-of-inference](https://github.com/nyakiomaina/proof-of-inference)
- Arcium network status: [Messari – Mainnet Alpha](https://messari.io/report/arcium-mainnet-alpha-release) ·
  [Helius – Privacy 2.0 for Solana](https://www.helius.dev/blog/solana-privacy) · [Arcium build page](https://www.arcium.com/build)
- Umbra: [SDK docs](https://sdk.umbraprivacy.com/) · [Quickstart](https://sdk.umbraprivacy.com/quickstart) ·
  [@umbra-privacy/sdk on npm](https://npmx.dev/package/@umbra-privacy/sdk) · [umbra-rs](https://github.com/umbra-research/umbra-rs) ·
  [Umbra privacy wallet with Arcium](https://cryptorank.io/news/feed/58992-umbra-unveils-public-privacy-wallet-on-solana-with-arcium-encrypted-compute)
