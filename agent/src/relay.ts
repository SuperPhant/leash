import type { Account, PublicClient, WalletClient } from "viem";
import { pathToFileURL } from "node:url";
import { abi, mainnetClient, testnetClients, write } from "./lib.js";
import { loadDeployment, loadKey, targetChain, type Deployment } from "./config.js";

const aggAbi = abi("AggregatorV3Interface");
const hubAbi = abi("MirrorFeedHub");
const assetAbi = abi("IB20Asset");
const uiAbi = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "newUIMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "effectiveAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export interface RelayReport {
  relayed: Array<{ ticker: string; round: string; price: number; updatedAt: string }>;
  unchanged: string[];
  multipliers: Array<{ ticker: string; from: string; to: string }>;
  tx?: `0x${string}`;
}

type Round = readonly [bigint, bigint, bigint, bigint, bigint];

/** Copies new Base mainnet Chainlink rounds and B20 multipliers for every Leash test stock onto the testnet. */
export async function relayPrices(
  pub: PublicClient,
  wallet: WalletClient,
  account: Account,
  dep: Deployment,
): Promise<RelayReport> {
  const main = mainnetClient();
  const report: RelayReport = { relayed: [], unchanged: [], multipliers: [] };
  const ids: bigint[] = [];
  const rounds: bigint[] = [];
  const answers: bigint[] = [];
  const started: bigint[] = [];
  const updated: bigint[] = [];

  for (const s of dep.stocks) {
    const [mainRound, local] = await Promise.all([
      main.readContract({ address: s.mainnetFeed, abi: aggAbi, functionName: "latestRoundData" }) as Promise<Round>,
      pub.readContract({ address: dep.hub, abi: hubAbi, functionName: "latestRound", args: [BigInt(s.feedId)] }) as Promise<bigint>,
    ]);
    if (mainRound[0] > local) {
      ids.push(BigInt(s.feedId));
      rounds.push(mainRound[0]);
      answers.push(mainRound[1]);
      started.push(mainRound[2]);
      updated.push(mainRound[3]);
      report.relayed.push({
        ticker: s.ticker,
        round: mainRound[0].toString(),
        price: Number(mainRound[1]) / 1e8,
        updatedAt: new Date(Number(mainRound[3]) * 1000).toISOString(),
      });
    } else {
      report.unchanged.push(s.ticker);
    }
  }

  if (ids.length) {
    const { hash } = await write(pub, wallet, account, {
      address: dep.hub,
      abi: hubAbi,
      functionName: "relay",
      args: [ids, rounds, answers, started, updated],
    });
    report.tx = hash;
  }

  for (const s of dep.stocks) {
    const [mainMult, localMult, pending] = await Promise.all([
      main.readContract({ address: s.mainnetToken, abi: uiAbi, functionName: "uiMultiplier" }) as Promise<bigint>,
      pub.readContract({ address: s.token, abi: uiAbi, functionName: "uiMultiplier" }) as Promise<bigint>,
      pub.readContract({ address: s.token, abi: uiAbi, functionName: "effectiveAt" }) as Promise<bigint>,
    ]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (mainMult !== localMult && (pending === 0n || pending <= now)) {
      await write(pub, wallet, account, {
        address: s.token,
        abi: assetAbi,
        functionName: "updateUIMultiplier",
        args: [mainMult, now + 20n],
      });
      report.multipliers.push({ ticker: s.ticker, from: localMult.toString(), to: mainMult.toString() });
    }
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chain = targetChain();
  const dep = loadDeployment(chain.id);
  const { pub, wallet, account } = testnetClients(chain, loadKey("AGENT_KEY", "testnet-agent"));
  const r = await relayPrices(pub, wallet, account, dep);
  console.log(JSON.stringify(r, null, 2));
}
