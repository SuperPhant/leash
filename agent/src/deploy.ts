// Deploys the full Leash stack to a Base testnet:
//   tUSD (B20 stablecoin) + ten B20 test stocks that mirror Coinbase tokenized stocks on Base mainnet,
//   a MirrorFeedHub that copies the mainnet Chainlink feeds, the oracle-priced LeashDesk, a faucet,
//   the LeashFactory and three demo vaults delegated to the Leash agent.
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, stringToBytes, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { writeFileSync } from "node:fs";
import { B20_FACTORY, STOCKS, deploymentPath, loadKey, targetChain, BUILDER_CODE, type Deployment } from "./config.js";
import { abi, DATA_SUFFIX, deploy, ROLE, testnetClients, write } from "./lib.js";
import { relayPrices } from "./relay.js";
import { PROFILES } from "./profiles.js";

const chain = targetChain();
const deployerKey = loadKey("DEPLOYER_KEY", "testnet-deployer");
const agentKey = loadKey("AGENT_KEY", "testnet-agent");
const agentAddress = privateKeyToAccount(agentKey).address;
// Deployment transactions are sent without the ERC-8021 suffix (it would be appended to contract init code);
// the agent client attributes every trade it makes.
const { pub, wallet, account } = testnetClients(chain, deployerKey, false);
const agentClients = testnetClients(chain, agentKey);

const factoryAbi = abi("IB20Factory");
const b20Abi = abi("IB20");
const assetAbi = abi("IB20Asset");
const SALT_PREFIX = process.env.LEASH_SALT ?? "leash.v1";

console.log(`chain ${chain.name} (${chain.id}); deployer ${account.address}; agent ${agentAddress}`);
const startBlock = await pub.getBlockNumber();

async function createB20(variant: 0 | 1, saltLabel: string, params: `0x${string}`, initCalls: `0x${string}`[]) {
  const salt = keccak256(stringToBytes(`${SALT_PREFIX}.${saltLabel}`));
  const predicted = (await pub.readContract({
    address: B20_FACTORY,
    abi: factoryAbi,
    functionName: "getB20Address",
    args: [variant, account.address, salt],
  })) as `0x${string}`;
  const exists = (await pub.readContract({ address: B20_FACTORY, abi: factoryAbi, functionName: "isB20Initialized", args: [predicted] })) as boolean;
  if (exists) {
    console.log(`B20 ${saltLabel} already at ${predicted}`);
    return { token: predicted, created: false };
  }
  await write(pub, wallet, account, { address: B20_FACTORY, abi: factoryAbi, functionName: "createB20", args: [variant, salt, params, initCalls] });
  console.log(`created B20 ${saltLabel} at ${predicted}`);
  return { token: predicted, created: true };
}

const grant = (role: `0x${string}`, who: `0x${string}`) =>
  encodeFunctionData({ abi: b20Abi, functionName: "grantRole", args: [role, who] });
const meta = (key: string, value: string) =>
  encodeFunctionData({ abi: assetAbi, functionName: "updateExtraMetadata", args: [key, value] });

// 1. Mirror hub, relayed by the agent.
const hub = await deploy(pub, wallet, account, "MirrorFeedHub", [agentAddress]);

// 2. tUSD: B20 stablecoin variant (6 decimals, currency USD).
const usdParams = encodeAbiParameters(
  parseAbiParameters("(uint8 version,string name,string symbol,address initialAdmin,string currency)"),
  [{ version: 1, name: "Leash Test USD", symbol: "tUSD", initialAdmin: account.address, currency: "USD" }],
);
const { token: usd } = await createB20(1, "tusd", usdParams, [grant(ROLE.MINT, account.address)]);

// 3. Desk (10 bps spread, rejects oracle prices older than 4 days) and faucet (10,000 tUSD per day).
const desk = await deploy(pub, wallet, account, "LeashDesk", [usd, 10, 4 * 24 * 3600]);
const faucet = await deploy(pub, wallet, account, "UsdFaucet", [usd, parseUnits("10000", 6), 24n * 3600n]);
for (const [role, who] of [[ROLE.MINT, desk], [ROLE.BURN, desk], [ROLE.MINT, faucet]] as const) {
  await write(pub, wallet, account, { address: usd, abi: b20Abi, functionName: "grantRole", args: [role, who] });
}

