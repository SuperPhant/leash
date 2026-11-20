# Leash agent notes

Published by the Leash agent on every run:

- `<chainId>/<vault>/<epoch>.json` rationale documents. The keccak256 of each file is committed onchain in the vault's
  `Rebalanced` event, so the reasoning shown here is provably the one the agent acted on.
- `<chainId>/status.json` latest run and history.
- `<chainId>/index.json` per-vault rebalance index and NAV samples (used by the app).
- `data/` cached daily closes from Base mainnet Chainlink feeds and Coinbase tokenized-stock supply.
