import { useMemo, useState } from "react";
import { decodeEventLog, formatEther, parseSignature, parseUnits } from "viem";
import { useWallet } from "../App";
import { ABI, testnet } from "../clients";
import { CHAIN, DEP, STOCK_NAMES, VIBENET_ID, onChain } from "../config";
import { Card, Spinner } from "../ui";
import { fmtUsd, short, useAsync } from "../util";
import { PROFILES } from "../../../agent/src/profiles";

const FAUCETS: Record<number, Array<[string, string]>> = {
  84532: [
    ["Coinbase Developer Platform faucet", "https://portal.cdp.coinbase.com/products/faucet"],
    ["Superchain faucet", "https://console.optimism.io/faucet"],
    ["thirdweb faucet", "https://thirdweb.com/base-sepolia-testnet"],
  ],
  84538453: [["Vibenet faucet", "https://chain.base.org/vibenet/faucet"]],
};

interface Form {
  caps: Record<string, number>; // percent, 0 = excluded
  minCash: number;
  maxTurnover: number;
  windowHours: number;
  slippage: number;
  oracleHours: number;
  cooldownHours: number;
  days: number;
  agent: string;
  deposit: string;
}

function fromProfile(id: string): Form {
  const p = PROFILES.find((x) => x.id === id)!;
  const caps: Record<string, number> = Object.fromEntries(DEP.stocks.map((s) => [s.ticker, 0]));
  p.tickers.forEach((t, i) => (caps[t] = p.caps[i] / 100));
  return {
    caps,
    minCash: p.mandate.minCashBps / 100,
    maxTurnover: p.mandate.maxTurnoverBps / 100,
    windowHours: p.mandate.turnoverWindow / 3600,
    slippage: p.mandate.maxSlippageBps / 100,
    oracleHours: p.mandate.maxOracleAge / 3600,
    cooldownHours: p.mandate.cooldown / 3600,
    days: 90,
    agent: DEP.agent,
    deposit: "5000",
  };
}

