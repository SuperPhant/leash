// One agent cycle: mirror prices -> research -> for every vault delegated to this agent, propose, leash, plan,
// simulate and rebalance, publishing a rationale document whose keccak256 is committed onchain.
import { BaseError, ContractFunctionRevertedError, keccak256, toBytes } from "viem";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTES_BASE_URL, ROOT, loadDeployment, loadKey, targetChain } from "./config.js";
import { abi, testnetClients } from "./lib.js";
import { relayPrices, type RelayReport } from "./relay.js";
import { research, type Signal } from "./research.js";
import { baseline, leash, pct, type Weights } from "./strategy.js";
import { askModel } from "./llm.js";
import { planTrades, fmtUsd, type HoldingView, type PlannedTrade } from "./planner.js";
import { PROFILES, type Profile } from "./profiles.js";

const chain = targetChain();
const dep = loadDeployment(chain.id);
const { pub, wallet, account } = testnetClients(chain, loadKey("AGENT_KEY", "testnet-agent"));
const notesDir = process.env.LEASH_NOTES_DIR ?? join(ROOT, "notes-out");
const dryRun = process.env.LEASH_DRY_RUN === "1";
const vaultAbi = abi("LeashVault");
const factoryAbi = abi("LeashFactory");
const deskAbi = abi("LeashDesk");

interface VaultStatus {
  vault: string;
  name: string;
  status: string;
  detail?: string;
  epoch?: number;
  nav?: string;
  tx?: string;
  note?: string;
  at: string;
}

const now = Math.floor(Date.now() / 1000);
const tickerOf = new Map(dep.stocks.map((s) => [s.token.toLowerCase(), s.ticker]));

function inferProfile(vault: string, maxCap: number, minCash: number): Profile {
  const demo = dep.demoVaults.find((v) => v.vault.toLowerCase() === vault.toLowerCase());
  if (demo) return PROFILES.find((p) => p.id === demo.profile)!;
  if (maxCap >= 0.25) return PROFILES.find((p) => p.id === "momentum")!;
  if (minCash >= 0.15) return PROFILES.find((p) => p.id === "steady")!;
  return PROFILES.find((p) => p.id === "balanced")!;
}

function revertInfo(e: unknown): { name: string; args: string } | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) {
      return { name: r.data?.errorName ?? r.reason ?? "revert", args: JSON.stringify(r.data?.args ?? [], (_, v) => (typeof v === "bigint" ? v.toString() : v)) };
    }
  }
  return null;
}

const tradeArgs = (ts: PlannedTrade[]) =>
  ts.map((t) => ({ token: t.token, buy: t.buy, amountIn: t.amountIn, minAmountOut: t.minAmountOut }));

