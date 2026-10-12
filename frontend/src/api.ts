import type { EncryptedOrder } from "./crypto";

export const API = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

export type Side = "bid" | "ask";
/**
 * Market orders are marketable limits pegged to the live reference price
 * (ref ± slippage); the circuit only ever sees a limit price.
 */
export type OrderKind = "market" | "limit";
export type Phase =
  | "idle"
  | "collecting"
  | "matching"
  | "settled"
  | "cancelled"
  | "error";

export interface Step {
  name: string;
  status: "running" | "done" | "error";
  detail?: string;
  sig?: string;
  explorer?: string;
  at: number;
}

export interface MarketInfo {
  symbol: string;
  name: string;
  kind: "crypto" | "equity" | "metal" | "fx";
  baseMint: string;
  pool: string;
  marketConfig: string;
  feedId: string;
  priceAccount: string;
  sponsored: boolean;
  solBucket: string;
}

export interface BatchView {
  id: string;
  closesAt: number;
  referencePrice: string;
  solBucket: string;
  usdcBucket: string;
  parties: { wallet: string; depositSig: string }[];
  reserved: string[];
}

export interface Result {
  market?: string;
  batchId: string;
  qty?: string;
  referencePrice?: string;
  priceSource?: string;
  matched: boolean;
  reason?: string;
  clearingPriceHuman?: string;
  usdcPaidHuman?: string;
  matchResultExplorer?: string;
  settleExplorer?: string;
  cancelSig?: string;
  parties?: string[];
  buyer?: string;
  seller?: string;
  finishedAt: number;
}

export interface PriceInfo {
  source: "pyth" | "mock";
  human: string;
  publishTime: number;
  note?: string;
  boundPct: string;
  account: string;
}

/** One market's engine state. */
export interface State {
  symbol: string;
  phase: Phase;
  windowMs: number;
  now: number;
  price: PriceInfo;
  hours: { isOpen: boolean; nextOpen: number | null; nextClose: number | null };
  /** False when a batch opened now could not be matched (stale/missing price, market closed). */
  tradable: boolean;
  untradableReason?: string;
  tier: { solBucket: string; solBucketLamports: string };
  batch?: BatchView;
  steps: Step[];
  result?: Result;
  error?: string;
}

export interface Snapshot {
  now: number;
  markets: Record<string, State>;
}

export interface Status {
  cluster: string;
  clusterOffset: number;
  configuredPriceSource: "pyth" | "mock";
  hermesConfigured: boolean;
  escrowBoundPct: string;
  solBucket: string;
  windowMs: number;
  mxePublicKey: string;
  programs: { darkpool: string; settlement: string };
  usdcMint: string;
  markets: MarketInfo[];
  state: Snapshot;
}

export interface Balance {
  wallet: string;
  sol: string;
  solMock: string;
  usdcMock: string;
  /** Base mock balance per market symbol. */
  bases: Record<string, string>;
  explorer: string;
}

/** One row of the on-chain trade book (a settlement `Batch` account). */
export interface Trade {
  market: string;
  batchId: string;
  /** Batch ids are the creation time in ms. */
  time: number;
  state: "open" | "settled" | "cancelled";
  matched: boolean;
  /** USDC per SOL, 6 dp string. Only for settled batches. */
  price?: string;
  /** SOL, 9 dp string. Only for settled batches. */
  qty?: string;
  /** USDC paid by the buyer, 6 dp string. */
  notional?: string;
  solBucket: string;
  usdcBucket: string;
  parties: string[];
  buyer?: string;
  seller?: string;
  explorer: string;
}

export interface TradeBook {
  updatedAt: number;
  trades: Trade[];
}

async function j<T>(r: Response): Promise<T> {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as T;
}

export const getStatus = () => fetch(`${API}/status`).then((r) => j<Status>(r));
export const getBalance = (wallet: string) =>
  fetch(`${API}/balance/${wallet}`).then((r) => j<Balance>(r));
export const getHistory = () =>
  fetch(`${API}/history`).then((r) => j<Result[]>(r));
export const getTrades = () =>
  fetch(`${API}/trades`).then((r) => j<TradeBook>(r));
export const faucet = (wallet: string) =>
  fetch(`${API}/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet }),
  }).then((r) => j<{ ok: boolean }>(r));

export const prepareOrder = (
  wallet: string,
  commitment: string,
  market: string,
) =>
  fetch(`${API}/order/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, commitment, market }),
  }).then((r) =>
    j<{
      batchId: string;
      market: string;
      solBucket: string;
      usdcBucket: string;
      closesAt: number;
      tx: string;
    }>(r),
  );

export const submitOrder = (
  batchId: string,
  wallet: string,
  signedTx: string,
  enc: EncryptedOrder,
) =>
  fetch(`${API}/order/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ batchId, wallet, signedTx, enc }),
  }).then((r) => j<{ ok: boolean; depositSig: string; closesAt: number }>(r));

export function subscribe(onState: (s: Snapshot) => void): () => void {
  const es = new EventSource(`${API}/events`);
  es.onmessage = (ev) => {
    try {
      onState(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  };
  return () => es.close();
}