// 4. Ten B20 test stocks + mirrored feeds, listed on the desk.
const stocks: Deployment["stocks"] = [];
for (const s of STOCKS) {
  const params = encodeAbiParameters(
    parseAbiParameters("(uint8 version,string name,string symbol,address initialAdmin,uint8 decimals)"),
    [{ version: 1, name: `${s.name} (Leash testnet mirror)`, symbol: `t${s.symbol}`, initialAdmin: account.address, decimals: s.decimals }],
  );
  const initCalls = [
    grant(ROLE.MINT, desk),
    grant(ROLE.BURN, desk),
    grant(ROLE.OPERATOR, agentAddress),
    grant(ROLE.METADATA, account.address),
  ];
  const { token, created } = await createB20(0, s.ticker.toLowerCase(), params, initCalls);
  if (created) {
    for (const [k, v] of [
      ["mainnet_token", s.mainnetToken],
      ["mainnet_chainlink_feed", s.mainnetFeed],
      ["isin", s.isin],
      ["note", "Testnet mirror for Leash demos. Not a security, no value, not issued by Coinbase."],
    ]) {
      await write(pub, wallet, account, { address: token, abi: assetAbi, functionName: "updateExtraMetadata", args: [k, v] });
    }
  }
  const { result } = await write(pub, wallet, account, {
    address: hub,
    abi: abi("MirrorFeedHub"),
    functionName: "addFeed",
    args: [s.mainnetFeed, s.feedDecimals, `${s.feedDescription} (mirror of Base mainnet Chainlink ${s.mainnetFeed})`],
  });
  const [feedId, feed] = result as [bigint, `0x${string}`];
  await write(pub, wallet, account, { address: desk, abi: abi("LeashDesk"), functionName: "list", args: [token, feed] });
  stocks.push({ ticker: s.ticker, token, feed, feedId: Number(feedId), mainnetToken: s.mainnetToken, mainnetFeed: s.mainnetFeed });
  console.log(`listed t${s.symbol} ${token} feed #${feedId} ${feed}`);
}

// 5. Factory.
const factory = await deploy(pub, wallet, account, "LeashFactory", [desk]);

const dep: Deployment = {
  chainId: chain.id,
  chainName: chain.name,
  deployedAt: new Date().toISOString(),
  deployer: account.address,
  agent: agentAddress,
  builderCode: BUILDER_CODE,
  dataSuffix: DATA_SUFFIX,
  hub,
  usd,
  desk,
  faucet,
  factory,
  startBlock: startBlock.toString(),
  stocks,
  demoVaults: [],
};
writeFileSync(deploymentPath(chain.id), JSON.stringify(dep, null, 2));

// 6. Seed prices from mainnet (agent key = relayer).
console.log(JSON.stringify(await relayPrices(agentClients.pub, agentClients.wallet, agentClients.account, dep), null, 2));

// 7. Demo vaults owned by the deployer and delegated to the agent.
const perVault = parseUnits("100000", 6);
await write(pub, wallet, account, { address: usd, abi: b20Abi, functionName: "mint", args: [account.address, perVault * BigInt(PROFILES.length)] });
await write(pub, wallet, account, { address: usd, abi: b20Abi, functionName: "approve", args: [factory, perVault * BigInt(PROFILES.length)] });
const now = Math.floor(Date.now() / 1000);
for (const p of PROFILES) {
  const tokens = p.tickers.map((t) => stocks.find((s) => s.ticker === t)!.token);
  const mandate = { ...p.mandate, expiry: BigInt(now + 365 * 24 * 3600) };
  const { result } = await write(pub, wallet, account, {
    address: factory,
    abi: abi("LeashFactory"),
    functionName: "createVault",
    args: [agentAddress, tokens, p.caps, mandate, perVault],
  });
  dep.demoVaults.push({ name: p.name, vault: result as `0x${string}`, profile: p.id });
  console.log(`demo vault ${p.name}: ${result}`);
}
writeFileSync(deploymentPath(chain.id), JSON.stringify(dep, null, 2));
console.log(`wrote ${deploymentPath(chain.id)}`);
