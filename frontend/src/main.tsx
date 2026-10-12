import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import App from "./App";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";

function Root() {
  // The browser never sends transactions itself (the coordinator relays them),
  // so the public devnet endpoint is fine here. Wallets are detected via the
  // Wallet Standard (Phantom, Solflare, Backpack...) so no adapters are listed.
  const endpoint = useMemo(() => import.meta.env.VITE_RPC_URL ?? clusterApiUrl("devnet"), []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