export function CreatePage() {
  const { address, wallet, connect } = useWallet();
  const [profile, setProfile] = useState("balanced");
  const [f, setF] = useState<Form>(() => fromProfile("balanced"));
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string>();

  const bal = useAsync(
    async () => {
      if (!address) return null;
      const [eth, usd, last, cooldown] = await Promise.all([
        testnet.getBalance({ address }),
        testnet.readContract({ address: DEP.usd, abi: ABI.b20, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
        testnet.readContract({ address: DEP.faucet, abi: ABI.faucet, functionName: "lastClaim", args: [address] }) as Promise<bigint>,
        testnet.readContract({ address: DEP.faucet, abi: ABI.faucet, functionName: "cooldown" }) as Promise<bigint>,
      ]);
      return { eth, usd, nextClaim: last === 0n ? 0 : Number(last + cooldown) };
    },
    [address, status],
    30_000,
  );

  const chosen = useMemo(() => Object.entries(f.caps).filter(([, c]) => c > 0), [f.caps]);
  const problems: string[] = [];
  if (!chosen.length) problems.push("Choose at least one stock.");
  if (chosen.some(([, c]) => c > 100)) problems.push("A cap cannot exceed 100%.");
  if (f.minCash < 0 || f.minCash > 100) problems.push("Cash floor must be between 0% and 100%.");
  if (f.slippage > 10) problems.push("Slippage limit can be at most 10%.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(f.agent)) problems.push("Agent must be an address.");
  const depositUnits = (() => {
    try {
      return parseUnits(f.deposit || "0", 6);
    } catch {
      return 0n;
    }
  })();
  if (bal.data && depositUnits > bal.data.usd) problems.push("Deposit is larger than your tUSD balance.");

  const set = (k: keyof Form, v: number | string) => setF((x) => ({ ...x, [k]: v }));

  const dripGas = async () => {
    if (!address) return;
    setBusy(true);
    setStatus("Requesting test ETH from the Vibenet faucet…");
    try {
      const r = await fetch("https://api.vibes.base.org/api/vibenet/faucet/drip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error ?? body?.message ?? `HTTP ${r.status}`);
      if (body.tx_hash) await testnet.waitForTransactionReceipt({ hash: body.tx_hash });
      setStatus("0.1 test ETH received for gas.");
    } catch (e: any) {
      setStatus(`Faucet: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const claim = async () => {
    setBusy(true);
    setStatus("Claiming test USD…");
    try {
      const c = wallet && address ? { wallet, address } : await connect();
      if (!c) throw new Error("Connect a wallet first.");
      const hash = await c.wallet.writeContract({ address: DEP.faucet, abi: ABI.faucet, functionName: "claim", account: c.address, chain: CHAIN } as any);
      await testnet.waitForTransactionReceipt({ hash });
      setStatus("10,000 tUSD received.");
    } catch (e: any) {
      setStatus(`Faucet: ${e?.shortMessage ?? e?.message}`);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setStatus("Preparing…");
    try {
      const c = wallet && address ? { wallet, address } : await connect();
      if (!c) throw new Error("Connect a wallet first.");
      const tokens = chosen.map(([t]) => DEP.stocks.find((s) => s.ticker === t)!.token);
      const caps = chosen.map(([, cap]) => Math.round(cap * 100));
      const mandate = {
        minCashBps: Math.round(f.minCash * 100),
        maxTurnoverBps: Math.round(f.maxTurnover * 100),
        turnoverWindow: Math.round(f.windowHours * 3600),
        maxSlippageBps: Math.round(f.slippage * 100),
        maxOracleAge: Math.round(f.oracleHours * 3600),
        cooldown: Math.round(f.cooldownHours * 3600),
        expiry: BigInt(Math.floor(Date.now() / 1000) + Math.round(f.days * 86400)),
      };
      let hash: `0x${string}`;
      try {
        setStatus("Sign the permit for your deposit (no gas)…");
        const [domain, nonce] = await Promise.all([
          testnet.readContract({ address: DEP.usd, abi: ABI.b20, functionName: "eip712Domain" }) as Promise<any[]>,
          testnet.readContract({ address: DEP.usd, abi: ABI.b20, functionName: "nonces", args: [c.address] }) as Promise<bigint>,
        ]);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const sig = await c.wallet.signTypedData({
          account: c.address,
          domain: { name: domain[1], version: domain[2], chainId: Number(domain[3]), verifyingContract: domain[4] },
          types: { Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ] },
          primaryType: "Permit",
          message: { owner: c.address, spender: DEP.factory, value: depositUnits, nonce, deadline },
        });
        const { v, r, s, yParity } = parseSignature(sig);
        setStatus("Confirm the vault creation…");
        hash = await c.wallet.writeContract({
          address: DEP.factory,
          abi: ABI.factory,
          functionName: "createVaultWithPermit",
          args: [f.agent, tokens, caps, mandate, depositUnits, deadline, Number(v ?? BigInt(27 + (yParity ?? 0))), r, s],
          account: c.address,
          chain: CHAIN,
        } as any);
      } catch (e: any) {
        if (String(e?.message ?? "").toLowerCase().includes("reject")) throw e;
        setStatus("Permit not supported by this wallet; approving instead…");
        const h1 = await c.wallet.writeContract({ address: DEP.usd, abi: ABI.b20, functionName: "approve", args: [DEP.factory, depositUnits], account: c.address, chain: CHAIN } as any);
        await testnet.waitForTransactionReceipt({ hash: h1 });
        hash = await c.wallet.writeContract({ address: DEP.factory, abi: ABI.factory, functionName: "createVault", args: [f.agent, tokens, caps, mandate, depositUnits], account: c.address, chain: CHAIN } as any);
      }
      setStatus("Waiting for confirmation…");
      const receipt = await testnet.waitForTransactionReceipt({ hash });
      for (const log of receipt.logs) {
        try {
          const d = decodeEventLog({ abi: ABI.factory, data: log.data, topics: log.topics }) as any;
          if (d.eventName === "VaultCreated") {
            setCreated(d.args.vault);
            setStatus("");
            return;
          }
        } catch {}
      }
      setStatus("Created, but the vault address was not found in the receipt.");
    } catch (e: any) {
      setStatus(`Failed: ${e?.shortMessage ?? e?.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="page narrow">
        <Card title="Your vault is live">
          <p>
            Vault <code>{created}</code> was created with your mandate. The Leash agent picks it up on its next run (every two
            hours around US market hours) and will only trade inside the rules you set.
          </p>
          <a className="btn" href={`#/vault/${created}`}>
            Open the vault
          </a>
        </Card>
      </div>
    );
  }

  return (
    <div className="page narrow">
      <h1>Create a vault</h1>
      <p className="lead">Set the rules, deposit test USD and appoint the agent. Everything here is on {CHAIN.name}.</p>

      <Card title="1. Wallet and test funds">
        {!address ? (
          <button className="btn" onClick={connect}>
            Connect wallet
          </button>
        ) : (
          <div className="col gap">
            <div className="small">
              Connected <code>{short(address)}</code> · {bal.data ? `${Number(formatEther(bal.data.eth)).toFixed(5)} ETH · ${fmtUsd(Number(bal.data.usd) / 1e6, 0)} tUSD` : <Spinner />}
            </div>
            {bal.data && bal.data.eth === 0n && CHAIN.id !== VIBENET_ID && (
              <div className="note">
                You need a little {CHAIN.name} ETH for gas:{" "}
                {(FAUCETS[CHAIN.id] ?? []).map(([n, u], i) => (
                  <span key={u}>
                    {i ? " · " : ""}
                    <a href={u} target="_blank" rel="noreferrer">
                      {n}
                    </a>
                  </span>
                ))}
                . No captcha wanted? <a href={onChain(VIBENET_ID, "#/create")}>Create your vault on Base Vibenet</a>, where test gas
                is one click.
              </div>
            )}
            <div className="row gap wrap">
              {CHAIN.id === VIBENET_ID && (
                <button className="btn small ghost" onClick={dripGas} disabled={busy}>
                  Get test ETH (gas)
                </button>
              )}
              <button className="btn small ghost" onClick={claim} disabled={busy || (!!bal.data?.nextClaim && bal.data.nextClaim > Date.now() / 1000)}>
                Get 10,000 tUSD
              </button>
              {bal.data?.nextClaim ? (
                bal.data.nextClaim > Date.now() / 1000 && <span className="muted small">next claim {new Date(bal.data.nextClaim * 1000).toLocaleString()}</span>
              ) : null}
            </div>
            {status && !created && <p className="small">{status}</p>}
          </div>
        )}
      </Card>

      <Card title="2. Mandate">
        <div className="presets">
          {PROFILES.map((p) => (
            <button
              key={p.id}
              className={`preset ${profile === p.id ? "on" : ""}`}
              onClick={() => {
                setProfile(p.id);
                setF((x) => ({ ...fromProfile(p.id), deposit: x.deposit, agent: x.agent }));
              }}
            >
              <b>{p.name}</b>
              <span className="small muted">{p.style}</span>
            </button>
          ))}
        </div>
        <div className="caps">
          {DEP.stocks.map((s) => (
            <label key={s.ticker} className={`cap ${f.caps[s.ticker] > 0 ? "on" : ""}`}>
              <span>
                <b>{s.ticker}c</b> <span className="muted small">{STOCK_NAMES[s.ticker]}</span>
              </span>
              <span className="row gap-s">
                <input
                  className="input tiny"
                  type="number"
                  min={0}
                  max={100}
                  value={f.caps[s.ticker]}
                  onChange={(e) => setF((x) => ({ ...x, caps: { ...x.caps, [s.ticker]: Number(e.target.value) } }))}
                />
                <span className="small muted">% cap</span>
              </span>
            </label>
          ))}
        </div>
        <div className="form-grid">
          <label>
            Cash floor (% of NAV)
            <input className="input" type="number" value={f.minCash} onChange={(e) => set("minCash", Number(e.target.value))} />
          </label>
          <label>
            Max turnover (% of NAV)
            <input className="input" type="number" value={f.maxTurnover} onChange={(e) => set("maxTurnover", Number(e.target.value))} />
          </label>
          <label>
            per window (hours)
            <input className="input" type="number" value={f.windowHours} onChange={(e) => set("windowHours", Number(e.target.value))} />
          </label>
          <label>
            Max slippage vs Chainlink (%)
            <input className="input" type="number" step="0.05" value={f.slippage} onChange={(e) => set("slippage", Number(e.target.value))} />
          </label>
          <label>
            Max oracle age (hours)
            <input className="input" type="number" value={f.oracleHours} onChange={(e) => set("oracleHours", Number(e.target.value))} />
          </label>
          <label>
            Cooldown between rebalances (hours)
            <input className="input" type="number" value={f.cooldownHours} onChange={(e) => set("cooldownHours", Number(e.target.value))} />
          </label>
          <label>
            Agent authority (days)
            <input className="input" type="number" value={f.days} onChange={(e) => set("days", Number(e.target.value))} />
          </label>
        </div>
      </Card>

      <Card title="3. Agent and deposit">
        <div className="form-grid">
          <label className="span2">
            Agent address
            <input className="input mono" value={f.agent} onChange={(e) => set("agent", e.target.value.trim())} />
            <span className="muted small">
              {f.agent.toLowerCase() === DEP.agent.toLowerCase() ? "The Leash research agent (runs on GitHub Actions)." : "A custom agent. It gets exactly the same leash."}
            </span>
          </label>
          <label>
            Deposit (tUSD)
            <input className="input" value={f.deposit} onChange={(e) => set("deposit", e.target.value)} inputMode="decimal" />
          </label>
        </div>
        {problems.length > 0 && (
          <ul className="problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <button className="btn" disabled={busy || problems.length > 0 || !address || depositUnits === 0n} onClick={create}>
          {busy ? <Spinner /> : "Create vault"}
        </button>
        {status && <p className="small">{status}</p>}
        <p className="muted small">One signature (EIP-2612 permit on the B20 test USD) and one transaction. Not available to US persons.</p>
      </Card>
    </div>
  );
}
