import { decodeEventLog, keccak256, toBytes } from "viem";
import { ABI, mainnet, testnet } from "./clients";
import { CHAIN, DEP, NOTES, TICKER_BY_TOKEN } from "./config";

export interface Mandate {
  minCashBps: number;
  maxTurnoverBps: number;
  turnoverWindow: number;
  maxSlippageBps: number;
  maxOracleAge: number;
  cooldown: number;
  expiry: number;
}

export interface Holding {
  token: `0x${string}`;
  symbol: string;
  ticker: string;
  decimals: number;
  capBps: number;
  raw: bigint;
  ui: bigint;
  price: number;
  updatedAt: number;
  value: number;
  weightBps: number;
}

export interface VaultData {
  address: `0x${string}`;
  owner: `0x${string}`;
  agent: `0x${string}`;
  paused: boolean;
  mandate: Mandate;
  epoch: number;
  lastRebalance: number;
  cash: number;
  nav: number;
  holdings: Holding[];
  turnover: { used: number; limit: number; resetsAt: number };
}

const usd = (x: bigint) => Number(x) / 1e6;

export async function loadVault(address: `0x${string}`): Promise<VaultData> {
  const c = { address, abi: ABI.vault } as const;
  const [owner, agent, paused, m, epoch, last, snap, head] = (await Promise.all([
    testnet.readContract({ ...c, functionName: "owner" }),
    testnet.readContract({ ...c, functionName: "agent" }),
    testnet.readContract({ ...c, functionName: "paused" }),
    testnet.readContract({ ...c, functionName: "mandate" }),
    testnet.readContract({ ...c, functionName: "epoch" }),
    testnet.readContract({ ...c, functionName: "lastRebalance" }),
    testnet.readContract({ ...c, functionName: "snapshot" }),
    testnet.readContract({ ...c, functionName: "turnoverHeadroom" }),
  ])) as [any, any, boolean, any, bigint, bigint, [bigint, bigint, any[]], [bigint, bigint, bigint]];
  return {
    address,
    owner,
    agent,
    paused,
    mandate: {
      minCashBps: Number(m.minCashBps),
      maxTurnoverBps: Number(m.maxTurnoverBps),
      turnoverWindow: Number(m.turnoverWindow),
      maxSlippageBps: Number(m.maxSlippageBps),
      maxOracleAge: Number(m.maxOracleAge),
      cooldown: Number(m.cooldown),
      expiry: Number(m.expiry),
    },
    epoch: Number(epoch),
    lastRebalance: Number(last),
    cash: usd(snap[0]),
    nav: usd(snap[1]),
    holdings: snap[2].map((h) => ({
      token: h.token,
      symbol: h.symbol,
      ticker: TICKER_BY_TOKEN.get(String(h.token).toLowerCase()) ?? h.symbol,
      decimals: Number(h.decimals),
      capBps: Number(h.capBps),
      raw: h.raw,
      ui: h.ui,
      price: Number(h.price) / 10 ** Number(h.priceDecimals || 8),
      updatedAt: Number(h.updatedAt),
      value: usd(h.value),
      weightBps: Number(h.weightBps),
    })),
    turnover: { used: usd(head[0]), limit: usd(head[1]), resetsAt: Number(head[2]) },
  };
}

export async function loadVaultList(): Promise<`0x${string}`[]> {
  return (await testnet.readContract({ address: DEP.factory, abi: ABI.factory, functionName: "vaults" })) as `0x${string}`[];
}

export interface Signal {
  ticker: string;
  price: number;
  ageHours: number;
  stale: boolean;
  ret1d: number | null;
  ret5d: number | null;
  ret20d: number | null;
  vol20d: number | null;
  maxDrawdown20d: number | null;
  supply: number | null;
  supplyChange7d: number | null;
  multiplier: number | null;
}

export interface AgentRun {
  at: string;
  agent: string;
  relay: any;
  research?: { asOf: string; signals: Signal[] };
  vaults: Array<{ vault: string; name: string; status: string; detail?: string; epoch?: number; nav?: string; tx?: string; note?: string; at: string }>;
}

async function json<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(`${url}?t=${Math.floor(Date.now() / 60_000)}`);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export const loadStatus = () => json<{ latest: AgentRun; history: AgentRun[] }>(`${NOTES}/${CHAIN.id}/status.json`);

