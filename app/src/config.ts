import { defineChain, type Chain } from "viem";
import { base, baseSepolia } from "viem/chains";

export interface Deployment {
  chainId: number;
  chainName: string;
  deployedAt: string;
  deployer: `0x${string}`;
  agent: `0x${string}`;
  builderCode: string;
  dataSuffix: `0x${string}`;
  hub: `0x${string}`;
  usd: `0x${string}`;
  desk: `0x${string}`;
  faucet: `0x${string}`;
  factory: `0x${string}`;
  startBlock: string;
  stocks: Array<{
    ticker: string;
    token: `0x${string}`;
    feed: `0x${string}`;
    feedId: number;
    mainnetToken: `0x${string}`;
    mainnetFeed: `0x${string}`;
  }>;
  demoVaults: Array<{ name: string; vault: `0x${string}`; profile: string }>;
}

export const vibenet = defineChain({
  id: 84538453,
  name: "Base Vibenet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.vibes.base.org"] } },
  blockExplorers: { default: { name: "Vibenet Explorer", url: "https://chain.base.org/vibenet/explorer" } },
  testnet: true,
});

const found = import.meta.glob("../../deployments/*.json", { eager: true, import: "default" }) as Record<
  string,
  Deployment
>;
export const DEPLOYMENTS = Object.values(found).sort((a, b) => (a.chainId === 84532 ? -1 : b.chainId === 84532 ? 1 : 0));

function pick(): Deployment {
  const wanted = Number(new URLSearchParams(location.search).get("chain") ?? import.meta.env.VITE_CHAIN_ID ?? 84532);
  return DEPLOYMENTS.find((d) => d.chainId === wanted) ?? DEPLOYMENTS[0];
}

export const DEP: Deployment = pick();
export const CHAIN: Chain = DEP?.chainId === baseSepolia.id ? baseSepolia : vibenet;
export const MAINNET = base;
export const MAINNET_RPC = "https://mainnet.base.org";

export const EXPLORER =
  CHAIN.id === baseSepolia.id ? "https://sepolia.basescan.org" : "https://chain.base.org/vibenet/explorer";
export const MAINNET_EXPLORER = "https://basescan.org";

export const REPO = "https://github.com/SuperPhant/leash";
export const NOTES = "https://raw.githubusercontent.com/SuperPhant/leash/notes";

export const TICKER_BY_TOKEN = new Map((DEP?.stocks ?? []).map((s) => [s.token.toLowerCase(), s.ticker]));

export const STOCK_NAMES: Record<string, string> = {
  AAPL: "Apple",
  AMZN: "Amazon",
  GOOGL: "Alphabet",
  META: "Meta Platforms",
  MSFT: "Microsoft",
  MSTR: "Strategy",
  NVDA: "NVIDIA",
  SNDK: "Sandisk",
  SPCX: "SpaceX",
  TSLA: "Tesla",
};
