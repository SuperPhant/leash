import { defineChain, type Chain, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const vibenet = defineChain({
  id: 84538453,
  name: "Base Vibenet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.vibes.base.org"] } },
  blockExplorers: { default: { name: "Vibenet Explorer", url: "https://chain.base.org/vibenet/explorer" } },
  testnet: true,
});

const TARGETS: Record<string, Chain> = { vibenet, baseSepolia };

/** Chain the Leash contracts live on (a Base testnet). Mainnet is only ever read. */
export function targetChain(): Chain {
  const name = process.env.LEASH_CHAIN ?? "baseSepolia";
  const chain = TARGETS[name];
  if (!chain) throw new Error(`LEASH_CHAIN must be one of ${Object.keys(TARGETS).join(", ")}`);
  return chain;
}

export function targetRpc(chain: Chain): string {
  return process.env.LEASH_RPC ?? chain.rpcUrls.default.http[0];
}

export const MAINNET = base;
export const MAINNET_RPC = process.env.BASE_MAINNET_RPC ?? "https://mainnet.base.org";

/** ERC-8021 Builder Code registered for the agent wallet via api.base.dev. */
export const BUILDER_CODE = process.env.LEASH_BUILDER_CODE ?? "bc_dm1hqi1l";

export const NOTES_BASE_URL =
  process.env.LEASH_NOTES_URL ?? "https://raw.githubusercontent.com/SuperPhant/leash/notes";

export const B20_FACTORY = "0xB20f000000000000000000000000000000000000" as const;

export interface StockConfig {
  ticker: string;
  name: string;
  symbol: string;
  mainnetToken: `0x${string}`;
  decimals: number;
  isin: string;
  mainnetFeed: `0x${string}`;
  feedDecimals: number;
  feedDescription: string;
}

export const STOCKS: StockConfig[] = JSON.parse(readFileSync(join(ROOT, "agent", "stocks.json"), "utf8"));

/**
 * Reads a private key from the environment, or (on the maintainer's machine only) from the local DPAPI vault.
 * Keys are never printed.
 */
export function loadKey(envName: string, vaultEntry: string): Hex {
  const fromEnv = process.env[envName];
  if (fromEnv) return normalizeKey(fromEnv);
  const vault = process.env.PHANT_VAULT ?? join(homedir(), "AppData", "Local", "PhantWallet", "vault.py");
  const python = process.env.PHANT_PYTHON ?? join(homedir(), ".pyenv", "pyenv-win", "versions", "3.12.10", "python.exe");
  if (!existsSync(vault)) throw new Error(`${envName} is not set`);
  const r = spawnSync(python, [vault, "get", vaultEntry], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`could not read ${vaultEntry} from the local vault (output suppressed)`);
  return normalizeKey(r.stdout.trim());
}

function normalizeKey(k: string): Hex {
  const key = (k.startsWith("0x") ? k : `0x${k}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("malformed private key (value suppressed)");
  return key;
}

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

export function deploymentPath(chainId: number): string {
  return join(ROOT, "deployments", `${chainId}.json`);
}

export function loadDeployment(chainId: number): Deployment {
  return JSON.parse(readFileSync(deploymentPath(chainId), "utf8"));
}
