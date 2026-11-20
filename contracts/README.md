# Leash contracts

Foundry project. Solidity 0.8.30 with `via_ir`, Base hardfork `base:Denim` (Foundry 1.10+ runs Base's B20 precompiles).

```bash
forge build
# The B20 factory, B20 tokens and PolicyRegistry are activated on live Base networks, so tests run on a fork:
forge test --fork-url https://sepolia.base.org
```

| Contract | Purpose |
| --- | --- |
| `LeashVault` | Portfolio an agent may rebalance only inside the owner's onchain mandate |
| `LeashFactory` | Creates vaults (with EIP-2612 permit onboarding) and indexes them by owner and agent |
| `LeashDesk` | Testnet venue: oracle price plus spread, settles by minting/burning the testnet B20 tokens |
| `MirrorFeedHub`, `MirrorFeed` | Testnet mirror of Base mainnet Chainlink tokenized-equity feeds (AggregatorV3) |
| `UsdFaucet` | Test USD faucet |
