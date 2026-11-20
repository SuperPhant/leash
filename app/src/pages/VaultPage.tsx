import { useState } from "react";
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, encodeFunctionData, parseUnits, toHex, zeroHash } from "viem";
import { useWallet } from "../App";
import { ABI, testnet } from "../clients";
import { CHAIN, DEP, TICKER_BY_TOKEN } from "../config";
import { loadIndex, loadNote, loadRebalance, loadVault, type Holding, type RebalanceEvent, type VaultData } from "../data";
import { AddrLink, Badge, Card, Empty, LineChart, Spinner, Stat, TxLink, WeightBar } from "../ui";
import { ago, duration, fmtBps, fmtUsd, short, useAsync } from "../util";

const tick = (token: string) => TICKER_BY_TOKEN.get(token.toLowerCase()) ?? (token.toLowerCase() === DEP.usd.toLowerCase() ? "tUSD" : short(token));

export function explainRevert(name: string, args: readonly unknown[] = [], nowSec = Date.now() / 1000): string {
  const a = args as any[];
  switch (name) {
    case "WeightCapExceeded":
      return `would put ${fmtBps(Number(a[1]))} of the vault into ${tick(a[0])}; the cap is ${fmtBps(Number(a[2]), 0)}.`;
    case "TurnoverExceeded":
      return `would trade ${fmtUsd(Number(a[0]) / 1e6, 0)} in the current window; the mandate allows ${fmtUsd(Number(a[1]) / 1e6, 0)}.`;
    case "CashFloorBreached":
      return `cash would fall to ${fmtBps(Number(a[0]))} of NAV; the floor is ${fmtBps(Number(a[1]), 0)}.`;
    case "AssetNotAllowed":
      return `${tick(a[0])} is not in this vault's mandate.`;
    case "BuyNotAllowed":
      return `${tick(a[0])} has a cap of 0%: the agent may only sell it.`;
    case "StaleOracle":
      return `the ${tick(a[0])} price would be ${((nowSec - Number(a[1])) / 3600).toFixed(1)}h old; the mandate accepts at most ${(Number(a[2]) / 3600).toFixed(0)}h.`;
    case "SlippageExceeded":
      return `execution would be worse than the mandate's slippage limit versus the Chainlink price.`;
    case "CooldownActive":
      return `the cooldown has not passed; the next rebalance is allowed ${new Date(Number(a[0]) * 1000).toLocaleString()}.`;
    case "NotOwner":
      return `only the vault owner can do that. The agent has no way to move funds out.`;
    case "NotAgent":
      return `only the agent the owner appointed can rebalance.`;
    case "AgentPaused":
      return `the owner paused the agent.`;
    case "MandateExpired":
      return `the agent's mandate has expired.`;
    default:
      return name;
  }
}

function decode(e: unknown): { name: string; args: readonly unknown[] } {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return { name: r.data?.errorName ?? r.reason ?? "reverted", args: r.data?.args ?? [] };
    return { name: e.shortMessage, args: [] };
  }
  return { name: String((e as Error)?.message ?? e), args: [] };
}

interface Scenario {
  id: string;
  title: string;
  story: string;
  run: () => Promise<{ allowed: boolean; name?: string; args?: readonly unknown[]; now?: number }>;
}

