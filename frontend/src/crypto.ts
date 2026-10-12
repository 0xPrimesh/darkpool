/**
 * Client-side encryption of a whole order {side, price, qty} for the Arcium
 * MXE, plus the commitment the deposit records on-chain. Runs entirely in the
 * browser; the coordinator only ever receives ciphertext, and the darkpool
 * program checks that ciphertext against the commitment before matching.
 */
import { RescueCipher, x25519, deserializeLE } from "@arcium-hq/client";

export interface EncryptedOrder {
  pubkey: number[]; // our ephemeral x25519 public key
  nonce: string; // u128 as decimal string
  ciphertexts: number[][]; // [is_buy, price, qty], 32 bytes each
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function nonceLE16(nonceDecimal: string): Uint8Array {
  let n = BigInt(nonceDecimal);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

export function encryptOrder(
  mxePublicKeyHex: string,
  order: { isBuy: boolean; priceMicroUsdc: bigint; qtyLamports: bigint },
): EncryptedOrder {
  const mxePk = hexToBytes(mxePublicKeyHex);
  const sk = x25519.utils.randomSecretKey();
  const pk = x25519.getPublicKey(sk);
  const shared = x25519.getSharedSecret(sk, mxePk);
  const cipher = new RescueCipher(shared);
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const cts = cipher.encrypt(
    [order.isBuy ? 1n : 0n, order.priceMicroUsdc, order.qtyLamports],
    nonce,
  );
  return {
    pubkey: Array.from(pk),
    nonce: deserializeLE(nonce).toString(),
    ciphertexts: cts.map((c) => Array.from(c)),
  };
}

/** sha256(pubkey || nonce_le16 || ct_side || ct_price || ct_qty) as hex. */
export async function orderCommitment(enc: EncryptedOrder): Promise<string> {
  const parts = [
    new Uint8Array(enc.pubkey),
    nonceLE16(enc.nonce),
    ...enc.ciphertexts.map((c) => new Uint8Array(c)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
