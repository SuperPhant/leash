// Market research built only from onchain and issuer data:
//   - Base mainnet Chainlink tokenized-equity feeds (total-return values) -> daily closes, returns, volatility
//   - Coinbase Tokenized Stocks API -> supply (net creations), multiplier, NAV reference
// Daily closes are cached in the notes branch so each run only fetches the newest day.
import { createPublicClient, fallback, http } from "viem";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAINNET } from "./config.js";
import { abi } from "./lib.js";

const aggAbi = abi("AggregatorV3Interface");
const DAY = 86_400;
const CLOSE_HOUR_UTC = 21; // after the US cash close in both EST and EDT

export interface Signal {
  ticker: string;
  price: number;
  updatedAt: number;
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
  closes: number;
}

export interface ClosesCache {
  [ticker: string]: { [day: string]: number };
}

export function mainnetReader() {
  const urls = (process.env.BASE_MAINNET_RPCS ??
    "https://mainnet.base.org,https://base-rpc.publicnode.com,https://base.drpc.org,https://1rpc.io/base").split(",");
  return createPublicClient({
    chain: MAINNET,
    transport: fallback(urls.map((u) => http(u.trim(), { retryCount: 3, retryDelay: 400, batch: { batchSize: 20 } }))),
  });
}

type RoundTuple = readonly [bigint, bigint, bigint, bigint, bigint];

class FeedReader {
  private cache = new Map<bigint, RoundTuple | null>();
  constructor(private client: ReturnType<typeof mainnetReader>, private feed: `0x${string}`) {}

  async round(id: bigint): Promise<RoundTuple | null> {
    if (this.cache.has(id)) return this.cache.get(id)!;
    let r: RoundTuple | null = null;
    try {
      r = (await this.client.readContract({ address: this.feed, abi: aggAbi, functionName: "getRoundData", args: [id] })) as RoundTuple;
      if (r[3] === 0n) r = null;
    } catch {
      r = null;
    }
    this.cache.set(id, r);
    return r;
  }

  async latest(): Promise<RoundTuple> {
    return (await this.client.readContract({ address: this.feed, abi: aggAbi, functionName: "latestRoundData" })) as RoundTuple;
  }

  /** Price of the last round updated at or before `t` within the current phase, or null if older than the phase. */
  async priceAt(latest: RoundTuple, t: number): Promise<number | null> {
    if (Number(latest[3]) <= t) return Number(latest[1]) / 1e8;
    const phase = latest[0] >> 64n;
    let lo = 1n;
    let hi = latest[0] & ((1n << 64n) - 1n);
    const first = await this.round((phase << 64n) | lo);
    if (!first || Number(first[3]) > t) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      const r = await this.round((phase << 64n) | mid);
      if (r && Number(r[3]) <= t) lo = mid;
      else hi = mid - 1n;
    }
    const r = await this.round((phase << 64n) | lo);
    return r ? Number(r[1]) / 1e8 : null;
  }
}

function dayKey(t: number) {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

/** Weekday close timestamps (21:00 UTC) for the last `days` calendar days, oldest first. */
function closeTimes(now: number, days: number): number[] {
  const out: number[] = [];
  const today = Math.floor(now / DAY) * DAY;
  for (let d = days; d >= 1; d--) {
    const t = today - d * DAY + CLOSE_HOUR_UTC * 3600;
    const wd = new Date(t * 1000).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(t);
  }
  const todayClose = today + CLOSE_HOUR_UTC * 3600;
  const wd = new Date(todayClose * 1000).getUTCDay();
  if (todayClose <= now && wd !== 0 && wd !== 6) out.push(todayClose);
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        res[k] = await fn(items[k]);
      }
    }),
  );
  return res;
}

function stdev(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
}

export interface ResearchInput {
  ticker: string;
  mainnetFeed: `0x${string}`;
  mainnetToken: `0x${string}`;
}

export async function research(
  stocks: ResearchInput[],
  cachePath: string,
  opts: { now?: number; staleHours?: number } = {},
): Promise<{ signals: Signal[]; asOf: string }> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const staleHours = opts.staleHours ?? 26;
  const client = mainnetReader();
  const cache: ClosesCache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const supplyPath = join(dirname(cachePath), "supply.json");
  const supplyHist: Record<string, Record<string, number>> = existsSync(supplyPath)
    ? JSON.parse(readFileSync(supplyPath, "utf8"))
    : {};

  let api: Array<{ symbol: string; total_supply?: number; multiplier?: number; contract_address: string }> = [];
  try {
    const r = await fetch("https://api.coinbase.com/v1/tokenized-stocks?page_size=500");
    api = (await r.json()).tokens ?? [];
  } catch {
    api = [];
  }

  const times = closeTimes(now, 31);
  const signals = await pool(stocks, 3, async (s): Promise<Signal> => {
    const reader = new FeedReader(client, s.mainnetFeed);
    const latest = await reader.latest();
    const price = Number(latest[1]) / 1e8;
    const updatedAt = Number(latest[3]);
    const closes = (cache[s.ticker] ??= {});
    const missing = times.filter((t) => closes[dayKey(t)] === undefined);
    for (const t of missing) {
      const p = await reader.priceAt(latest, t);
      if (p !== null) closes[dayKey(t)] = p;
    }
    const series = times.map((t) => closes[dayKey(t)]).filter((x): x is number => typeof x === "number");
    const last = price;
    const back = (n: number) => (series.length > n ? series[series.length - 1 - n] : null);
    const ret = (n: number) => {
      const b = back(n);
      return b ? last / b - 1 : null;
    };
    const window = series.slice(-21);
    const rets = window.slice(1).map((p, i) => Math.log(p / window[i]));
    let peak = -Infinity;
    let mdd = 0;
    for (const p of [...window, last]) {
      peak = Math.max(peak, p);
      mdd = Math.min(mdd, p / peak - 1);
    }
    const rec = api.find((x) => x.contract_address.toLowerCase() === s.mainnetToken.toLowerCase());
    const supply = rec?.total_supply ?? null;
    const hist = (supplyHist[s.ticker] ??= {});
    if (supply !== null) hist[dayKey(now)] = supply;
    const weekAgo = hist[dayKey(now - 7 * DAY)];
    return {
      ticker: s.ticker,
      price,
      updatedAt,
      ageHours: (now - updatedAt) / 3600,
      stale: now - updatedAt > staleHours * 3600,
      ret1d: ret(1),
      ret5d: ret(5),
      ret20d: ret(20),
      vol20d: rets.length >= 5 ? stdev(rets) * Math.sqrt(252) : null,
      maxDrawdown20d: window.length >= 5 ? mdd : null,
      supply,
      supplyChange7d: supply !== null && weekAgo ? supply / weekAgo - 1 : null,
      multiplier: rec?.multiplier ?? null,
      closes: series.length,
    };
  });

  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 1));
  writeFileSync(supplyPath, JSON.stringify(supplyHist, null, 1));
  return { signals, asOf: new Date(now * 1000).toISOString() };
}
