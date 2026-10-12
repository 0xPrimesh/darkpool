# Dark Pool on Solana (Arcium MXE) — Phase 1 + 2

Encrypted limit-order matching on [Arcium](https://docs.arcium.com) with atomic SPL settlement on Solana devnet, plus a small web UI.

Two parties connect their own wallets, each encrypts a whole order **{side, limit price, quantity} in the browser**, and signs their own collateral deposit. A coordinator batches orders in a 30 s window and hands the ciphertexts to Arcium's MPC network. The MXE program checks the ciphertexts against the commitments recorded at deposit time and reads the SOL/USD reference **from Pyth on-chain**; only the fill `(matched, clearing_price, qty, which slot bought)` is revealed. If they cross, a Solana program nets both parties' collateral **in one transaction** out of vaults shared by all batches.

What stays hidden and from whom:

| | On-chain observer | Coordinator | Counterparty |
| --- | --- | --- | --- |
| Limit prices | never | never | never |
| Side (buy/sell) | until the fill settles | until the fill settles | until the fill settles |
| Size | until the fill settles (deposits are fixed-size buckets) | until the fill settles | until the fill settles |
| Unmatched batch | nothing (all-zero result) | nothing | nothing |
| Reference price | public, verified on-chain from Pyth (<= 60 s old, confidence <= 1 %) | cannot choose it | cannot choose it |

See [`TECHNICAL_DESIGN.md`](./TECHNICAL_DESIGN.md) for the full design and the Phase 2 / Phase 3 roadmap.

```
arcium/
├── backend/      Arcis circuit, two Anchor programs, TS scripts, batch coordinator
├── frontend/     Vite + React UI: wallet login, client-side encryption, live batch view
├── README.md     this file
└── TECHNICAL_DESIGN.md
```

---

## 0. Prerequisites

Tested on macOS (Apple Silicon) and Linux. Windows: use WSL2.

| Tool | Version | Install |
| --- | --- | --- |
| Rust | 1.89.0 (pinned in `rust-toolchain.toml`) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Solana CLI | 3.1.10 | `sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.10/install)"` |
| Anchor | 1.0.2 | `cargo install --git https://github.com/solana-foundation/anchor avm --force && avm install 1.0.2 && avm use 1.0.2` |
| Node.js | ≥ 20 | https://nodejs.org |
| Yarn | latest | `npm i -g yarn` |
| Docker + Compose | latest | https://docs.docker.com/engine/install/ (needed for local `arcium test`) |
| Arcium CLI | via arcup 0.15 | `curl --proto '=https' --tlsv1.2 -sSfL https://install.arcium.com/ \| bash` then `arcup install` |

Verify:

```bash
rustc --version && solana --version && anchor --version && node --version && docker --version && arcium --version
```

Create a Solana keypair if you do not have one:

```bash
solana-keygen new            # writes ~/.config/solana/id.json
solana config set --url devnet
solana airdrop 2             # repeat if needed; devnet faucet is rate limited
```

You also need a **dedicated devnet RPC** (free tier is fine) from Helius, Triton or QuickNode. The public `api.devnet.solana.com` drops transactions during Arcium deployment.

---

## 1. Backend: build

```bash
cd backend
yarn install
arcium build          # compiles the Arcis circuit (build/match_orders.arcis) and both Anchor programs
```

`arcium build` writes the IDLs and TypeScript types to `backend/target/`. Scripts and the server read those, so **always build before running anything else**.

The program IDs are already generated and consistent across `Anchor.toml`, `declare_id!` in both programs, and `target/deploy/*-keypair.json`. If you ever change them, run `anchor keys sync` and also update `DARKPOOL_PROGRAM_ID` in `programs/settlement/src/lib.rs`.

> **First-build note.** The callback in `programs/darkpool/src/lib.rs` destructures the generated `MatchOrdersOutput` type. Its nested `field_N` shape mirrors the official `sealed_bid_auction` example on arcium 0.13.2. If the compiler reports a mismatch, open the generated type (search `MatchOrdersOutput` under `target/`) and adjust that one `match` arm.

---

## 2. Option A: run everything locally (Docker)

This spins up a local validator plus a 2-node Arcium cluster and runs the mocha cases in `backend/tests/darkpool.ts`: match at the on-chain reference price with balance netting, match at midpoint, no cross, same side, different sizes, forged ciphertext rejected, stale oracle rejected, double settle rejected.

```bash
cd backend
yarn test:local     # = arcium build && anchor build -p darkpool -- --features mock-oracle && arcium test --skip-build
```

Localnet has no Pyth receiver, so the test uses a Pyth-shaped price account written by `set_mock_price`. That instruction and the program's acceptance of it only exist in a build with the `mock-oracle` cargo feature; the normal `arcium build` / devnet deployment compiles it to a hard error.

Expect 2–5 minutes the first time (Docker images). Green output means the circuit, the MXE program, the callback and the atomic settlement all work.

---

## 3. Option B: deploy to Solana devnet + Arcium devnet cluster

### 3.1 Configure

```bash
cd backend
cp .env.example .env
```

Edit `.env`:

```ini
CLUSTER=devnet
RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
WS_URL=wss://devnet.helius-rpc.com/?api-key=YOUR_KEY
WALLET_PATH=~/.config/solana/id.json
CLUSTER_OFFSET=456            # Arcium devnet cluster
PRICE_SOURCE=pyth             # the program reads Pyth on-chain; mock only works on localnet
SOL_BUCKET=1                  # collateral tier: every party escrows 1 SOL-mock + the USDC bucket
PORT=8787
```

Make sure the wallet holds **3–5 SOL devnet** (deploying two programs + MXE accounts).

### 3.2 Deploy the MXE program (Arcium)

```bash
arcium deploy \
  --cluster-offset 456 \
  --recovery-set-size 4 \
  --keypair-path ~/.config/solana/id.json \
  --rpc-url "$RPC_URL"
```

This deploys `darkpool`, initialises its MXE account on the Arcium devnet cluster and sets up key material. `Arcium.toml` already has `[clusters.devnet] offset = 456`.

### 3.3 Deploy the settlement program (plain Anchor)

```bash
anchor deploy --program-name settlement --provider.cluster "$RPC_URL" --provider.wallet ~/.config/solana/id.json
```

### 3.4 Register the circuit (once per MXE deployment)

```bash
yarn init:comp-def
```

Uploads `build/match_orders.arcis` and creates the computation-definition account.

### 3.5 Create mock tokens and demo wallets (once)

```bash
yarn setup:tokens
```

Creates `USDC-mock` (6 dp) and one base mock mint per market (`SOL-mock`, `NVDA-mock`; 9 dp), generates `backend/.keys/buyer.json` and `backend/.keys/seller.json`, funds them with a little SOL for fees, mints 100 of every base mock **and** 100 000 USDC-mock to each (every deposit escrows both collateral buckets), creates each market's shared pool vaults, registers the market's Pyth feed for that pool in the darkpool program (`register_market`), and writes `backend/deployment.json`. Idempotent: re-run it after adding a market and it only creates what is missing.

**Markets.** `backend/scripts/lib/markets.ts` lists them: `SOL` (Pyth `Crypto.SOL/USD`, sponsored on devnet) and `NVDA` (Pyth `Equity.US.NVDA/USD`). `MARKETS=SOL,NVDA` in `.env` picks the enabled set; `NVDA_FEED_ID` can swap in Pyth's 24/7 NVDA index feed (`a470c4ac…`) if your Hermes plan serves it. Two things to know about the equity market on devnet:

- Pyth does **not** sponsor NVDA/USD on devnet, so the coordinator maintains the price account itself: with `HERMES_API_KEY` set it fetches the latest signed update from Hermes and writes it through the Pyth push oracle's permissionless `update_price_feed` (Wormhole-verified, so nothing can be forged). Without a key the NVDA tile shows **no feed** and the ticket is disabled with the reason.
- The regular NVDA/USD feed only publishes during US market hours (09:30–16:00 ET, weekdays). Outside those hours the on-chain 60 s staleness check makes the market untradable; the UI shows **closed** and the next open time (from Hermes' public feed listing).

### 3.6 Run one batch from the terminal

```bash
yarn e2e                 # bid 152, ask 148, qty 1   -> FILLED @ 150 (reference inside spread)
yarn e2e 160 158         # -> FILLED @ 159 (midpoint; reference outside spread)
yarn e2e 148 152         # -> NO MATCH, escrows refunded
```

Each step prints an Explorer link. The deposit transactions are identical for buyer and seller (both buckets in, a 32-byte commitment). The settlement link shows the collateral netting in a single transaction. The `MatchResult` PDA shows the fill plus the Pyth reference the program verified; nothing else.

---

## 4. Start the services (end to end with the web UI)

> **Running from a clone of this repo (no Rust / Arcium toolchain needed).** The programs are already deployed on devnet and the repo ships everything the coordinator and UI need: `backend/deployment.json` (mint addresses), `backend/target/idl` + `backend/target/types` (program IDLs), `backend/target/deploy` (program ids and binaries), `backend/build` (circuit) and `backend/.keys` (demo wallets). Only two things are not in git:
>
> 1. `backend/.env`: copy `.env.example`, set `RPC_URL` / `WS_URL` (Helius devnet key) and optionally `HERMES_API_KEY` (NVDA).
> 2. The coordinator wallet (`WALLET_PATH`, default `~/.config/solana/id.json`): it is the mint authority of the mock tokens and the programs' upgrade authority, so the faucet only works with it. Get it from the deployer, or use any funded devnet wallet and run `yarn setup:tokens` to create your own mints/pools.
>
> Then `yarn install` in `backend/` and `frontend/`, and start the two services below. Steps 1–3 above are only for rebuilding or redeploying the programs.

Open two terminals.

**Terminal 1 — coordinator** (batches orders, talks to Arcium and the settlement program):

```bash
cd backend
yarn server
# darkpool coordinator on http://localhost:8787  cluster=devnet offset=456 window=30000ms
```

Optional in `.env`: `BATCH_WINDOW_MS=15000` for a shorter demo window; `SOL_BUCKET` for the collateral tier (see "Collateral buckets" below).

**Terminal 2 — frontend:**

```bash
cd frontend
yarn install
cp .env.example .env        # VITE_API_URL=http://localhost:8787
yarn dev
# http://localhost:5173
```

### Trading from two wallets

You need two browser wallets on **devnet** (e.g. Phantom in two profiles, or Phantom + Solflare, or two laptops). Set each wallet's network to Devnet.

1. **Wallet A** opens http://localhost:5173, clicks **Select Wallet**, connects, then **Get demo tokens**. The coordinator sends a little SOL for fees plus 10 of every base mock (SOL-mock, NVDA-mock) and 5000 USDC-mock.
2. **Wallet B** does the same in another browser profile.
3. Both pick the same **market** in the row under the header (SOL or NVDA; each tile shows the live Pyth price, its age, and `closed` / `no feed` when the market cannot trade). Each market runs its own batches and has its own trade book. **Wallet A** picks **BUY** and either **Market** (the ticket pegs an encrypted limit at the live Pyth reference ± the chosen slippage, so it clears at the reference) or **Limit** with a price (e.g. 152), enters a quantity (1, at most the tier), clicks **Open a batch**, and approves the collateral deposit in the wallet popup. The page shows a 30 s countdown with party A filled. Nothing on the page, in the coordinator or on-chain says A is buying.
4. **Wallet B** picks **SELL**, enters a limit (e.g. 148) and the same quantity, clicks **Join batch**, approves the deposit.
5. When the countdown hits 0 the coordinator queues the MXE with the Pyth account. Both pages show the MPC steps, then **FILLED 1 SOL @ 150.00** with the settlement transaction link. Balances update on both sides.
6. Try again with SELL at 155, two BUYs, or different quantities to see **NO MATCH** and a refund (the result does not say why), or let the window expire with one party to see **NO COUNTERPARTY**.

What each party's browser does: encrypts `{side, price, qty}` with the MXE's x25519 key (Rescue cipher), hashes the ciphertext into a commitment, asks the coordinator for an unsigned deposit transaction carrying that commitment, signs it with the connected wallet, and sends ciphertext + signed deposit back. The coordinator never sees a plaintext order, never holds user keys, and cannot swap in a different ciphertext: the darkpool program recomputes the hash and rejects a mismatch.

### Coordinator API

```
GET  /status                     config, MXE pubkey, current batch
GET  /events                     Server-Sent Events stream of batch state
GET  /balance/:wallet            SOL + mock balances
POST /faucet   {wallet}          demo funding
POST /order/prepare {wallet, commitment}   commitment = sha256 hex of the ciphertext tuple
                                 -> {batchId, solBucket, usdcBucket, closesAt, tx}   (tx = base64 unsigned deposit)
POST /order/submit  {batchId, wallet, signedTx, enc:{pubkey, nonce, ciphertexts[3]}}
GET  /history                    recent results
```

### Scripted run (no wallets)

`yarn e2e` still runs a whole batch from the terminal using the demo keypairs in `backend/.keys/`, which is handy for checking the chain side without a browser.

---

## 5. What is where

| Path | What |
| --- | --- |
| `backend/encrypted-ixs/src/lib.rs` | Arcis circuit `match_orders`: 2 × `Enc<Shared, OrderInput{is_buy, price, qty}>` + plaintext reference and buckets → revealed `{matched, clearing_price, qty, a_is_buyer}` |
| `backend/programs/darkpool/src/lib.rs` | MXE Anchor program: `init_match_orders_comp_def`, `match_orders` (checks commitments against the settlement `Batch`, reads Pyth, queues), `match_orders_callback` → writes `MatchResult` PDA `["match", batch_id]`; `set_mock_price` (localnet feature only) |
| `backend/programs/darkpool/src/oracle.rs` | Pyth `PriceUpdateV2` parser + checks: owner, discriminator, full verification, the market's feed id, positive, confidence ≤ 1 %, age ≤ 60 s |
| `backend/programs/settlement/src/lib.rs` | `init_pool` (shared vaults), `create_batch` (buckets), `deposit` (both buckets + commitment, side-blind), `settle` (reads `MatchResult`, nets collateral in one tx), `cancel` |
| `backend/scripts/lib/` | `config.ts` (env/provider), `markets.ts` (market list: mint, pool, Pyth feed, push account), `arcium.ts` (encrypt, commit, register market, queue, await, mock price), `settlement.ts` (PDAs + ixs), `price.ts` (per-market oracle account, Hermes refresh, market hours), `tokens.ts`, `flow.ts` (`runBatch`) |
| `backend/scripts/` | `setup-tokens.ts`, `init-comp-def.ts`, `e2e.ts` |
| `backend/server/index.ts` | Batch coordinator: 30 s window, unsigned deposit txs for wallets, MXE round-trip, SSE updates |
| `backend/tests/darkpool.ts` | Localnet mocha test run by `arcium test` |
| `frontend/src/App.tsx` | Trading desk: order ticket, batch engine (countdown, slots, MPC steps, result), on-chain trade book (tape / batches / mine), account |
| `backend/server/tradebook.ts` | `GET /trades`: the trade book read from settlement `Batch` accounts (+ `MatchResult` for who bought), cached 15 s |
| `frontend/src/crypto.ts` | Client-side order encryption (x25519 + Rescue) via `@arcium-hq/client`, plus the sha256 commitment |
| `frontend/src/shims/` | Browser shims so `@arcium-hq/client` bundles (node `fs`, Anchor default export) |

### Reference price (Pyth, verified on-chain)

`match_orders` takes a Pyth `PriceUpdateV2` account as an account, not a number, plus the `MarketConfig` PDA of the batch's settlement pool, which names the feed id that account must carry (`register_market`, once per pool; SOL/USD for the SOL-mock pool, NVDA/USD for the NVDA-mock pool). For SOL that is Pyth's sponsored account `7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE` (push-oracle shard 0, same on devnet and mainnet); for NVDA it is the shard-0 push account for the NVDA feed, which the coordinator keeps fresh itself. Both live under Pyth's **upgraded** receiver `rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp` (Pyth Core upgrade, Aug 2026); the pre-upgrade account `7UVimff…` is owned by the old receiver and is rejected with `BadOwner`. `programs/darkpool/src/oracle.rs` parses it and requires: owner = Pyth receiver program, correct discriminator, `VerificationLevel::Full`, the market's feed id (`WrongFeed` otherwise), a positive price, confidence ≤ 1 % of price, and `publish_time` within 60 s of the slot clock. The verified price (scaled to 6 dp) is passed into the circuit as plaintext and stored in `MatchResult.reference_price` with its publish time and the queue slot. The relayer/coordinator cannot choose the price; it can only choose *when* to queue, which the staleness bound limits.

`PRICE_SOURCE` in `backend/.env` only decides which account the coordinator passes: `pyth` (devnet/mainnet) or `mock` (localnet, see §2). The coordinator also reads the account for display and escrow sizing; a Pyth read failure shows `REFERENCE_PRICE` with an amber note but does not affect what the chain enforces.

**Freshness.** The sponsored SOL/USD devnet feed is pushed roughly once a minute but sometimes pauses for several minutes; NVDA/USD has no sponsor on devnet at all; and the program rejects anything older than 60 s (`StalePrice`). The coordinator handles this in `backend/scripts/lib/price.ts`:

1. If the market's push account is at most `PYTH_SPONSORED_MAX_AGE_SEC` (30 s) old, it is passed as is.
2. Otherwise, with `HERMES_API_KEY` set, the coordinator pulls the latest signed update from Hermes and writes it into that same push account through the Pyth receiver (`refreshPythFeed`, the push oracle's permissionless `update_price_feed`). The account is a PDA, so its address never changes and its rent (~0.003 SOL) is paid once. Updates are Wormhole-verified and `VerificationLevel::Full`, so the program applies exactly the same checks. Hermes has required an API key since the Pyth Core upgrade (sign up at [pythdata.app](https://pythdata.app/signup); a free trial is included). While an equity market is open the coordinator also refreshes its feed every `PYTH_SELF_REFRESH_MS` (45 s) so the ticker is live.
3. Without a key it polls a sponsored account for up to `PYTH_WAIT_FRESH_SEC` (240 s) and fails with a clear message if it never refreshes; a non-sponsored market is reported as not tradable instead of opening a batch that could never match.

### Clearing rule (inside MPC)

```
buyer/seller  = whichever order has is_buy (must be exactly one of the two)
if not opposite sides, or bid < ask, or qty_a != qty_b,
   or qty > sol_bucket, or qty * price > usdc_bucket     -> (false, 0, 0, false)
else if ask <= reference <= bid                          -> (true, reference, qty, a_is_buyer)
else                                                     -> (true, (bid + ask) / 2, qty, a_is_buyer)
```

Both branches of every `if` are evaluated in MPC; the encrypted boolean only selects the result, so control flow leaks nothing. An unmatched batch reveals nothing, not even *why* it failed.

### Collateral buckets (side-blind, size-blind deposits)

A batch has two public numbers, `sol_bucket` and `usdc_bucket` (the coordinator uses `SOL_BUCKET` SOL-mock and `SOL_BUCKET × reference × ESCROW_BOUND_PCT/100` USDC-mock, default 125 %). **Every** party escrows both buckets, whichever side it is on, into vaults shared by all batches (`init_pool`), and records a 32-byte commitment to its ciphertext. So a deposit reveals neither side nor size. The order's size is inside the ciphertext and must be ≤ `sol_bucket` (and `qty × price ≤ usdc_bucket`), otherwise the MXE reports no match. At settlement each party gets both buckets back netted by the fill: the buyer `+qty` SOL-mock / `−qty × price` USDC-mock, the seller the reverse. The netting amounts are public at that point; that is the residual leak Phase 3 (stealth payouts, bucketed refunds) is for.

---

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `IDL not found at target/idl/...` | Run `arcium build` in `backend/` first. |
| `deployment.json not found` | Run `yarn setup:tokens`. |
| `Failed to fetch MXE x25519 public key` | MXE not initialised on this cluster: run `arcium deploy` (devnet) or use `arcium test` (localnet). Check `CLUSTER_OFFSET=456`. |
| `arcium deploy` times out / drops txs | Use a dedicated RPC (Helius etc.) via `--rpc-url`; top up SOL. |
| `MatchOrdersOutput` pattern does not compile | Open the generated type under `target/` and adjust the single `match` arm in the callback (see §1 note). |
| `settle` fails with `BatchNotOpen` although the batch is open, or `cancel` reports an access violation | Stack overflow in account validation. All large accounts in the settlement structs must stay `Box<Account<..>>`; check `arcium build` output for a "Stack offset ... exceeded max offset of 4096" warning. Redeploy after fixing. |
| A batch's funds are stuck in escrow after a failed settle | `yarn crank <batchId>` settles it (if the MXE matched) or refunds it. |
| Batch reports NO MATCH although bid ≥ ask | Same side? Different quantities? Quantity above `SOL_BUCKET`? `qty × price` above the USDC bucket (bid far above reference)? The result does not say which; check the inputs. |
| `match_orders` fails with `StalePrice` / `ConfidenceTooWide` | The Pyth feed is >60 s old or wide. Set `HERMES_API_KEY` so the coordinator posts a fresh update, or wait for the sponsored push. On localnet re-run `set_mock_price` (the mock is stamped with the current time). |
| `match_orders` fails with `WrongFeed` / `MarketMismatch` | The price account carries another market's feed, or the `MarketConfig` passed is not the batch pool's. Re-run `yarn setup:tokens` so every pool is registered, and check `MARKETS`. |
| NVDA tile shows **closed** | The regular NVDA/USD feed only publishes 09:30–16:00 ET on trading days; the on-chain 60 s staleness check cannot pass outside that. Try `NVDA_FEED_ID=a470c4ac…` (Pyth 24/7 NVDA index) if your Hermes plan includes it. |
| NVDA tile shows **no feed** | No sponsored NVDA push account on devnet and no `HERMES_API_KEY`; set the key and restart `yarn server` (it creates and maintains the account). |
| `match_orders` fails with `BadOwner` | `PRICE_SOURCE=mock` on devnet, a non-Pyth account, or the pre-upgrade Pyth account `7UVimff…` was passed. Use `PRICE_SOURCE=pyth` and the upgraded account (default). |
| `set_mock_price` fails with `MockOracleDisabled` | The deployed darkpool was built without `--features mock-oracle`; that is intended for devnet. Use `yarn test:local` for localnet. |
| `match_orders` fails with `CommitmentMismatch` | The ciphertexts handed to the MXE are not the ones the parties committed to at deposit. The coordinator cannot substitute orders; re-submit. |
| Wallet popup never appears / "Connect a wallet" | Install Phantom or Solflare, switch it to **Devnet**, reload. Wallets are detected via the Wallet Standard. |
| Deposit fails with insufficient funds | Click **Get demo tokens** first; every party needs BOTH the market's base mock and USDC-mock (both collateral buckets) plus a little SOL. |
| Frontend shows "Coordinator unreachable" | Start `yarn server` in `backend/`; check `VITE_API_URL` in `frontend/.env`. |
| Docker `arcium test` hangs on first run | Pulling node images; wait, or raise `localnet_timeout_secs` in `Arcium.toml`. |

---

## 7. Exit criteria

- [ ] `yarn test:local` passes locally (8 cases).
- [ ] `darkpool` deployed to Arcium devnet (offset 456); `MatchResult` PDA written by the callback.
- [ ] `settlement` deployed to devnet; two-leg transfer confirmed in one tx on Explorer.
- [ ] `yarn e2e` completes a fill and a no-match batch on devnet.
- [ ] Phase 2: two browser wallets trade through the coordinator; each encrypts its own price and signs its own deposit; the fill shows on both screens with the Explorer proof.
- [ ] Reference price read and verified from Pyth **on-chain** in `match_orders`; relayer never sends a price.
- [ ] Deposits are side-blind and size-blind (both buckets, commitment only); funds in shared pool vaults.

Next: Phase 3 (Umbra stealth payouts) per `TECHNICAL_DESIGN.md`. The `payout_dest` recorded at deposit time is where stealth addresses plug in.