async function handleVault(vault: `0x${string}`, signals: Signal[], asOf: string): Promise<VaultStatus> {
  const base: VaultStatus = { vault, name: "", status: "", at: new Date().toISOString() };
  const [agent, paused, mandate, epoch, lastReb, snap, headroom, spreadBps] = (await Promise.all([
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "agent" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "paused" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "mandate" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "epoch" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "lastRebalance" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "snapshot" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "turnoverHeadroom" }),
    pub.readContract({ address: dep.desk, abi: deskAbi, functionName: "spreadBps" }),
  ])) as [string, boolean, any, bigint, bigint, [bigint, bigint, any[]], [bigint, bigint, bigint], number];

  const [cash, nav, holdingsRaw] = snap;
  const caps: Record<string, number> = {};
  const holdings: HoldingView[] = holdingsRaw.map((h) => {
    const ticker = tickerOf.get(String(h.token).toLowerCase()) ?? String(h.symbol);
    caps[ticker] = Number(h.capBps) / 10_000;
    return { token: h.token, ticker, decimals: Number(h.decimals), raw: h.raw, price: h.price, priceDecimals: Number(h.priceDecimals), value: h.value };
  });
  const profile = inferProfile(vault, Math.max(...Object.values(caps)), Number(mandate.minCashBps) / 10_000);
  base.name = profile.name;
  base.epoch = Number(epoch);
  base.nav = fmtUsd(nav);

  if (agent.toLowerCase() !== account.address.toLowerCase()) return { ...base, status: "not-mine" };
  if (paused) return { ...base, status: "paused", detail: "owner paused the agent" };
  if (now >= Number(mandate.expiry)) return { ...base, status: "expired", detail: "mandate expired" };
  const readyAt = Number(lastReb) + Number(mandate.cooldown);
  if (lastReb > 0n && now < readyAt) {
    return { ...base, status: "cooldown", detail: `next rebalance allowed at ${new Date(readyAt * 1000).toISOString()}` };
  }
  if (nav === 0n) return { ...base, status: "empty", detail: "vault holds nothing" };

  const maxAge = Number(mandate.maxOracleAge) - 1800;
  const frozen: Record<string, number> = {};
  for (const h of holdingsRaw) {
    const ticker = tickerOf.get(String(h.token).toLowerCase()) ?? String(h.symbol);
    if (h.price === 0n || now - Number(h.updatedAt) > maxAge) frozen[ticker] = Number(h.weightBps) / 10_000;
  }
  const tickers = holdings.map((h) => h.ticker);
  if (tickers.every((t) => t in frozen)) {
    return { ...base, status: "waiting", detail: "every oracle is older than the mandate allows (market closed or corporate action)" };
  }

  const current: Weights = Object.fromEntries(holdingsRaw.map((h) => [tickerOf.get(String(h.token).toLowerCase()) ?? h.symbol, Number(h.weightBps) / 10_000]));
  const limits = { caps, minCash: Number(mandate.minCashBps) / 10_000, frozen };
  const vaultSignals = signals.filter((s) => s.ticker in caps);
  const baselineW = baseline(profile.id, tickers, vaultSignals, limits);
  const llm = process.env.LEASH_NO_LLM === "1"
    ? null
    : await askModel({ profileName: profile.name, style: profile.style, caps, minCash: limits.minCash, frozen: Object.keys(frozen), signals: vaultSignals, current, baseline: baselineW });
  const proposal = llm?.targets ?? baselineW;
  const { weights: finalW, corrections } = leash(proposal, limits);

  const budget = ((headroom[1] - headroom[0]) * 97n) / 100n;
  let plan = planTrades({
    nav,
    cash,
    holdings,
    targets: finalW,
    frozen: new Set(Object.keys(frozen)),
    turnoverBudget: budget > 0n ? budget : 0n,
    minCashBps: BigInt(mandate.minCashBps),
    spreadBps: BigInt(spreadBps),
    slippageBps: BigInt(mandate.maxSlippageBps),
  });
  if (!plan.trades.length) {
    return { ...base, status: "on-target", detail: budget > 0n ? "portfolio already within tolerance of targets" : "turnover budget used up for this window" };
  }

  const nextEpoch = Number(epoch) + 1;
  const buildNote = (trades: PlannedTrade[], extra: string[]) => ({
    schema: "leash.rationale/v1",
    chainId: chain.id,
    vault,
    epoch: nextEpoch,
    agent: account.address,
    builderCode: dep.builderCode,
    createdAt: new Date().toISOString(),
    profile: { id: profile.id, name: profile.name, style: profile.style },
    mandate: {
      caps: Object.fromEntries(Object.entries(caps).map(([t, c]) => [t, pct(c)])),
      minCash: pct(limits.minCash),
      maxTurnoverPerWindow: `${Number(mandate.maxTurnoverBps) / 100}% per ${Number(mandate.turnoverWindow) / 3600}h`,
      maxSlippage: `${Number(mandate.maxSlippageBps) / 100}%`,
      maxOracleAge: `${(Number(mandate.maxOracleAge) / 3600).toFixed(1)}h`,
      cooldown: `${Number(mandate.cooldown) / 3600}h`,
      expiry: new Date(Number(mandate.expiry) * 1000).toISOString(),
    },
    market: {
      asOf,
      source: "Base mainnet Chainlink tokenized-equity feeds (total-return) + Coinbase Tokenized Stocks API",
      signals: vaultSignals.map((s) => ({
        ticker: s.ticker,
        price: Number(s.price.toFixed(4)),
        oracleAgeHours: Number(s.ageHours.toFixed(2)),
        ret1d: s.ret1d,
        ret5d: s.ret5d,
        ret20d: s.ret20d,
        vol20d: s.vol20d,
        maxDrawdown20d: s.maxDrawdown20d,
        onchainSupply: s.supply,
        supplyChange7d: s.supplyChange7d,
        multiplier: s.multiplier,
      })),
    },
    decision: {
      source: llm ? `llm:${llm.model}` : "rules:inverse-vol+momentum",
      summary: llm?.summary || `Rules-based rebalance toward an inverse-volatility allocation with a ${profile.id} momentum tilt.`,
      perAsset: llm?.perAsset ?? {},
      risks: llm?.risks ?? [],
      current: Object.fromEntries(Object.entries(current).map(([t, w]) => [t, pct(w)])),
      baseline: Object.fromEntries(Object.entries(baselineW).map(([t, w]) => [t, pct(w)])),
      proposed: Object.fromEntries(Object.entries(proposal).map(([t, w]) => [t, pct(w)])),
      final: Object.fromEntries(Object.entries(finalW).map(([t, w]) => [t, pct(w)])),
      frozen: Object.keys(frozen),
    },
    leashCorrections: [...corrections, ...plan.note, ...extra],
    trades: trades.map((t) => ({
      ticker: t.ticker,
      side: t.buy ? "buy" : "sell",
      amountIn: t.amountIn.toString(),
      minAmountOut: t.minAmountOut.toString(),
      notionalUsd: Number(t.usd) / 1e6,
    })),
    disclaimer: "Testnet demonstration on mirrored prices. Not investment advice. Not available to US persons.",
  });

  const extra: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const noteJson = JSON.stringify(buildNote(plan.trades, extra), null, 2) + "\n";
    const hash = keccak256(toBytes(noteJson));
    const rel = `${chain.id}/${vault}/${nextEpoch}.json`;
    const uri = `${NOTES_BASE_URL}/${rel}`;
    try {
      const { request } = await pub.simulateContract({
        address: vault,
        abi: vaultAbi,
        functionName: "rebalance",
        args: [tradeArgs(plan.trades), hash, uri],
        account,
      });
      const file = join(notesDir, rel);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, noteJson);
      if (dryRun) return { ...base, status: "dry-run", detail: `${plan.trades.length} trades simulated OK`, note: uri };
      const tx = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash: tx });
      if (receipt.status !== "success") return { ...base, status: "failed", tx, detail: "transaction reverted" };
      return {
        ...base,
        status: "rebalanced",
        epoch: nextEpoch,
        tx,
        note: uri,
        detail: plan.trades.map((t) => `${t.buy ? "buy" : "sell"} ${t.ticker} ${fmtUsd(t.usd)}`).join(", "),
      };
    } catch (e) {
      const info = revertInfo(e);
      if (!info) throw e;
      extra.push(`attempt ${attempt + 1} rejected by the vault: ${info.name} ${info.args}; buys reduced 15%`);
      console.warn(`vault ${vault}: ${info.name} ${info.args}`);
      plan = { ...plan, trades: plan.trades.map((t) => (t.buy ? { ...t, amountIn: (t.amountIn * 85n) / 100n, minAmountOut: (t.minAmountOut * 85n) / 100n, usd: (t.usd * 85n) / 100n } : t)) };
      if (["NotAgent", "AgentPaused", "MandateExpired", "CooldownActive", "StaleOracle"].includes(info.name)) {
        return { ...base, status: "blocked", detail: `${info.name} ${info.args}` };
      }
    }
  }
  return { ...base, status: "blocked", detail: extra.join(" | ") };
}

