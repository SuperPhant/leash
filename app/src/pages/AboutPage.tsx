import { CHAIN, DEP, REPO, STOCK_NAMES } from "../config";
import { AddrLink, Card } from "../ui";

export function AboutPage() {
  return (
    <div className="page narrow">
      <h1>How Leash works</h1>
      <p className="lead">
        AI agents are getting good at research, and tokenized stocks make equities programmable on Base. Leash lets you
        hand an agent a portfolio without handing it a blank cheque: the rules live in the vault contract, and the
        contract checks every trade.
      </p>

      <Card title="The mandate">
        <p>When you create a vault you write these rules into it. Only you can change them.</p>
        <ul className="bullets">
          <li><b>Assets and caps.</b> The agent can only buy stocks on your list, and never above each stock's cap. A cap of 0% means "sell only".</li>
          <li><b>Cash floor.</b> After any purchase, at least this share of the vault stays in cash.</li>
          <li><b>Turnover limit.</b> The agent can trade at most this share of NAV per window, so a bad or compromised agent cannot churn or dump the book in one go.</li>
          <li><b>Slippage limit.</b> Every fill is compared with the Chainlink price; worse execution reverts.</li>
          <li><b>Oracle age.</b> If a price feed is older than you allow (market closed, corporate action), the agent cannot trade that stock.</li>
          <li><b>Cooldown and expiry.</b> A minimum time between rebalances, and a date when the agent's authority ends.</li>
          <li><b>Owner powers.</b> Pause the agent, change rules, replace the agent and withdraw everything, at any time. The agent has no function that moves funds out of the vault.</li>
        </ul>
      </Card>

      <Card title="Transparency by construction">
        <ul className="bullets">
          <li>Every rebalance emits the keccak256 hash of a rationale document the agent publishes. The app re-hashes the published file and shows <b>rationale verified</b> only if it matches.</li>
          <li>The rationale shows the rules baseline, what the model proposed, where the leash cut it back, and the final trades.</li>
          <li>Every agent transaction carries the Base Builder Code <code>{DEP.builderCode}</code> (ERC-8021), so its activity is attributable onchain.</li>
        </ul>
      </Card>

      <Card title="Why prices come from Base mainnet">
        <p>
          Coinbase tokenized stocks live on Base mainnet, priced by Chainlink feeds that report total-return values (the
          underlying price times the B20 multiplier). Leash's testnet mirrors those feeds round for round, and mirrors each
          token's multiplier, so the demo behaves like mainnet: the same prices, the same market-hours freezes, the same
          corporate actions.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Stock</th>
                <th>Testnet B20 mirror</th>
                <th>Mainnet Coinbase token</th>
                <th>Mainnet Chainlink feed</th>
              </tr>
            </thead>
            <tbody>
              {DEP.stocks.map((s) => (
                <tr key={s.ticker}>
                  <td>
                    {s.ticker}c <span className="muted small">{STOCK_NAMES[s.ticker]}</span>
                  </td>
                  <td>
                    <AddrLink address={s.token} />
                  </td>
                  <td>
                    <AddrLink address={s.mainnetToken} mainnet />
                  </td>
                  <td>
                    <AddrLink address={s.mainnetFeed} mainnet />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={`Contracts on ${CHAIN.name}`}>
        <ul className="rules">
          <li><span>LeashFactory</span><b><AddrLink address={DEP.factory} /></b></li>
          <li><span>LeashDesk (testnet venue)</span><b><AddrLink address={DEP.desk} /></b></li>
          <li><span>MirrorFeedHub</span><b><AddrLink address={DEP.hub} /></b></li>
          <li><span>tUSD (B20 stablecoin)</span><b><AddrLink address={DEP.usd} /></b></li>
          <li><span>tUSD faucet</span><b><AddrLink address={DEP.faucet} /></b></li>
          <li><span>B20 factory precompile</span><b><code>0xB20f…0000</code></b></li>
        </ul>
        <p className="small muted">
          Source, tests and deployment scripts: <a href={REPO}>{REPO.replace("https://", "")}</a>
        </p>
      </Card>

      <Card title="From testnet to mainnet">
        <ul className="bullets">
          <li>The vault and its checks do not change. Only the venue does: instead of the testnet desk, trades would route to DEX or RFQ liquidity for the real Coinbase B20 tokens, with the same oracle-based slippage check.</li>
          <li>Chainlink feeds, multipliers and Builder Codes are used exactly as on mainnet.</li>
          <li>Coinbase tokenized stocks are only available to persons in eligible jurisdictions outside the United States. A mainnet Leash would enforce that, for example with Base Verify, and is not offered to US persons.</li>
        </ul>
      </Card>

      <Card title="Disclaimer">
        <p className="small">
          Leash is a testnet demonstration. The test tokens have no value, are not securities and are not issued by Coinbase.
          Nothing here is investment advice. The agent's research uses an LLM and can be wrong; the mandate exists so that its
          mistakes stay small.
        </p>
      </Card>
    </div>
  );
}
