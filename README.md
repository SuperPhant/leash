# Leash

**Let an AI agent run your tokenized-stock portfolio on Base. On a leash.**

Leash is a vault for [Coinbase tokenized stocks on Base](https://docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks)
that an AI agent may rebalance, but only inside a mandate the owner writes into the contract: which stocks, how much of
each, how much may change per day, how fresh the Chainlink price must be and how far execution may slip from it. Every
rebalance is checked onchain and reverts if it breaks a rule. The agent can only swap through the vault's venue, so it can
never move money out, and the owner can pause it or withdraw everything at any time.

- **App:** https://superphant.github.io/leash/
- **Demo video (2 min):** [leash_demo.mp4](https://github.com/SuperPhant/leash/releases/download/demo-v1/leash_demo.mp4)
- **Agent runs and rationale documents:** [`notes` branch](https://github.com/SuperPhant/leash/tree/notes)
- **Contracts and addresses:** [`deployments/`](deployments)
- Built for the [Base Stocks Maxxing](https://www.base.org/stocksmaxxing) builder quest, Agentic Stock Finance track.

### Try it in two minutes

1. Open the app (it runs on Base Sepolia; the menu at the top switches to Base Vibenet) and press **Create vault**. Your
   wallet is asked to add the network.
2. Get test ETH for gas: on Base Vibenet press **Get test ETH (gas)** (one click, no captcha); on Base Sepolia use any
   Base Sepolia faucet. Then press **Get 10,000 tUSD**.
3. Pick a preset, adjust the caps, sign one permit and send one transaction.
4. The agent picks your vault up on its next run. Meanwhile, open any vault and press **Try it** under
   *Try to break the leash* to watch the contract reject out-of-mandate actions (simulated as the agent, no gas).

> Testnet demonstration. Test tokens mirror Coinbase tokenized stocks on Base mainnet; they have no value, are not
> securities and are not issued by Coinbase. Not investment advice. Coinbase tokenized stocks are not available to US
> persons, and Leash is not offered to US persons.

## Why

Agents are getting good at research, and tokenized stocks make equities programmable on Base. But today you either
trade yourself or hand an agent a key and hope. Leash turns "hope" into code:

| Rule (set by the owner, enforced by `LeashVault`) | What it stops |
| --- | --- |
| Asset list and per-stock cap | The agent piling into one name, or buying anything outside the list |
| Cash floor | Going all-in |
| Max turnover per window (e.g. 25% of NAV per 24h) | Churning, panic rotation, a compromised agent dumping the book |
| Max slippage versus the Chainlink price | Bad fills, sandwiching, a malicious venue |
| Max oracle age | Trading on a frozen feed (market closed, corporate action) |
| Cooldown and mandate expiry | Over-trading and indefinite delegation |
| Owner-only exits, pause and rule changes | The agent ever withdrawing funds |

The agent is still useful inside those limits: it researches, proposes weights, explains itself, and the vault proves
the result is within the mandate.

## What happens in practice

These are real outcomes from the live deployments:

- **The LLM asked for 45% AAPL and 45% AMZN; the leash clipped both to the 30% cap.** The rationale document records the
  model's proposal, the clipped weights and why.
- **First-day deployment is throttled by the turnover rule.** A fresh $100,000 vault with a 25%/day limit buys about
  $24,000 on day one and keeps building over the next days.
- **Frozen feeds block trading.** Sandisk's B20 token switched to a multiplier of 8.0 through a scheduled ERC-8056
  update effective 2026-11-20 05:00 UTC, and its Chainlink feed stopped updating from 20:47 UTC the evening before until
  the US open, which is how the Base docs describe a corporate action. Leash never trades through such a freeze: a trade
  in an asset whose oracle is older than the mandate allows reverts with `StaleOracle`, and the agent marks the asset as
  frozen and keeps its weight unchanged.

## How it works

The live demo runs on **Base Sepolia** (chain id 84532) and, with the same contracts and the same agent, on **Base
Vibenet** (chain id 84538453), Base's official preview testnet, whose faucet needs no captcha, so anyone can try the full
flow from the app. The deployment script (`agent/src/deploy.ts`) targets either; addresses are in
[`deployments/`](deployments).

```
 Base mainnet (read only)                       Leash agent (GitHub Actions, every 2h)          Base testnet
 ─────────────────────────                      ─────────────────────────────────────          ─────────────────────────────
 Chainlink tokenized-equity feeds ──┐          1. relay  mainnet rounds + B20 multipliers ──► MirrorFeedHub (AggregatorV3)
 (total-return values, 10 stocks)   │          2. research  daily closes, returns, vol,        B20 test stocks (multipliers)
 B20 tokens: uiMultiplier()  ───────┼────────►     drawdown, onchain supply flows
 Coinbase Tokenized Stocks API ─────┘          3. propose  rules baseline + LLM review
                                               4. leash   clip to caps / cash floor        ┌─► LeashVault.rebalance(trades,
                                               5. plan    fit turnover budget, min outs   │     keccak256(rationale), uri)
                                               6. simulate, send with ERC-8021 code  ─────┘     checks every mandate rule
                                               7. publish rationale JSON (notes branch)          LeashDesk (oracle-priced venue)
```

### Contracts (`contracts/src`)

- **`LeashVault`**: the mandate-enforcing portfolio. `rebalance()` executes the agent's trades through the desk, then
  checks slippage per trade, turnover per window, the cash floor and the cap of every asset it bought, and emits the
  rationale hash and URI. `snapshot()` returns everything a dashboard needs in one call. Valuation uses the Chainlink
  total-return price on raw B20 balances (the feed already includes the multiplier); the B20 multiplier is only used to
  display share-equivalent amounts via ERC-8056 `toUIAmount`.
- **`LeashFactory`**: creates vaults, indexes them by owner and agent, and supports one-transaction onboarding with an
  EIP-2612 `permit` on the B20 USD token.
- **`LeashDesk`**: testnet liquidity venue. Quotes each listed stock at its oracle price plus a spread and settles by
  minting and burning the testnet B20 tokens, so liquidity never runs out. It only ever pays `msg.sender`. On mainnet the
  same vault would route to DEX or RFQ liquidity for the real Coinbase tokens.
- **`MirrorFeedHub` / `MirrorFeed`**: copies Base mainnet Chainlink rounds (same round ids, answers and timestamps) to
  the testnet behind AggregatorV3-compatible adapters, each recording the mainnet feed it mirrors.
- **`UsdFaucet`**: hands out the test USD so anyone can try Leash.

### Base-native pieces

- **B20 token standard.** The ten test stocks (`tAAPLc` … `tTSLAc`, 8 decimals like Coinbase's) and the test USD
  (`tUSD`, B20 Stablecoin variant) are created through the B20 factory precompile at
  `0xB20f000000000000000000000000000000000000`, with roles, extra metadata linking each to its mainnet token, ISIN and
  feed, and multipliers mirrored from mainnet with ERC-8056 `updateUIMultiplier`.
- **Chainlink tokenized-equity feeds** on Base for AAPL, AMZN, GOOGL, META, MSFT, MSTR, NVDA, SNDK, SPCX and TSLA, with
  staleness handling as the Base docs require ("never settle against a frozen feed").
- **Builder Codes (ERC-8021).** The agent registered `bc_dm1hqi1l` through `api.base.dev`; every agent transaction and
  every transaction sent from the app carries the suffix, and the app checks it on each rebalance.
- **Coinbase Tokenized Stocks API** for supply, multipliers and reference data.

### The agent (`agent/`)

TypeScript + viem, run by [`.github/workflows/agent.yml`](.github/workflows/agent.yml) every two hours around US market
hours, once per chain (Base Sepolia, then Base Vibenet). Each cycle:

1. mirrors new mainnet Chainlink rounds and B20 multipliers to the testnet;
2. builds signals only from onchain and issuer data: 1/5/20-day total returns, 20-day volatility and drawdown from
   Chainlink round history (cached daily closes), 7-day change in onchain supply (net creations) from the Coinbase API;
3. computes a rules baseline (inverse volatility with a momentum tilt, by profile) and asks an LLM to review it and
   explain itself. By default this is the open-weight `gpt-oss-20b` through Pollinations' free OpenAI-compatible API;
   any OpenAI-compatible endpoint can be configured, and the agent falls back to the rules if the model is unavailable;
4. clips the proposal to the mandate, plans trades that fit the remaining turnover budget and the cash floor,
   simulates `rebalance()` and only then sends it;
5. publishes a rationale document (signals, model output, every leash correction, trades) to the `notes` branch. Its
   keccak256 is committed in the `Rebalanced` event, so anyone can verify the published reasoning is the one the agent
   acted on. The app does this check for every rebalance.

## Repository

```
contracts/   Foundry project (Solidity 0.8.30, Base hardfork Denim), tests run against a Base Sepolia fork
agent/       deploy, relay, research, strategy, LLM, planner, run
app/         Vite + React + viem dashboard (GitHub Pages)
deployments/ addresses per chain id
```

## Run it

```bash
# contracts: tests use the live B20 precompiles through a Base Sepolia fork
cd contracts && forge test --fork-url https://sepolia.base.org

# agent (needs a funded testnet key in AGENT_KEY)
cd agent && npm ci
LEASH_CHAIN=baseSepolia LEASH_DRY_RUN=1 npx tsx src/run.ts

# app
cd app && npm ci && npm run dev
```

## Built during the quest

Everything in this repository was written during the Stocks Maxxing season (November 2026); nothing pre-existed.
Development used AI coding assistants, and the agent itself uses an LLM as described above.

## License

MIT. Built by Phant Studio.
