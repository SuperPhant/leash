import { DEP, REPO } from "../config";
import { loadStatus, type AgentRun } from "../data";
import { AddrLink, Badge, Card, Empty, Spinner, TxLink } from "../ui";
import { fmtPct, short, useAsync } from "../util";

const tone = (s: string) =>
  s === "rebalanced" ? "ok" : s === "error" || s === "failed" || s === "blocked" ? "bad" : s === "waiting" || s === "paused" ? "warn" : "neutral";

function RunVaults({ run }: { run: AgentRun }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Vault</th>
            <th>Outcome</th>
            <th>Detail</th>
            <th>Tx</th>
          </tr>
        </thead>
        <tbody>
          {run.vaults.map((v) => (
            <tr key={v.vault}>
              <td>
                <a href={`#/vault/${v.vault}`}>{v.name || short(v.vault)}</a>
              </td>
              <td>
                <Badge tone={tone(v.status) as any}>{v.status}</Badge>
              </td>
              <td className="small">{(v.detail ?? "").replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, (iso) => new Date(iso).toLocaleString())}</td>
              <td>{v.tx ? <TxLink hash={v.tx} /> : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentPage() {
  const { data, loading } = useAsync(loadStatus, [], 60_000);
  const latest = data?.latest;
  const sigs = latest?.research?.signals ?? [];
  return (
    <div className="page">
      <h1>The Leash research agent</h1>
      <p className="lead">
        An autonomous agent that manages every vault delegated to it, inside each vault's mandate. It runs on{" "}
        <a href={`${REPO}/actions/workflows/agent.yml`}>GitHub Actions</a> every two hours around US market hours and
        publishes everything it does.
      </p>
      <div className="grid2">
        <Card title="Identity">
          <ul className="rules">
            <li>
              <span>Agent wallet</span>
              <b>
                <AddrLink address={DEP.agent} />
              </b>
            </li>
            <li>
              <span>Builder Code (ERC-8021)</span>
              <b>
                <code>{DEP.builderCode}</code> on every transaction
              </b>
            </li>
            <li>
              <span>Model</span>
              <b>open-weight gpt-oss-20b via Pollinations (free), rules fallback</b>
            </li>
            <li>
              <span>Data</span>
              <b>Base mainnet Chainlink feeds, B20 multipliers, Coinbase API</b>
            </li>
            <li>
              <span>Code</span>
              <b>
                <a href={`${REPO}/tree/main/agent`}>agent/</a>
              </b>
            </li>
          </ul>
        </Card>
        <Card title="Each cycle">
          <ol className="pipeline">
            <li><b>Relay</b> new mainnet Chainlink rounds and B20 multipliers to the testnet mirror.</li>
            <li><b>Research</b> daily closes, 1/5/20-day total returns, volatility, drawdown, onchain supply flows.</li>
            <li><b>Propose</b> a rules baseline, then ask the LLM to review it and explain.</li>
            <li><b>Leash</b> clip to caps and cash floor; fit the turnover budget; record every correction.</li>
            <li><b>Simulate</b> the rebalance, then send it with the Builder Code.</li>
            <li><b>Publish</b> the rationale; its hash is committed onchain in the same transaction.</li>
          </ol>
        </Card>
      </div>

      <Card title="Latest run" extra={latest && <span className="muted small">{new Date(latest.at).toLocaleString()}</span>}>
        {loading && !data && <Spinner />}
        {!loading && !latest && <Empty>No runs published yet.</Empty>}
        {latest && (
          <>
            <p className="small">
              Price relay:{" "}
              {"relayed" in (latest.relay ?? {}) ? (
                <>
                  {latest.relay.relayed.length} feeds updated
                  {latest.relay.tx && (
                    <>
                      {" "}
                      (<TxLink hash={latest.relay.tx} />)
                    </>
                  )}
                  {latest.relay.multipliers?.length ? `, ${latest.relay.multipliers.length} multipliers mirrored` : ""}
                </>
              ) : (
                <span className="muted">{latest.relay?.error ?? "n/a"}</span>
              )}
            </p>
            <RunVaults run={latest} />
          </>
        )}
      </Card>

      <Card title="What the agent sees" extra={latest?.research && <span className="muted small">as of {new Date(latest.research.asOf).toLocaleString()}</span>}>
        {!sigs.length ? (
          <Empty>Signals appear after the first run.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Stock</th>
                  <th className="num">Price</th>
                  <th className="num">1d</th>
                  <th className="num">5d</th>
                  <th className="num">20d</th>
                  <th className="num">Vol 20d</th>
                  <th className="num">Max DD 20d</th>
                  <th className="num">Supply 7d</th>
                  <th className="num">Multiplier</th>
                  <th>Oracle</th>
                </tr>
              </thead>
              <tbody>
                {sigs.map((s) => (
                  <tr key={s.ticker}>
                    <td>
                      <b>{s.ticker}c</b>
                    </td>
                    <td className="num">{s.price.toFixed(2)}</td>
                    <td className={`num ${(s.ret1d ?? 0) >= 0 ? "pos" : "neg"}`}>{fmtPct(s.ret1d)}</td>
                    <td className={`num ${(s.ret5d ?? 0) >= 0 ? "pos" : "neg"}`}>{fmtPct(s.ret5d)}</td>
                    <td className={`num ${(s.ret20d ?? 0) >= 0 ? "pos" : "neg"}`}>{fmtPct(s.ret20d)}</td>
                    <td className="num">{fmtPct(s.vol20d, 0)}</td>
                    <td className="num">{fmtPct(s.maxDrawdown20d)}</td>
                    <td className="num">{fmtPct(s.supplyChange7d)}</td>
                    <td className="num">{s.multiplier === null || s.multiplier === undefined ? "–" : Number(s.multiplier).toFixed(4)}</td>
                    <td>{s.stale ? <Badge tone="warn">stale {s.ageHours.toFixed(0)}h</Badge> : <Badge tone="ok">{s.ageHours.toFixed(1)}h</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Run history">
        {!data?.history?.length ? (
          <Empty>No history yet.</Empty>
        ) : (
          <div className="history">
            {data.history.slice(0, 30).map((r) => (
              <div key={r.at} className="hist-row">
                <span className="mono small">{new Date(r.at).toLocaleString()}</span>
                <span className="hist-badges">
                  {r.vaults.map((v) => (
                    <Badge key={v.vault} tone={tone(v.status) as any} title={`${v.name}: ${v.detail ?? ""}`}>
                      {v.name ? v.name.split(" ")[0] : short(v.vault)}: {v.status}
                    </Badge>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