function scenarios(v: VaultData): Scenario[] {
  const usd6 = (x: number) => BigInt(Math.max(1, Math.floor(x * 1e6)));
  // Each check is shown on its own: the simulation pretends the cooldown has passed and a new turnover window
  // has started (vault storage slot 7 packs lastRebalance and windowStart), optionally fast-forwarding the clock.
  const sim = async (fn: "rebalance" | "withdrawAll", args: readonly unknown[], shiftSeconds = 0) => {
    const data = encodeFunctionData({ abi: ABI.vault, functionName: fn, args });
    try {
      await testnet.call({
        to: v.address,
        data,
        account: v.agent,
        stateOverride: [{ address: v.address, stateDiff: [{ slot: toHex(7, { size: 32 }), value: zeroHash }] }],
        ...(shiftSeconds ? { blockOverrides: { time: BigInt(Math.floor(Date.now() / 1000) + shiftSeconds) } } : {}),
      } as any);
      return { allowed: true };
    } catch (e) {
      const now = Date.now() / 1000 + shiftSeconds;
      const raw = e instanceof BaseError ? (e.walk((x: any) => typeof x?.data === "string" && x.data.startsWith("0x")) as any)?.data : undefined;
      if (raw) {
        try {
          const r = decodeErrorResult({ abi: ABI.vault, data: raw });
          return { allowed: false, name: r.errorName, args: r.args ?? [], now };
        } catch {}
      }
      const d = decode(e);
      return { allowed: false, name: d.name, args: d.args };
    }
  };
  const buy = (token: string, usd: number) => ({ token, buy: true, amountIn: usd6(usd), minAmountOut: 0n });
  const list: Scenario[] = [];
  const turnoverBudget = (v.mandate.maxTurnoverBps / 10_000) * v.nav;
  const byRoom = [...v.holdings]
    .filter((h) => h.capBps > 0 && h.updatedAt > 0)
    .map((h) => ({ h, need: ((h.capBps - h.weightBps) / 10_000 + 0.03) * v.nav }))
    .filter((x) => x.need < Math.min(v.cash, turnoverBudget) * 0.95)
    .sort((a, b) => a.need - b.need);
  const capCase = byRoom[0];
  if (capCase) {
    list.push({
      id: "overweight",
      title: `Push ${capCase.h.ticker} past its cap`,
      story: `The agent tries to buy ${fmtUsd(capCase.need, 0)} of ${capCase.h.ticker}, taking it from ${fmtBps(capCase.h.weightBps)} to about ${fmtBps(capCase.h.capBps + 300, 0)} of the vault. Its cap is ${fmtBps(capCase.h.capBps, 0)}.`,
      run: () => sim("rebalance", [[buy(capCase.h.token, capCase.need)], zeroHash, ""]),
    });
  }
  const outside = DEP.stocks.find((s) => !v.holdings.some((h) => h.token.toLowerCase() === s.token.toLowerCase()));
  const outsideToken = outside?.token ?? DEP.usd;
  list.push({
    id: "outside",
    title: `Buy ${outside ? outside.ticker : "an asset outside the list"}`,
    story: `The agent tries to buy something the owner never allowed${outside ? ` (${outside.ticker})` : ""}.`,
    run: () => sim("rebalance", [[buy(outsideToken, 100)], zeroHash, ""]),
  });
  const allowed = v.holdings.filter((h) => h.capBps > 0 && h.updatedAt > 0);
  if (allowed.length && v.cash > 0) {
    const each = (v.cash * 0.99) / allowed.length;
    list.push({
      id: "allin",
      title: "Spend all the cash at once",
      story: `The agent tries to deploy ${fmtUsd(v.cash * 0.99, 0)} in one go across ${allowed.length} stocks.`,
      run: () => sim("rebalance", [allowed.map((h) => buy(h.token, each)), zeroHash, ""]),
    });
  }
  const target = allowed[0] ?? v.holdings[0];
  if (target) {
    const shift = v.mandate.maxOracleAge + 2 * 3600;
    list.push({
      id: "stale",
      title: "Trade on a frozen price",
      story: `We fast-forward the clock ${duration(shift)}, as over a weekend or during a corporate action when Chainlink stops updating. The agent tries to buy ${target.ticker} anyway.`,
      run: () => sim("rebalance", [[buy(target.token, 100)], zeroHash, ""], shift),
    });
  }
  list.push({
    id: "drain",
    title: "Send the funds to itself",
    story: "A compromised agent tries to withdraw the whole vault to its own address.",
    run: () => sim("withdrawAll", [v.agent]),
  });
  return list;
}