export interface IndexFile {
  vaults: Record<string, { rebalances: Array<{ epoch: number; tx: `0x${string}`; note: string; at: string; detail?: string }>; nav: Array<[string, number]> }>;
}
export const loadIndex = () => json<IndexFile>(`${NOTES}/${CHAIN.id}/index.json`);

export interface Note {
  schema: string;
  vault: string;
  epoch: number;
  createdAt: string;
  profile: { id: string; name: string; style: string };
  mandate: Record<string, unknown>;
  market: { asOf: string; source: string; signals: any[] };
  decision: {
    source: string;
    summary: string;
    perAsset: Record<string, string>;
    risks: string[];
    current: Record<string, string>;
    baseline: Record<string, string>;
    proposed: Record<string, string>;
    final: Record<string, string>;
    frozen: string[];
  };
  leashCorrections: string[];
  trades: Array<{ ticker: string; side: string; notionalUsd: number }>;
}

/** Fetches a rationale note and checks it against the hash the agent committed onchain. */
export async function loadNote(uri: string, onchainHash?: string): Promise<{ note: Note | null; verified: boolean | null }> {
  try {
    const r = await fetch(uri);
    if (!r.ok) return { note: null, verified: null };
    const text = await r.text();
    const verified = onchainHash ? keccak256(toBytes(text)).toLowerCase() === onchainHash.toLowerCase() : null;
    return { note: JSON.parse(text) as Note, verified };
  } catch {
    return { note: null, verified: null };
  }
}

export interface RebalanceEvent {
  epoch: number;
  navBefore: number;
  navAfter: number;
  turnover: number;
  rationaleHash: `0x${string}`;
  rationaleURI: string;
  trades: Array<{ ticker: string; buy: boolean; notional: number; price: number }>;
  tx: `0x${string}`;
  block: bigint;
  timestamp: number;
  attributed: boolean;
}

/** Reads a rebalance straight from its transaction receipt, and checks the ERC-8021 Builder Code suffix. */
export async function loadRebalance(tx: `0x${string}`, vault: string): Promise<RebalanceEvent | null> {
  try {
    const [receipt, txData] = await Promise.all([testnet.getTransactionReceipt({ hash: tx }), testnet.getTransaction({ hash: tx })]);
    const block = await testnet.getBlock({ blockNumber: receipt.blockNumber });
    let ev: RebalanceEvent | null = null;
    const trades: RebalanceEvent["trades"] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
      try {
        const d = decodeEventLog({ abi: ABI.vault, data: log.data, topics: log.topics }) as any;
        if (d.eventName === "TradeExecuted") {
          trades.push({
            ticker: TICKER_BY_TOKEN.get(String(d.args.token).toLowerCase()) ?? "?",
            buy: d.args.buy,
            notional: Number(d.args.notional) / 1e6,
            price: Number(d.args.oraclePrice) / 1e8,
          });
        }
        if (d.eventName === "Rebalanced") {
          ev = {
            epoch: Number(d.args.epoch),
            navBefore: Number(d.args.navBefore) / 1e6,
            navAfter: Number(d.args.navAfter) / 1e6,
            turnover: Number(d.args.windowTurnover) / 1e6,
            rationaleHash: d.args.rationaleHash,
            rationaleURI: d.args.rationaleURI,
            trades,
            tx,
            block: receipt.blockNumber,
            timestamp: Number(block.timestamp),
            attributed: txData.input.toLowerCase().endsWith(DEP.dataSuffix.slice(2).toLowerCase()),
          };
        }
      } catch {}
    }
    return ev;
  } catch {
    return null;
  }
}

export interface MarketRow {
  ticker: string;
  price: number;
  updatedAt: number;
  round: bigint;
  feed: `0x${string}`;
  token: `0x${string}`;
}

/** Live Base mainnet Chainlink tokenized-equity feeds. */
export async function loadMarket(): Promise<MarketRow[]> {
  return Promise.all(
    DEP.stocks.map(async (s) => {
      const r = (await mainnet.readContract({ address: s.mainnetFeed, abi: ABI.feed, functionName: "latestRoundData" })) as readonly bigint[];
      return { ticker: s.ticker, price: Number(r[1]) / 1e8, updatedAt: Number(r[3]), round: r[0], feed: s.mainnetFeed, token: s.mainnetToken };
    }),
  );
}
