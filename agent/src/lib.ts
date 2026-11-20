import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToBytes,
  type Abi,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Attribution } from "ox/erc8021";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILDER_CODE, MAINNET, MAINNET_RPC, ROOT, targetRpc } from "./config.js";

export function abi(name: string): Abi {
  return JSON.parse(readFileSync(join(ROOT, "agent", "abi", `${name}.json`), "utf8")).abi as Abi;
}

export function bytecode(name: string): Hex {
  return JSON.parse(readFileSync(join(ROOT, "agent", "abi", `${name}.json`), "utf8")).bytecode as Hex;
}

export const ROLE = {
  MINT: keccak256(stringToBytes("MINT_ROLE")),
  BURN: keccak256(stringToBytes("BURN_ROLE")),
  OPERATOR: keccak256(stringToBytes("OPERATOR_ROLE")),
  METADATA: keccak256(stringToBytes("METADATA_ROLE")),
} as const;

/** ERC-8021 suffix appended to every transaction the agent sends, attributing it to the Leash Builder Code. */
export const DATA_SUFFIX = Attribution.toDataSuffix({ codes: [BUILDER_CODE] });

export function mainnetClient() {
  return createPublicClient({ chain: MAINNET, transport: http(MAINNET_RPC, { retryCount: 4, batch: true }) });
}

export function testnetClients(chain: Chain, key: Hex, attribute = true) {
  const account = privateKeyToAccount(key);
  const transport = http(targetRpc(chain), { retryCount: 4 });
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account, ...(attribute ? { dataSuffix: DATA_SUFFIX } : {}) });
  return { account, pub, wallet };
}

/** Simulates, sends and waits for a contract write; throws with the decoded revert reason on failure. */
export async function write(
  pub: PublicClient,
  wallet: WalletClient,
  account: Account,
  req: { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[] },
) {
  const { request, result } = await pub.simulateContract({ ...req, account } as never);
  const hash = await wallet.writeContract(request as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${req.functionName} reverted in ${hash}`);
  return { hash, receipt, result: result as unknown };
}

export async function deploy(
  pub: PublicClient,
  wallet: WalletClient,
  account: Account,
  name: string,
  args: readonly unknown[],
): Promise<`0x${string}`> {
  const hash = await wallet.deployContract({ abi: abi(name), bytecode: bytecode(name), args, account, chain: wallet.chain } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy ${name} failed in ${hash}`);
  console.log(`deployed ${name} at ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