function LeashTester({ v }: { v: VaultData }) {
  const [results, setResults] = useState<Record<string, { allowed: boolean; name?: string; args?: readonly unknown[]; now?: number } | "running">>({});
  const list = scenarios(v);
  const runOne = async (s: Scenario) => {
    setResults((r) => ({ ...r, [s.id]: "running" }));
    const res = await s.run();
    setResults((r) => ({ ...r, [s.id]: res }));
  };
  return (
    <Card
      title="Try to break the leash"
      extra={<span className="muted small">Simulated as the agent with eth_call (cooldown skipped so each rule shows on its own). No wallet or gas needed.</span>}
    >
      <div className="tester">
        {list.map((s) => {
          const r = results[s.id];
          return (
            <div key={s.id} className="scenario">
              <div className="scenario-text">
                <b>{s.title}</b>
                <p className="muted small">{s.story}</p>
                {r && r !== "running" && (
                  <div className={`verdict ${r.allowed ? "allowed" : "blocked"}`}>
                    {r.allowed ? (
                      <>Allowed: this action is inside the mandate.</>
                    ) : (
                      <>
                        <b>Blocked by the vault</b> <code>{r.name}</code>: {explainRevert(r.name ?? "", r.args, r.now)}
                      </>
                    )}
                  </div>
                )}
              </div>
              <button className="btn small ghost" onClick={() => runOne(s)} disabled={r === "running"}>
                {r === "running" ? <Spinner /> : "Try it"}
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Holdings({ v }: { v: VaultData }) {
  return (
    <Card title="Holdings" extra={<span className="muted small">Valued at Chainlink total-return prices; shares shown via B20 multiplier (ERC-8056)</span>}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Stock</th>
              <th className="num">Share-equivalent</th>
              <th className="num">Price</th>
              <th>Oracle</th>
              <th className="num">Value</th>
              <th style={{ width: "28%" }}>Weight vs cap</th>
            </tr>
          </thead>
          <tbody>
            {v.holdings.map((h: Holding) => (
              <tr key={h.token}>
                <td>
                  <b>{h.symbol}</b>
                </td>
                <td className="num">{(Number(h.ui) / 10 ** h.decimals).toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                <td className="num">{h.price ? fmtUsd(h.price) : "–"}</td>
                <td>
                  {h.updatedAt === 0 ? (
                    <Badge tone="bad">no price</Badge>
                  ) : Date.now() / 1000 - h.updatedAt > v.mandate.maxOracleAge ? (
                    <Badge tone="warn" title="Older than the mandate allows: the agent cannot trade this stock now.">
                      frozen {ago(h.updatedAt)}
                    </Badge>
                  ) : (
                    <Badge tone="ok">{ago(h.updatedAt)}</Badge>
                  )}
                </td>
                <td className="num">{fmtUsd(h.value)}</td>
                <td>
                  <div className="wcell">
                    <WeightBar weightBps={h.weightBps} capBps={h.capBps} />
                    <span className="num small">
                      {fmtBps(h.weightBps)} / {fmtBps(h.capBps, 0)}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
            <tr className="cash-row">
              <td>
                <b>tUSD</b> <span className="muted">cash</span>
              </td>
              <td />
              <td />
              <td />
              <td className="num">{fmtUsd(v.cash)}</td>
              <td>
                <div className="wcell">
                  <WeightBar weightBps={v.nav ? (v.cash / v.nav) * 10_000 : 0} capBps={0} cash />
                  <span className="num small">
                    {fmtBps(v.nav ? (v.cash / v.nav) * 10_000 : 0)} / floor {fmtBps(v.mandate.minCashBps, 0)}
                  </span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function MandateCard({ v }: { v: VaultData }) {
  const m = v.mandate;
  const used = v.turnover.limit ? Math.min(100, (v.turnover.used / v.turnover.limit) * 100) : 0;
  return (
    <Card title="Mandate (enforced onchain)">
      <ul className="rules">
        <li>
          <span>Assets and caps</span>
          <b>{v.holdings.map((h) => `${h.ticker} ${fmtBps(h.capBps, 0)}`).join(" · ")}</b>
        </li>
        <li>
          <span>Cash floor</span>
          <b>{fmtBps(m.minCashBps, 0)} of NAV</b>
        </li>
        <li>
          <span>Max turnover</span>
          <b>
            {fmtBps(m.maxTurnoverBps, 0)} of NAV per {duration(m.turnoverWindow)}
          </b>
        </li>
        <li>
          <span>Max slippage vs Chainlink</span>
          <b>{fmtBps(m.maxSlippageBps, 2)}</b>
        </li>
        <li>
          <span>Max oracle age</span>
          <b>{duration(m.maxOracleAge)}</b>
        </li>
        <li>
          <span>Cooldown</span>
          <b>{duration(m.cooldown)}</b>
        </li>
        <li>
          <span>Agent authority ends</span>
          <b>{new Date(m.expiry * 1000).toLocaleDateString()}</b>
        </li>
      </ul>
      <div className="turnover">
        <div className="small muted">
          Turnover this window: {fmtUsd(v.turnover.used, 0)} of {fmtUsd(v.turnover.limit, 0)} · resets {new Date(v.turnover.resetsAt * 1000).toLocaleString()}
        </div>
        <div className="wbar">
          <div className="wbar-fill" style={{ width: `${used}%` }} />
        </div>
      </div>
    </Card>
  );
}

function RebalanceItem({ tx, vault, noteUri }: { tx: `0x${string}`; vault: string; noteUri?: string }) {
  const { data: ev } = useAsync(() => loadRebalance(tx, vault), [tx]);
  const { data: note } = useAsync(
    async () => (ev ? loadNote(ev.rationaleURI || noteUri || "", ev.rationaleHash) : { note: null, verified: null }),
    [ev?.rationaleURI],
  );
  const [open, setOpen] = useState(false);
  if (!ev) return <div className="tl-item"><Spinner /></div>;
  const n = note?.note;
  return (
    <div className="tl-item">
      <div className="tl-head">
        <div>
          <b>Rebalance #{ev.epoch}</b> <span className="muted small">{new Date(ev.timestamp * 1000).toLocaleString()}</span>
        </div>
        <div className="tl-badges">
          {note?.verified === true && <Badge tone="ok" title="keccak256 of the published rationale equals the hash committed onchain">rationale verified</Badge>}
          {note?.verified === false && <Badge tone="bad">rationale hash mismatch</Badge>}
          {ev.attributed && <Badge tone="blue" title={`ERC-8021 suffix ${DEP.builderCode}`}>Builder Code</Badge>}
          <TxLink hash={ev.tx} />
        </div>
      </div>
      <div className="trades">
        {ev.trades.map((t, i) => (
          <span key={i} className={`trade ${t.buy ? "buy" : "sell"}`}>
            {t.buy ? "Buy" : "Sell"} {t.ticker} {fmtUsd(t.notional, 0)}
          </span>
        ))}
      </div>
      {n && (
        <>
          <p className="summary">“{n.decision.summary}”</p>
          <div className="muted small">
            Decided by <code>{n.decision.source}</code> · NAV {fmtUsd(ev.navBefore, 0)} → {fmtUsd(ev.navAfter, 0)}
          </div>
          {n.leashCorrections.length > 0 && (
            <div className="corrections">
              <div className="small"><b>Where the leash pulled</b></div>
              <ul>
                {n.leashCorrections.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <button className="link" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"} the agent's reasoning
          </button>
          {open && (
            <div className="reasoning">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Stock</th>
                      <th className="num">Before</th>
                      <th className="num">Rules baseline</th>
                      <th className="num">Agent proposed</th>
                      <th className="num">After leash</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys({ ...n.decision.current, ...n.decision.final }).map((t) => (
                      <tr key={t}>
                        <td>{t}</td>
                        <td className="num">{n.decision.current[t] ?? "–"}</td>
                        <td className="num">{n.decision.baseline[t] ?? "–"}</td>
                        <td className="num">{n.decision.proposed[t] ?? "–"}</td>
                        <td className="num">{n.decision.final[t] ?? "–"}</td>
                        <td className="small">{n.decision.perAsset[t] ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {n.decision.risks.length > 0 && <p className="small">Risks flagged: {n.decision.risks.join(" · ")}</p>}
              <a className="small" href={ev.rationaleURI} target="_blank" rel="noreferrer">
                Full rationale document (JSON)
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Activity({ v }: { v: VaultData }) {
  const { data: index } = useAsync(loadIndex, [v.address], 120_000);
  const entry = index?.vaults[v.address.toLowerCase()];
  return (
    <Card title="Agent activity" extra={<span className="muted small">{v.epoch} rebalance{v.epoch === 1 ? "" : "s"} onchain</span>}>
      {!index && <Spinner />}
      {index && !entry?.rebalances.length && <Empty>No rebalances yet. The agent runs every two hours around US market hours.</Empty>}
      <div className="timeline">
        {entry?.rebalances.slice(0, 12).map((r) => (
          <RebalanceItem key={r.tx} tx={r.tx} vault={v.address} noteUri={r.note} />
        ))}
      </div>
    </Card>
  );
}

function NavCard({ v }: { v: VaultData }) {
  const { data: index } = useAsync(loadIndex, [v.address], 300_000);
  const pts = (index?.vaults[v.address.toLowerCase()]?.nav ?? []).map(([t, x]) => [Date.parse(t), x] as [number, number]);
  pts.push([Date.now(), v.nav]);
  return (
    <Card title="NAV" extra={<span className="muted small">sampled every agent run</span>}>
      <LineChart points={pts} />
    </Card>
  );
}

function OwnerPanel({ v, reload }: { v: VaultData; reload: () => void }) {
  const { address, wallet, connect } = useWallet();
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [amount, setAmount] = useState("1000");
  const isOwner = address?.toLowerCase() === v.owner.toLowerCase();
  const send = async (label: string, fn: (w: NonNullable<typeof wallet>, me: `0x${string}`) => Promise<`0x${string}`>) => {
    setBusy(label);
    setMsg("");
    try {
      const c = wallet && address ? { wallet, address } : await connect();
      if (!c) throw new Error("Connect a wallet first.");
      const hash = await fn(c.wallet, c.address);
      await testnet.waitForTransactionReceipt({ hash });
      setMsg(`${label}: confirmed.`);
      reload();
    } catch (e) {
      const d = decode(e);
      setMsg(`${label} failed: ${d.name}`);
    } finally {
      setBusy("");
    }
  };
  const write = (w: any, me: `0x${string}`, functionName: string, args: unknown[], to: `0x${string}` = v.address, abi = ABI.vault) =>
    w.writeContract({ address: to, abi, functionName, args, account: me, chain: CHAIN });
  return (
    <Card title={isOwner ? "Owner controls" : "Deposit"}>
      <div className="row gap">
        <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        <button
          className="btn small"
          disabled={!!busy}
          onClick={() =>
            send("Deposit", async (w, me) => {
              const amt = parseUnits(amount || "0", 6);
              const h1 = await write(w, me, "approve", [v.address, amt], DEP.usd, ABI.b20);
              await testnet.waitForTransactionReceipt({ hash: h1 });
              return write(w, me, "deposit", [amt]);
            })
          }
        >
          Deposit tUSD
        </button>
      </div>
      {isOwner && (
        <div className="row gap wrap" style={{ marginTop: 12 }}>
          <button className="btn small ghost" disabled={!!busy} onClick={() => send(v.paused ? "Resume agent" : "Pause agent", (w, me) => write(w, me, "setPaused", [!v.paused]))}>
            {v.paused ? "Resume agent" : "Pause agent"}
          </button>
          <button className="btn small danger" disabled={!!busy} onClick={() => send("Withdraw everything", (w, me) => write(w, me, "withdrawAll", [me]))}>
            Withdraw everything
          </button>
        </div>
      )}
      {!isOwner && <p className="muted small">Owner controls (pause, rules, withdraw) appear when the owner's wallet is connected.</p>}
      {busy && <p className="small"><Spinner /> {busy}…</p>}
      {msg && <p className="small">{msg}</p>}
    </Card>
  );
}

export function VaultPage({ address }: { address: `0x${string}` }) {
  const { data: v, error, reload } = useAsync(() => loadVault(address), [address], 60_000);
  const demo = DEP.demoVaults.find((d) => d.vault.toLowerCase() === address.toLowerCase());
  if (error) return <div className="page"><div className="err">Could not load vault: {error}</div></div>;
  if (!v) return <div className="page"><Spinner /></div>;
  const leashAgent = v.agent.toLowerCase() === DEP.agent.toLowerCase();
  return (
    <div className="page">
      <div className="vault-head">
        <div>
          <a className="muted small" href="#/">
            ← All vaults
          </a>
          <h1>{demo?.name ?? "Leash vault"}</h1>
          <div className="muted small">
            Vault <AddrLink address={v.address} /> · owner <AddrLink address={v.owner} /> · agent{" "}
            <AddrLink address={v.agent} label={leashAgent ? "Leash research agent" : short(v.agent)} />
          </div>
        </div>
        <div>{v.paused ? <Badge tone="warn">agent paused by owner</Badge> : Date.now() / 1000 > v.mandate.expiry ? <Badge tone="bad">mandate expired</Badge> : <Badge tone="ok">agent active</Badge>}</div>
      </div>
      <div className="stats">
        <Stat label="NAV" value={fmtUsd(v.nav)} />
        <Stat label="Cash" value={fmtUsd(v.cash, 0)} hint={`${fmtBps(v.nav ? (v.cash / v.nav) * 10_000 : 0)} of NAV`} />
        <Stat label="Rebalances" value={v.epoch} hint={v.lastRebalance ? `last ${ago(v.lastRebalance)}` : "none yet"} />
        <Stat label="Turnover left" value={fmtUsd(Math.max(0, v.turnover.limit - v.turnover.used), 0)} hint={`this ${duration(v.mandate.turnoverWindow)} window`} />
      </div>
      <div className="grid2">
        <div className="col">
          <NavCard v={v} />
          <Holdings v={v} />
          <Activity v={v} />
        </div>
        <div className="col">
          <MandateCard v={v} />
          <LeashTester v={v} />
          <OwnerPanel v={v} reload={reload} />
        </div>
      </div>
    </div>
  );
}

export type { RebalanceEvent };