let relay: RelayReport | { error: string } = { error: "skipped" };
if (process.env.LEASH_NO_RELAY !== "1") {
  try {
    relay = await relayPrices(pub, wallet, account, dep);
  } catch (e) {
    relay = { error: (e as Error).message.slice(0, 300) };
  }
}
console.log("relay:", JSON.stringify(relay));

const { signals, asOf } = await research(
  dep.stocks.map((s) => ({ ticker: s.ticker, mainnetFeed: s.mainnetFeed, mainnetToken: s.mainnetToken })),
  join(notesDir, "data", "closes.json"),
);
console.log(`research as of ${asOf}`);
for (const s of signals) {
  console.log(`  ${s.ticker.padEnd(5)} ${s.price.toFixed(2).padStart(9)} age ${s.ageHours.toFixed(1)}h 5d ${pct(s.ret5d ?? 0)} 20d ${pct(s.ret20d ?? 0)} vol ${pct(s.vol20d ?? 0)} closes ${s.closes}`);
}

const vaults = (await pub.readContract({ address: dep.factory, abi: factoryAbi, functionName: "vaults" })) as `0x${string}`[];
const statuses: VaultStatus[] = [];
for (const v of vaults) {
  try {
    const st = await handleVault(v, signals, asOf);
    if (st.status !== "not-mine") statuses.push(st);
    console.log(`${v} ${st.name}: ${st.status}${st.detail ? ` - ${st.detail}` : ""}${st.tx ? ` tx ${st.tx}` : ""}`);
  } catch (e) {
    statuses.push({ vault: v, name: "", status: "error", detail: (e as Error).message.slice(0, 300), at: new Date().toISOString() });
    console.error(`${v}: ${(e as Error).message}`);
  }
}

const statusFile = join(notesDir, String(chain.id), "status.json");
mkdirSync(join(statusFile, ".."), { recursive: true });
const history = existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, "utf8")).history ?? [] : [];
const run = {
  at: new Date().toISOString(),
  agent: account.address,
  relay,
  research: { asOf, signals },
  vaults: statuses,
};
writeFileSync(statusFile, JSON.stringify({ latest: run, history: [run, ...history].slice(0, 200) }, null, 1));
console.log(`status written to ${statusFile}`);

// Per-vault index for the app: every rebalance (tx + rationale) and a NAV time series sampled each run.
const indexFile = join(notesDir, String(chain.id), "index.json");
const index: { vaults: Record<string, { rebalances: unknown[]; nav: Array<[string, number]> }> } = existsSync(indexFile)
  ? JSON.parse(readFileSync(indexFile, "utf8"))
  : { vaults: {} };
for (const v of vaults) {
  const entry = (index.vaults[v.toLowerCase()] ??= { rebalances: [], nav: [] });
  try {
    const navNow = (await pub.readContract({ address: v, abi: vaultAbi, functionName: "nav" })) as bigint;
    entry.nav.push([new Date().toISOString(), Number(navNow) / 1e6]);
    entry.nav = entry.nav.slice(-2000);
  } catch {}
  const st = statuses.find((s) => s.vault === v);
  if (st?.status === "rebalanced") {
    entry.rebalances.unshift({ epoch: st.epoch, tx: st.tx, note: st.note, at: st.at, detail: st.detail });
  }
}
writeFileSync(indexFile, JSON.stringify(index));
console.log(`index written to ${indexFile}`);
