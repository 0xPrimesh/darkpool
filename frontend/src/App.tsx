import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Transaction } from "@solana/web3.js";
import {
  Balance,
  MarketInfo,
  OrderKind,
  Result,
  Side,
  Snapshot,
  State,
  Status,
  Trade,
  faucet,
  getBalance,
  getStatus,
  getTrades,
  prepareOrder,
  submitOrder,
  subscribe,
} from "./api";
import { encryptOrder, orderCommitment } from "./crypto";

const STEP_LABELS: Record<string, string> = {
  oracle: "Resolve the market's Pyth price account",
  queue_mxe: "Queue on Arcium — commitments and oracle checked on-chain",
  await_mpc: "MPC cluster computes the match",
  settle: "Atomic settlement — collateral netted in one transaction",
  cancel: "Refund collateral",
};

function short(s?: string, n = 4) {
  if (!s) return "";
  return s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s;
}
function trim0(s?: string) {
  return s ? s.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1") : "";
}
function fmtTime(ms: number) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
function fmtClock(unixSec: number) {
  return new Date(unixSec * 1000).toLocaleString([], {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function fmtDate(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return fmtTime(ms);
  return `${d.toLocaleDateString([], { month: "short", day: "2-digit" })} ${fmtTime(ms)}`;
}

/* ------------------------------------------------------------------ */

export default function App() {
  const { publicKey, signTransaction, connected } = useWallet();
  const me = publicKey?.toBase58();

  const [status, setStatus] = useState<Status | null>(null);
  const [apiErr, setApiErr] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [allTrades, setAllTrades] = useState<Trade[]>([]);
  const [now, setNow] = useState(Date.now());
  const [market, setMarket] = useState<string>("SOL");

  const [side, setSide] = useState<Side>("bid");
  const [kind, setKind] = useState<OrderKind>("market");
  const [slipPct, setSlipPct] = useState(1);
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const lastPhase = useRef<Record<string, string>>({});

  const markets: MarketInfo[] = status?.markets ?? [];
  const info = markets.find((m) => m.symbol === market) ?? markets[0];
  const sym = info?.symbol ?? market;
  const state: State | null = snap?.markets[sym] ?? null;

  /* ---- data ---------------------------------------------------- */
  const refreshBalance = useCallback(() => {
    if (!me) return setBalance(null);
    getBalance(me)
      .then(setBalance)
      .catch(() => {});
  }, [me]);
  const refreshTrades = useCallback(() => {
    getTrades()
      .then((b) => setAllTrades(b.trades))
      .catch(() => {});
  }, []);
  const trades = useMemo(
    () => allTrades.filter((t) => t.market === sym),
    [allTrades, sym],
  );

  useEffect(() => {
    getStatus()
      .then((s) => {
        setStatus(s);
        setApiErr(null);
      })
      .catch((e) => setApiErr(String(e.message ?? e)));
    refreshTrades();
    const unsub = subscribe((s) => {
      setSnap(s);
      setApiErr(null);
    });
    const t = setInterval(() => setNow(Date.now()), 250);
    const tb = setInterval(refreshTrades, 20_000);
    return () => {
      unsub();
      clearInterval(t);
      clearInterval(tb);
    };
  }, [refreshTrades]);

  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  // If the server does not know the selected market, fall back to its first.
  useEffect(() => {
    if (markets.length && !markets.some((m) => m.symbol === market))
      setMarket(markets[0].symbol);
  }, [markets, market]);

  // Seed the limit price with the live reference the first time we see it
  // (and again whenever the market changes).
  useEffect(() => {
    setPrice("");
  }, [sym]);
  useEffect(() => {
    if (price === "" && state?.price?.human && Number(state.price.human) > 0)
      setPrice(Number(state.price.human).toFixed(2));
  }, [state?.price?.human, price]);

  // Fill notification + refreshes when a batch finishes, in any market.
  useEffect(() => {
    if (!snap) return;
    for (const st of Object.values(snap.markets)) {
      const prev = lastPhase.current[st.symbol];
      lastPhase.current[st.symbol] = st.phase;
      if (
        prev &&
        prev !== st.phase &&
        ["settled", "cancelled", "error"].includes(st.phase)
      ) {
        refreshBalance();
        setTimeout(refreshTrades, 1500);
        const r = st.result;
        if (r && me && r.parties?.includes(me)) {
          setMsg(
            r.matched
              ? {
                  kind: "ok",
                  text: `Filled ${trim0(r.qty)} ${st.symbol} at ${r.clearingPriceHuman} USDC as ${r.buyer === me ? "buyer" : "seller"}.`,
                }
              : {
                  kind: "err",
                  text:
                    r.reason === "incomplete"
                      ? `${st.symbol} batch closed without a counterparty. Your collateral was refunded.`
                      : `${st.symbol}: no match (no cross, same side, or different sizes). Your collateral was refunded.`,
                },
          );
        }
      }
    }
  }, [snap]);

  /* ---- derived ------------------------------------------------- */
  const b = state?.batch;
  const collecting = state?.phase === "collecting" && !!b;
  const windowMs = state?.windowMs ?? status?.windowMs ?? 30000;
  const secondsLeft = collecting
    ? Math.max(0, Math.ceil((b!.closesAt - now) / 1000))
    : 0;
  const fraction = collecting
    ? Math.min(1, Math.max(0, (b!.closesAt - now) / windowMs))
    : 0;
  const inFlight = collecting || state?.phase === "matching";
  const mine = !!(
    me &&
    b &&
    inFlight &&
    b.parties.some((p) => p.wallet === me)
  );
  const slotsTaken = b
    ? b.parties.length + b.reserved.filter((w) => w !== me).length
    : 0;
  const batchFull = collecting && slotsTaken >= 2;
  const canSubmitBase =
    connected &&
    !!status &&
    !busy &&
    state?.phase !== "matching" &&
    !batchFull &&
    !mine;
  const pi = state?.price;
  const refNum = pi && Number(pi.human) > 0 ? Number(pi.human) : NaN;
  const priceAge = pi
    ? Math.max(0, Math.floor(now / 1000 - pi.publishTime))
    : 0;
  const priceStale = pi?.source === "pyth" && priceAge > 60;
  const untradable = !!state && !state.tradable;
  const closed = !!state && !state.hours.isOpen;
  const boundPct = pi ? Number(pi.boundPct) : 125;
  const maxSettleable = (refNum * boundPct) / 100;
  // A market order is a marketable limit pegged to the live reference: the
  // encrypted price is ref ± slippage so it crosses any resting order at or
  // inside the band, and the circuit then clears at the reference itself.
  const marketLimit = Number.isFinite(refNum)
    ? side === "bid"
      ? Math.min(refNum * (1 + slipPct / 100), maxSettleable)
      : refNum * (1 - slipPct / 100)
    : NaN;
  const effPrice = kind === "market" ? marketLimit : Number(price);
  const bidTooHigh =
    kind === "limit" && side === "bid" && Number(price) > maxSettleable;
  const marketUnavailable =
    kind === "market" && (!Number.isFinite(refNum) || priceStale);
  const canSubmit = canSubmitBase && !marketUnavailable && !untradable;
  const tierSol = Number(state?.tier?.solBucket ?? status?.solBucket ?? "1");
  const qtyTooBig = Number(qty) > tierSol;
  const usdcBucket = Number.isFinite(refNum)
    ? (tierSol * refNum * boundPct) / 100
    : NaN;
  const notional = (kind === "market" ? refNum : Number(price)) * Number(qty);

  const fills = useMemo(() => trades.filter((t) => t.state === "settled"), [trades]);
  const last = fills[0];
  const prev = fills[1];
  const lastDir =
    last && prev ? Math.sign(Number(last.price) - Number(prev.price)) : 0;
  const volume = useMemo(
    () => fills.reduce((s, t) => s + Number(t.qty ?? 0), 0),
    [fills],
  );
  const notionalVol = useMemo(
    () => fills.reduce((s, t) => s + Number(t.notional ?? 0), 0),
    [fills],
  );

  /* ---- actions ------------------------------------------------- */
  async function onFaucet() {
    if (!me) return;
    setBusy("Requesting demo tokens…");
    try {
      await faucet(me);
      setMsg({
        kind: "ok",
        text: `Funded: ${markets.map((m) => `10 ${m.symbol}-mock`).join(", ")}, 5000 USDC-mock and a little SOL for fees.`,
      });
      refreshBalance();
    } catch (e: any) {
      setMsg({ kind: "err", text: e.message ?? String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!me || !signTransaction || !status) return;
    setMsg(null);
    try {
      if (marketUnavailable)
        throw new Error(
          "No fresh reference price to peg a market order to. Wait for the oracle or place a limit order.",
        );
      const p = effPrice;
      const q = Number(qty);
      if (!(p > 0))
        throw new Error(
          kind === "market" ? "Reference price unavailable." : "Enter a positive limit price.",
        );
      if (!(q > 0)) throw new Error("Enter a positive quantity.");
      if (q > tierSol)
        throw new Error(
          `Quantity must be at most ${tierSol} ${sym} (the collateral tier).`,
        );
      if (untradable) throw new Error(state?.untradableReason ?? `${sym} is not tradable right now.`);

      setBusy("Encrypting side, price and quantity in the browser…");
      const enc = encryptOrder(status.mxePublicKey, {
        isBuy: side === "bid",
        priceMicroUsdc: BigInt(Math.round(p * 1e6)),
        qtyLamports: BigInt(Math.round(q * 1e9)),
      });
      const commitment = await orderCommitment(enc);

      setBusy("Opening batch and building your collateral deposit…");
      const prep = await prepareOrder(me, commitment, sym);

      setBusy("Waiting for your wallet to sign the deposit…");
      const tx = Transaction.from(Buffer.from(prep.tx, "base64"));
      const signed = await signTransaction(tx);
      const signedB64 = Buffer.from(signed.serialize()).toString("base64");

      setBusy("Submitting ciphertext and signed deposit…");
      await submitOrder(prep.batchId, me, signedB64, enc);
      setMsg({
        kind: "ok",
        text: `${kind === "market" ? `${sym} market order placed in batch ${prep.batchId} as a limit at ${p.toFixed(2)} (reference ${refNum.toFixed(2)} ± ${slipPct}%).` : `${sym} limit order placed in batch ${prep.batchId}.`} Side, price and size never left this browser in plaintext; the deposit carries only a hash of the ciphertext.`,
      });
      refreshBalance();
    } catch (err: any) {
      setMsg({ kind: "err", text: err.message ?? String(err) });
    } finally {
      setBusy(null);
    }
  }

  /* ---- render -------------------------------------------------- */
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Mark />
          <div>
            <div className="word">PriMesh</div>
            <div className="sub">
              Encrypted matching · Arcium MPC · Solana{" "}
              {status ? status.cluster : ""}
            </div>
          </div>
        </div>
        <div className="topright">
          {pi && (
            <div className="ticker" title={pi.note ?? pi.account}>
              <MarketIcon symbol={sym} size={18} />
              <span className="pair">{sym} / USDC</span>
              <span className="px">
                {Number.isFinite(refNum) ? refNum.toFixed(2) : "—"}
              </span>
              <span className="meta">
                {pi.source === "pyth"
                  ? pi.publishTime
                    ? `pyth · ${priceAge}s ago`
                    : "pyth · no account"
                  : "mock · fixed"}
              </span>
            </div>
          )}
          <WalletMultiButton />
        </div>
      </header>

      <nav className="markets" aria-label="Markets">
        {markets.map((m) => {
          const st = snap?.markets[m.symbol];
          const px = st && Number(st.price.human) > 0 ? Number(st.price.human) : NaN;
          const age = st?.price.publishTime
            ? Math.max(0, Math.floor(now / 1000 - st.price.publishTime))
            : null;
          const isClosed = st ? !st.hours.isOpen : false;
          const busyPhase = st && (st.phase === "collecting" || st.phase === "matching");
          return (
            <button
              key={m.symbol}
              type="button"
              className={`mkt ${m.symbol === sym ? "on" : ""}`}
              onClick={() => setMarket(m.symbol)}
              title={st?.untradableReason ?? `${m.name} · Pyth feed ${m.feedId.slice(0, 10)}…`}
            >
              <MarketIcon symbol={m.symbol} size={30} />
              <span className="id">
                <span className="sym">{m.symbol}</span>
                <span className="nm">{m.name}</span>
              </span>
              <span className="px">
                <span className="n">{Number.isFinite(px) ? px.toFixed(2) : "—"}</span>
                <span className="meta">
                  {busyPhase ? (
                    <span className="tag live">{st!.phase}</span>
                  ) : isClosed ? (
                    <span className="tag closed">closed</span>
                  ) : st && !st.tradable ? (
                    <span className="tag warn">no feed</span>
                  ) : age !== null ? (
                    `${age}s ago`
                  ) : (
                    "—"
                  )}
                </span>
              </span>
            </button>
          );
        })}
        {!markets.length && <div className="mkt empty">Loading markets…</div>}
      </nav>

      <div className="strip">
        <div>
          <span className="k">Engine</span>
          <span className={`pill ${apiErr ? "warn" : state ? "live" : ""}`}>
            <span className="led" />
            {apiErr ? "offline" : state ? state.phase : "connecting"}
          </span>
        </div>
        <div>
          <span className="k">Oracle</span>
          <span className={`v ${priceStale || closed ? "pend" : ""}`}>
            {pi ? (pi.source === "pyth" ? "Pyth on-chain" : "mock") : "—"}
            {closed ? " · market closed" : priceStale ? " · stale" : ""}
          </span>
        </div>
        <div>
          <span className="k">MXE</span>
          <span className="v">
            {status ? `offset ${status.clusterOffset}` : "—"}
          </span>
        </div>
        <div>
          <span className="k">Tier</span>
          <span className="v">{tierSol} {sym} / party</span>
        </div>
        <div>
          <span className="k">Window</span>
          <span className="v">{Math.round(windowMs / 1000)}s</span>
        </div>
        <div>
          <span className="k">Fills</span>
          <span className="v">{fills.length}</span>
        </div>
        {status && (
          <div>
            <span className="k">Programs</span>
            <span className="v">
              {short(status.programs.darkpool, 4)} ·{" "}
              {short(status.programs.settlement, 4)}
            </span>
          </div>
        )}
      </div>

      {apiErr && (
        <div className="banner err" onClick={() => setApiErr(null)}>
          Coordinator unreachable: {apiErr}. Start <code>yarn server</code> in{" "}
          <code>backend/</code>.
        </div>
      )}
      {msg && (
        <div
          className={`banner ${msg.kind === "ok" ? "ok" : "err"}`}
          onClick={() => setMsg(null)}
        >
          {msg.text}
        </div>
      )}

      <section className="desk">
        {/* ------------------------------------------------ ticket */}
        <div className="col col-ticket">
          <form className="panel" onSubmit={onSubmit}>
            <div className="panel-h">
              <h2>
                Order ticket · <span className="hl">{sym}</span>
              </h2>
              <span className="pill">
                <span className="led" />
                encrypted locally
              </span>
            </div>
            <div className="panel-b">
              <label>
                <span className="lab">
                  <span>Side</span>
                </span>
                <div className="segmented">
                  <button
                    type="button"
                    className={side === "bid" ? "on buy" : ""}
                    onClick={() => setSide("bid")}
                  >
                    Buy {sym}
                  </button>
                  <button
                    type="button"
                    className={side === "ask" ? "on sell" : ""}
                    onClick={() => setSide("ask")}
                  >
                    Sell {sym}
                  </button>
                </div>
              </label>
              <label>
                <span className="lab">
                  <span>Order type</span>
                </span>
                <div className="segmented">
                  <button
                    type="button"
                    className={kind === "market" ? "on" : ""}
                    onClick={() => setKind("market")}
                  >
                    Market
                  </button>
                  <button
                    type="button"
                    className={kind === "limit" ? "on" : ""}
                    onClick={() => setKind("limit")}
                  >
                    Limit
                  </button>
                </div>
              </label>
              {kind === "limit" ? (
                <label>
                  <span className="lab">
                    <span>Limit price · USDC per {sym}</span>
                    <span className="num">
                      ref {pi ? Number(pi.human).toFixed(2) : "…"}
                    </span>
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    required
                  />
                </label>
              ) : (
                <>
                  <label>
                    <span className="lab">
                      <span>Market price · USDC per {sym}</span>
                      <span className="num">
                        {pi && pi.publishTime
                          ? `${pi.source} · ${priceAge}s ago`
                          : "waiting for oracle"}
                      </span>
                    </span>
                    <div className={`quote ${priceStale ? "stale" : ""}`}>
                      <span className="big">
                        {Number.isFinite(refNum) ? refNum.toFixed(2) : "—"}
                      </span>
                      <span className="sub">
                        {Number.isFinite(marketLimit)
                          ? `protective limit ${marketLimit.toFixed(2)}`
                          : "no reference"}
                      </span>
                    </div>
                  </label>
                  <label>
                    <span className="lab">
                      <span>Max slippage from reference</span>
                    </span>
                    <div className="segmented three">
                      {[0.5, 1, 2].map((s) => (
                        <button
                          key={s}
                          type="button"
                          className={slipPct === s ? "on" : ""}
                          onClick={() => setSlipPct(s)}
                        >
                          {s}%
                        </button>
                      ))}
                    </div>
                  </label>
                </>
              )}
              <label>
                <span className="lab">
                  <span>Quantity · {sym}</span>
                  <span className="num">max {tierSol}</span>
                </span>
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  max={tierSol}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  required
                />
              </label>

              <div className="summary">
                <dl className="kv">
                  <dt>Notional</dt>
                  <dd>
                    {Number.isFinite(notional) ? notional.toFixed(2) : "—"}{" "}
                    USDC
                  </dd>
                  <dt>Collateral · {sym}-mock</dt>
                  <dd>{tierSol}</dd>
                  <dt>Collateral · USDC-mock</dt>
                  <dd>
                    {Number.isFinite(usdcBucket) ? usdcBucket.toFixed(2) : "—"}
                  </dd>
                  <dt>Encrypted limit</dt>
                  <dd>
                    {Number.isFinite(effPrice) && effPrice > 0
                      ? effPrice.toFixed(2)
                      : "—"}
                  </dd>
                  <dt>Fill rule</dt>
                  <dd>
                    {kind === "market"
                      ? "clears at reference"
                      : "ref if inside spread, else mid"}
                  </dd>
                </dl>
              </div>

              {untradable && (
                <div className="note">
                  {state?.untradableReason}
                  {closed && state?.hours.nextOpen
                    ? ` Next open: ${fmtClock(state.hours.nextOpen)}.`
                    : ""}
                </div>
              )}
              {marketUnavailable && !untradable && (
                <div className="note">
                  {priceStale
                    ? `The reference is ${priceAge}s old; the program rejects references older than 60 s. Wait for a fresh tick or switch to a limit order.`
                    : "No reference price yet. Wait for the oracle or switch to a limit order."}
                </div>
              )}
              {bidTooHigh && (
                <div className="note">
                  Bid above {maxSettleable.toFixed(2)}, the most the USDC bucket
                  covers (reference × {boundPct}%). The MXE would report no
                  match.
                </div>
              )}
              {qtyTooBig && (
                <div className="note">
                  Quantity exceeds the {tierSol} {sym} tier; the MXE would
                  report no match.
                </div>
              )}

              <button
                type="submit"
                className={`primary ${side === "bid" ? "side-buy" : "side-sell"}`}
                disabled={!canSubmit}
              >
                {busy ??
                  (!connected
                    ? "Connect a wallet"
                    : mine
                      ? "Your order is in this batch"
                      : batchFull
                        ? "Batch is full"
                        : untradable
                          ? `${sym} not tradable now`
                          : collecting
                            ? `Join batch · ${side === "bid" ? "buy" : "sell"} ${sym}`
                            : `Open a batch · ${side === "bid" ? "buy" : "sell"} ${sym}`)}
              </button>
              <p className="fine">
                Both parties escrow the same two buckets whichever side they
                are on, so the deposit reveals neither side nor size. The order
                is encrypted here with the MXE key; only its hash goes on-chain.
              </p>
            </div>
          </form>

          <div className="panel">
            <div className="panel-h">
              <h2>Account</h2>
              {connected && balance && (
                <a href={balance.explorer} target="_blank" rel="noreferrer">
                  <span className="num small">{short(me, 6)}</span>
                </a>
              )}
            </div>
            <div className="panel-b">
              {!connected && (
                <p className="muted small" style={{ margin: 0 }}>
                  Connect a devnet wallet (Phantom, Solflare, Backpack) to
                  trade.
                </p>
              )}
              {connected && balance && (
                <dl className="kv">
                  <dt>SOL · fees</dt>
                  <dd>{balance.sol}</dd>
                  {markets.map((m) => (
                    <Fragment key={m.symbol}>
                      <dt className="with-icon">
                        <MarketIcon symbol={m.symbol} size={14} />
                        {m.symbol}-mock
                      </dt>
                      <dd>{trim0(balance.bases?.[m.symbol] ?? "0")}</dd>
                    </Fragment>
                  ))}
                  <dt>USDC-mock</dt>
                  <dd>{trim0(balance.usdcMock)}</dd>
                </dl>
              )}
              {connected && (
                <div style={{ marginTop: 12 }}>
                  <button
                    className="ghost"
                    type="button"
                    disabled={!!busy}
                    onClick={onFaucet}
                  >
                    Get demo tokens
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ------------------------------------------------ engine */}
        <div className="col col-engine">
          <div className="panel">
            <div className="panel-h">
              <h2>
                Batch engine · <span className="hl">{sym}</span>
              </h2>
              {b && <span className="num small muted">batch {b.id}</span>}
            </div>
            <div className="panel-b engine">
              {!state && <div className="empty">Connecting to coordinator…</div>}

              {state?.phase === "idle" && (
                <div className="empty">
                  <Glyph />
                  No open batch. The first order opens one and starts a{" "}
                  {Math.round(windowMs / 1000)} second window for a
                  counterparty.
                </div>
              )}

              {collecting && b && (
                <>
                  <Ring fraction={fraction} seconds={secondsLeft} />
                  <div className="center small muted num">
                    tier {trim0(b.solBucket)} {sym}-mock +{" "}
                    {Number(b.usdcBucket).toFixed(2)} USDC-mock per party · ref{" "}
                    {Number(b.referencePrice).toFixed(2)}
                  </div>
                  <div className="slots">
                    {[0, 1].map((i) => {
                      const p = b.parties[i];
                      const pending = !p && b.reserved[i - b.parties.length];
                      return (
                        <div
                          key={i}
                          className={`slot ${p ? "filled" : pending ? "pending" : ""}`}
                        >
                          <span className="t">Slot {i === 0 ? "A" : "B"}</span>
                          <span className="w">
                            {p ? short(p.wallet, 5) : pending ? "signing…" : "waiting"}
                            {p && p.wallet === me && (
                              <span className="you">YOU</span>
                            )}
                          </span>
                          {p && (
                            <a
                              className="small"
                              href={`https://explorer.solana.com/tx/${p.depositSig}?cluster=devnet`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              deposit ↗
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {mine && (
                    <p className="fine center">
                      Your order is in. Nobody, including the coordinator,
                      knows whether it is a buy or a sell.
                    </p>
                  )}
                </>
              )}

              {state?.phase === "matching" && (
                <ol className="steps">
                  {["oracle", "queue_mxe", "await_mpc", "settle"].map(
                    (name) => {
                      const s = state.steps
                        .filter(
                          (x) =>
                            x.name === name ||
                            (name === "settle" && x.name === "cancel"),
                        )
                        .slice(-1)[0];
                      return (
                        <li key={name} className={s ? s.status : "pending"}>
                          <span className="dot" />
                          <div>
                            <div className="label">
                              {s?.name === "cancel"
                                ? STEP_LABELS.cancel
                                : STEP_LABELS[name]}
                            </div>
                            {s?.detail && (
                              <div className="detail">{s.detail}</div>
                            )}
                            {s?.explorer && (
                              <a
                                className="small"
                                href={s.explorer}
                                target="_blank"
                                rel="noreferrer"
                              >
                                view transaction ↗
                              </a>
                            )}
                          </div>
                        </li>
                      );
                    },
                  )}
                </ol>
              )}

              {(state?.phase === "settled" ||
                state?.phase === "cancelled" ||
                state?.phase === "error") && (
                <ResultCard r={state.result} error={state.error} me={me} sym={sym} />
              )}
            </div>
          </div>

          <div className="guar">
            <div className="panel">
              <div className="panel-b">
                <b>Encrypted in the browser</b>
                Side, limit price and size are encrypted with the MXE x25519
                key before anything leaves this page. The coordinator only
                relays ciphertext.
              </div>
            </div>
            <div className="panel">
              <div className="panel-b">
                <b>Commitment-bound</b>
                Each deposit records a hash of the ciphertext. The darkpool
                program recomputes it before queueing, so nobody can swap
                orders.
              </div>
            </div>
            <div className="panel">
              <div className="panel-b">
                <b>Oracle verified on-chain</b>
                The reference price is read from Pyth inside the program:
                owner, feed, confidence and age are checked. The feed must be
                the one registered for the market's pool, so a gold batch can
                never be priced with SOL/USD.
              </div>
            </div>
          </div>
        </div>

        {/* ------------------------------------------------ book */}
        <div className="col col-book">
          <TradeBookPanel
            sym={sym}
            trades={trades}
            fills={fills}
            me={me}
            last={last}
            lastDir={lastDir}
            volume={volume}
            notionalVol={notionalVol}
            onRefresh={refreshTrades}
          />
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TradeBookPanel({
  sym,
  trades,
  fills,
  me,
  last,
  lastDir,
  volume,
  notionalVol,
  onRefresh,
}: {
  sym: string;
  trades: Trade[];
  fills: Trade[];
  me?: string;
  last?: Trade;
  lastDir: number;
  volume: number;
  notionalVol: number;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<"tape" | "batches" | "mine">("tape");
  const rows =
    tab === "tape"
      ? fills
      : tab === "mine"
        ? trades.filter((t) => me && t.parties.includes(me))
        : trades;

  return (
    <div className="panel">
      <div className="panel-h">
        <h2>
          Trade book · <span className="hl">{sym}</span>
        </h2>
        <div className="tabs">
          <button
            className={tab === "tape" ? "on" : ""}
            onClick={() => setTab("tape")}
            type="button"
          >
            Tape
          </button>
          <button
            className={tab === "batches" ? "on" : ""}
            onClick={() => setTab("batches")}
            type="button"
          >
            Batches
          </button>
          <button
            className={tab === "mine" ? "on" : ""}
            onClick={() => setTab("mine")}
            type="button"
            disabled={!me}
          >
            Mine
          </button>
        </div>
      </div>
      <div className="stats">
        <div>
          <div className="k">Last</div>
          <div
            className={`v ${lastDir > 0 ? "buy" : lastDir < 0 ? "sell" : ""}`}
          >
            {last ? Number(last.price).toFixed(2) : "—"}
          </div>
        </div>
        <div>
          <div className="k">Volume · {sym}</div>
          <div className="v">{volume ? trim0(volume.toFixed(3)) : "0"}</div>
        </div>
        <div>
          <div className="k">Volume · USDC</div>
          <div className="v">{notionalVol ? notionalVol.toFixed(2) : "0"}</div>
        </div>
      </div>
      <div className="book">
        {tab === "tape" ? (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th className="r">Price</th>
                <th className="r">Size</th>
                <th className="r">Notional</th>
                <th>Buyer</th>
                <th>Seller</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No {sym} fills on-chain yet.
                  </td>
                </tr>
              )}
              {rows.map((t, i) => {
                const p = rows[i + 1];
                const dir = p ? Math.sign(Number(t.price) - Number(p.price)) : 0;
                const isMine = !!(me && t.parties.includes(me));
                return (
                  <tr key={t.batchId} className={isMine ? "mine" : ""}>
                    <td className="muted">{fmtDate(t.time)}</td>
                    <td
                      className={`r ${dir > 0 ? "buy" : dir < 0 ? "sell" : ""}`}
                    >
                      {Number(t.price).toFixed(2)}
                    </td>
                    <td className="r">{trim0(t.qty)}</td>
                    <td className="r">{Number(t.notional).toFixed(2)}</td>
                    <td>
                      {short(t.buyer)}
                      {t.buyer && t.buyer === me && (
                        <span className="you">YOU</span>
                      )}
                    </td>
                    <td>
                      {short(t.seller)}
                      {t.seller && t.seller === me && (
                        <span className="you">YOU</span>
                      )}
                    </td>
                    <td>
                      <a href={t.explorer} target="_blank" rel="noreferrer">
                        ↗
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Batch</th>
                <th>Status</th>
                <th className="r">Price</th>
                <th className="r">Size</th>
                <th>Parties</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    {tab === "mine"
                      ? `No ${sym} batches with your wallet yet.`
                      : `No ${sym} batches on-chain yet.`}
                  </td>
                </tr>
              )}
              {rows.map((t) => {
                const isMine = !!(me && t.parties.includes(me));
                return (
                  <tr key={t.batchId} className={isMine ? "mine" : ""}>
                    <td className="muted">{fmtDate(t.time)}</td>
                    <td className="muted">{t.batchId.slice(-6)}</td>
                    <td>
                      <span className={`st ${t.state}`}>
                        {t.state === "settled"
                          ? "filled"
                          : t.state === "cancelled"
                            ? "no fill"
                            : "open"}
                      </span>
                    </td>
                    <td className="r">
                      {t.price ? Number(t.price).toFixed(2) : "—"}
                    </td>
                    <td className="r">{t.qty ? trim0(t.qty) : "—"}</td>
                    <td>
                      {t.parties.map((w) => (
                        <span key={w} style={{ marginRight: 6 }}>
                          {short(w, 3)}
                          {w === me && <span className="you">YOU</span>}
                        </span>
                      ))}
                      {t.parties.length === 0 && "—"}
                    </td>
                    <td>
                      <a href={t.explorer} target="_blank" rel="noreferrer">
                        ↗
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="footer-note">
        Read from settlement <code>Batch</code> accounts on-chain. Only what
        settlement already made public appears here: clearing price, size and
        who bought. Unmatched batches show no price, side or size.{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onRefresh();
          }}
        >
          refresh
        </a>
      </div>
    </div>
  );
}

function ResultCard({
  r,
  error,
  me,
  sym,
}: {
  r?: Result;
  error?: string;
  me?: string;
  sym: string;
}) {
  if (error) return <div className="result err">Batch failed: {error}</div>;
  if (!r) return null;
  const mine = !!(me && r.parties?.includes(me));
  return (
    <div className={`result ${r.matched ? "ok" : "no"}`}>
      {r.matched ? (
        <>
          <div className="big">
            FILLED {trim0(r.qty)} {r.market ?? sym} @ {r.clearingPriceHuman} USDC
          </div>
          <div>
            {mine
              ? `You were the ${r.buyer === me ? "buyer" : "seller"}. `
              : ""}
            Buyer paid {r.usdcPaidHuman} USDC-mock. Collateral netted for both
            parties in one transaction.
            {r.referencePrice
              ? ` Reference verified on-chain at queue time: ${Number(r.referencePrice).toFixed(2)} (${r.priceSource}).`
              : ""}
          </div>
        </>
      ) : (
        <>
          <div className="big">
            {r.reason === "incomplete" ? "NO COUNTERPARTY" : "NO MATCH"}
          </div>
          <div>
            {r.reason === "incomplete"
              ? "The window closed with only one party. Collateral refunded."
              : "No cross, same side, or different sizes: the MXE does not say which. Collateral refunded. The on-chain result is all zeros."}
          </div>
        </>
      )}
      <div className="links">
        {r.settleExplorer && (
          <a href={r.settleExplorer} target="_blank" rel="noreferrer">
            settlement tx ↗
          </a>
        )}
        {r.matchResultExplorer && (
          <a href={r.matchResultExplorer} target="_blank" rel="noreferrer">
            MatchResult PDA ↗
          </a>
        )}
      </div>
    </div>
  );
}

function Ring({ fraction, seconds }: { fraction: number; seconds: number }) {
  const r = 66;
  const c = 2 * Math.PI * r;
  return (
    <div className="ring">
      <svg width="150" height="150" viewBox="0 0 150 150">
        <circle className="track" cx="75" cy="75" r={r} fill="none" strokeWidth="6" />
        <circle
          className="bar"
          cx="75"
          cy="75"
          r={r}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - fraction)}
        />
      </svg>
      <div className="val">
        <span className="n">{seconds}</span>
        <span className="u">seconds</span>
      </div>
    </div>
  );
}

function Mark() {
  return <img className="mark" src="/primesh.png" alt="" aria-hidden="true" />;
}

/**
 * Market badges. SOL: the three-bar Solana mark in the desk's teal/violet.
 * XAU: a gold tile with the element symbol Au.
 */
function MarketIcon({ symbol, size = 20 }: { symbol: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    className: "micon",
    "aria-hidden": true as const,
  };
  if (symbol === "SOL")
    return (
      <svg {...common} viewBox="0 0 32 32" fill="none">
        <defs>
          <linearGradient id="solg" x1="4" y1="28" x2="28" y2="4">
            <stop offset="0" stopColor="#14f195" />
            <stop offset="1" stopColor="#9945ff" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="7" fill="#0f172a" />
        <path
          d="M9.6 9.2a1 1 0 0 1 .7-.3H25l-3.3 3.4a1 1 0 0 1-.7.3H6.3l3.3-3.4zM9.6 20a1 1 0 0 1 .7-.3H25l-3.3 3.4a1 1 0 0 1-.7.3H6.3L9.6 20zM22.4 14.6a1 1 0 0 0-.7-.3H7l3.3 3.4a1 1 0 0 0 .7.3h14.7l-3.3-3.4z"
          fill="url(#solg)"
        />
      </svg>
    );
  if (symbol === "XAU")
    return (
      <svg {...common} viewBox="0 0 32 32" fill="none">
        <defs>
          <linearGradient id="xaug" x1="0" y1="0" x2="32" y2="32">
            <stop offset="0" stopColor="#f6d365" />
            <stop offset="0.55" stopColor="#d4a017" />
            <stop offset="1" stopColor="#a8780a" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="7" fill="url(#xaug)" />
        <path d="M6 23.5l3-7h14l3 7z" fill="#fff" fillOpacity="0.22" />
        <text
          x="16"
          y="20.6"
          textAnchor="middle"
          fontSize="13.5"
          fontWeight="800"
          fill="#fff"
          fontFamily="Manrope, 'Segoe UI', sans-serif"
        >
          Au
        </text>
      </svg>
    );
  return (
    <svg {...common} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="7" fill="#1b2230" />
      <text x="16" y="21" textAnchor="middle" fontSize="13" fontWeight="700" fill="#e6edf3" fontFamily="Manrope, sans-serif">
        {symbol.slice(0, 3)}
      </text>
    </svg>
  );
}

function Glyph() {
  return (
    <svg className="glyph" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <circle cx="20" cy="20" r="17" stroke="#b4bdcf" strokeWidth="2" strokeDasharray="4 4" />
      <path d="M12 20h16M20 12v16" stroke="#8a97ad" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
