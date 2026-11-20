import { DEP, STOCK_NAMES } from "../config";
import { loadMarket, loadStatus, loadVault, loadVaultList, type VaultData } from "../data";
import { Badge, Card, Spinner, WeightBar } from "../ui";
import { ago, fmtPct, fmtUsd, short, useAsync } from "../util";

function VaultCard({ address, name }: { address: `0x${string}`; name: string }) {
  const { data: v, error } = useAsync(() => loadVault(address), [address], 60_000);
  const top = v ? [...v.holdings].sort((a, b) => b.weightBps - a.weightBps).slice(0, 4) : [];
  return (
    <a className="vault-card" href={`#/vault/${address}`}>
      <div className="vc-head">
        <div>
          <div className="vc-name">{name}</div>
          <div className="muted mono small">{short(address)}</div>
        </div>
        {v && (v.paused ? <Badge tone="warn">paused</Badge> : <Badge tone="ok">agent active</Badge>)}
      </div>
      {error && <div className="err small">{error}</div>}
      {!v && !error && <Spinner />}
      {v && <VaultSummary v={v} />}
      {v && (
        <div className="vc-holdings">
          {top.map((h) => (
            <div key={h.token} className="vc-row">
              <span className="tick">{h.ticker}</span>
              <WeightBar weightBps={h.weightBps} capBps={h.capBps} />
              <span className="num small">{(h.weightBps / 100).toFixed(1)}%</span>
            </div>
          ))}
          {!top.some((h) => h.weightBps > 0) && <div className="muted small">All cash. Waiting for the agent's first rebalance.</div>}
        </div>
      )}
    </a>
  );
}

function VaultSummary({ v }: { v: VaultData }) {
  return (
    <div className="vc-stats">
      <div>
        <div className="stat-label">NAV</div>
        <div className="stat-value">{fmtUsd(v.nav, 0)}</div>
      </div>
      <div>
        <div className="stat-label">Rebalances</div>
        <div className="stat-value">{v.epoch}</div>
      </div>
      <div>
        <div className="stat-label">Cash floor</div>
        <div className="stat-value">{(v.mandate.minCashBps / 100).toFixed(0)}%</div>
      </div>
    </div>
  );
}

function Market() {
  const { data: rows, error } = useAsync(loadMarket, [], 60_000);
  const { data: status } = useAsync(loadStatus, [], 120_000);
  const sig = new Map((status?.latest.research?.signals ?? []).map((s) => [s.ticker, s]));
  return (
    <Card
      title="Live market: Coinbase tokenized stocks on Base mainnet"
      extra={<span className="muted small">Chainlink total-return feeds, read directly from Base mainnet</span>}
    >
      {error && <div className="err">{error}</div>}
      {!rows && !error && <Spinner />}
      {rows && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Stock</th>
                <th className="num">Price</th>
                <th className="num">5d</th>
                <th className="num">20d</th>
                <th className="num">Vol (20d)</th>
                <th>Oracle</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = sig.get(r.ticker);
                const age = Date.now() / 1000 - r.updatedAt;
                return (
                  <tr key={r.ticker}>
                    <td>
                      <b>{r.ticker}c</b> <span className="muted">{STOCK_NAMES[r.ticker]}</span>
                    </td>
                    <td className="num">{fmtUsd(r.price)}</td>
                    <td className={`num ${(s?.ret5d ?? 0) >= 0 ? "pos" : "neg"}`}>{fmtPct(s?.ret5d)}</td>
                    <td className={`num ${(s?.ret20d ?? 0) >= 0 ? "pos" : "neg"}`}>{fmtPct(s?.ret20d)}</td>
                    <td className="num">{fmtPct(s?.vol20d, 0)}</td>
                    <td>
                      {age > 26 * 3600 ? (
                        <Badge tone="warn" title="Feed frozen: market closed or corporate action. Leash will not trade it.">
                          frozen {ago(r.updatedAt)}
                        </Badge>
                      ) : (
                        <Badge tone="ok">{ago(r.updatedAt)}</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function Home() {
  const { data: list } = useAsync(loadVaultList, [], 120_000);
  const demo = new Map(DEP.demoVaults.map((d) => [d.vault.toLowerCase(), d.name]));
  const others = (list ?? []).filter((a) => !demo.has(a.toLowerCase()));
  return (
    <div className="page">
      <section className="hero">
        <div className="hero-text">
          <h1>
            Let an AI agent run your tokenized-stock portfolio.
            <br />
            <span className="blue">On a leash.</span>
          </h1>
          <p className="lead">
            Leash vaults hold Coinbase tokenized stocks on Base. You write the rules into the vault: which stocks, how
            much of each, how much may change per day, how fresh the Chainlink price must be. An AI agent researches and
            rebalances, but every trade is checked onchain against your mandate, and the agent can never move money out.
          </p>
          <div className="hero-cta">
            <a className="btn" href="#/create">
              Create a vault
            </a>
            <a className="btn ghost" href={DEP.demoVaults[0] ? `#/vault/${DEP.demoVaults[0].vault}` : "#/about"}>
              Watch a live vault
            </a>
          </div>
        </div>
        <div className="hero-art" aria-hidden>
          <svg viewBox="0 0 360 240">
            <defs>
              <linearGradient id="g" x1="0" x2="1">
                <stop offset="0" stopColor="#0052FF" />
                <stop offset="1" stopColor="#7AA2FF" />
              </linearGradient>
            </defs>
            <rect x="200" y="70" width="140" height="110" rx="16" fill="#EEF3FF" stroke="#0052FF" strokeWidth="2" />
            <text x="270" y="105" textAnchor="middle" className="art-t">
              Vault
            </text>
            <text x="270" y="128" textAnchor="middle" className="art-s">
              caps · cash floor
            </text>
            <text x="270" y="146" textAnchor="middle" className="art-s">
              turnover · oracle age
            </text>
            <circle cx="60" cy="125" r="34" fill="url(#g)" />
            <text x="60" y="131" textAnchor="middle" className="art-w">
              AI
            </text>
            <path d="M94 125 C 130 80, 160 170, 200 125" stroke="#0052FF" strokeWidth="3" strokeDasharray="6 6" fill="none" />
            <text x="148" y="98" textAnchor="middle" className="art-s">
              mandate
            </text>
          </svg>
        </div>
      </section>

      <section className="steps">
        <div className="step">
          <span className="step-n">1</span>
          <h4>You set the mandate</h4>
          <p>Pick stocks and per-stock caps, a cash floor, max daily turnover, slippage and oracle-freshness limits.</p>
        </div>
        <div className="step">
          <span className="step-n">2</span>
          <h4>The agent researches</h4>
          <p>It reads Chainlink total-return feeds and Coinbase issuer data, proposes weights and publishes its reasoning.</p>
        </div>
        <div className="step">
          <span className="step-n">3</span>
          <h4>The vault enforces</h4>
          <p>Every rebalance is checked onchain. Out-of-mandate trades revert. You can pause or exit at any time.</p>
        </div>
      </section>

      <h2 className="section-title">Live demo vaults, managed by the Leash agent</h2>
      <div className="grid3">
        {DEP.demoVaults.map((d) => (
          <VaultCard key={d.vault} address={d.vault} name={d.name} />
        ))}
      </div>

      {others.length > 0 && (
        <>
          <h2 className="section-title">Community vaults</h2>
          <div className="grid3">
            {others.slice(0, 9).map((a) => (
              <VaultCard key={a} address={a} name="Vault" />
            ))}
          </div>
        </>
      )}

      <Market />
    </div>
  );
}
