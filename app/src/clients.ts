import { createPublicClient, createWalletClient, custom, http, type Abi, type WalletClient } from "viem";
import { CHAIN, DEP, MAINNET, MAINNET_RPC } from "./config";
import LeashVault from "./abi/LeashVault.json";
import LeashFactory from "./abi/LeashFactory.json";
import LeashDesk from "./abi/LeashDesk.json";
import UsdFaucet from "./abi/UsdFaucet.json";
import MirrorFeedHub from "./abi/MirrorFeedHub.json";
import IB20 from "./abi/IB20.json";
import Aggregator from "./abi/AggregatorV3Interface.json";

export const ABI = {
  vault: LeashVault.abi as Abi,
  factory: LeashFactory.abi as Abi,
  desk: LeashDesk.abi as Abi,
  faucet: UsdFaucet.abi as Abi,
  hub: MirrorFeedHub.abi as Abi,
  b20: IB20.abi as Abi,
  feed: Aggregator.abi as Abi,
};

export const testnet = createPublicClient({ chain: CHAIN, transport: http(undefined, { batch: true, retryCount: 3 }) });
export const mainnet = createPublicClient({ chain: MAINNET, transport: http(MAINNET_RPC, { batch: true, retryCount: 3 }) });

type Eip1193 = { request: (args: { method: string; params?: unknown }) => Promise<unknown>; on?: (e: string, f: (...a: any[]) => void) => void };

export function injected(): Eip1193 | null {
  return ((window as any).ethereum as Eip1193) ?? null;
}

/** Connects the browser wallet, switching (or adding) the Leash testnet. Every transaction carries the Builder Code. */
export async function connectWallet(): Promise<{ wallet: WalletClient; address: `0x${string}` }> {
  const eth = injected();
  if (!eth) throw new Error("No browser wallet found. Install Coinbase Wallet or MetaMask to continue.");
  const wallet = createWalletClient({ chain: CHAIN, transport: custom(eth), dataSuffix: DEP.dataSuffix } as any);
  const [address] = await wallet.requestAddresses();
  const current = await wallet.getChainId();
  if (current !== CHAIN.id) {
    try {
      await wallet.switchChain({ id: CHAIN.id });
    } catch {
      await wallet.addChain({ chain: CHAIN });
      await wallet.switchChain({ id: CHAIN.id });
    }
  }
  return { wallet, address };
}
