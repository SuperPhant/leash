// Optional LLM step: asks an OpenAI-compatible chat endpoint to review the baseline allocation and write the
// rationale. Default: the free, keyless Pollinations endpoint (open-weight gpt-oss model). Configure another provider
// with LEASH_LLM_ENDPOINT / LEASH_LLM_KEY / LEASH_MODEL. The model only proposes; every number it returns goes
// through `leash()` and the vault's onchain checks, and the agent falls back to its rules when the model is unavailable.
import type { Signal } from "./research.js";
import type { Weights } from "./strategy.js";

export interface LlmDecision {
  model: string;
  targets: Weights;
  summary: string;
  perAsset: Record<string, string>;
  risks: string[];
}

const ENDPOINT = process.env.LEASH_LLM_ENDPOINT ?? "https://text.pollinations.ai/openai";
const MODEL = process.env.LEASH_MODEL ?? "openai";
const KEY = process.env.LEASH_LLM_KEY;
// The keyless tier allows one reply per 45 s per IP.
const MIN_INTERVAL_MS = Number(process.env.LEASH_LLM_MIN_INTERVAL_MS ?? (KEY ? 0 : 47_000));
let lastCallAt = 0;

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

function fmt(x: number | null, digits = 1) {
  return x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(digits)}%`;
}

export async function askModel(input: {
  profileName: string;
  style: string;
  caps: Record<string, number>;
  minCash: number;
  frozen: string[];
  signals: Signal[];
  current: Weights;
  baseline: Weights;
}): Promise<LlmDecision | null> {
  if (process.env.LEASH_NO_LLM === "1") return null;

  const rows = input.signals
    .filter((s) => s.ticker in input.caps)
    .map(
      (s) =>
        `${s.ticker}: price ${s.price.toFixed(2)} (age ${s.ageHours.toFixed(1)}h${s.stale ? ", STALE" : ""}), 1d ${fmt(s.ret1d)}, 5d ${fmt(s.ret5d)}, 20d ${fmt(s.ret20d)}, vol20d ${fmt(s.vol20d, 0)}, maxDD20d ${fmt(s.maxDrawdown20d)}, onchain supply 7d ${fmt(s.supplyChange7d)}, multiplier ${s.multiplier ?? "n/a"}, cap ${fmt(input.caps[s.ticker], 0)}, now ${fmt(input.current[s.ticker] ?? 0)}, baseline ${fmt(input.baseline[s.ticker] ?? 0)}`,
    )
    .join("\n");

  const system = [
    "You are the Leash research agent. You manage a portfolio of Coinbase tokenized stocks on Base for a vault owner.",
    "You act only inside an onchain mandate the owner set. Your proposal is checked by code and by the vault contract;",
    "anything outside the limits is cut, so propose within them. Prices are Chainlink total-return values on Base mainnet.",
    "Do not trade names whose oracle is STALE (market closed or corporate action): keep their current weight.",
    "Be concise and factual. Reply with JSON only.",
  ].join(" ");

  const user = [
    `Vault profile: ${input.profileName}. Style: ${input.style}`,
    `Hard limits: per-name caps as listed, keep at least ${fmt(input.minCash, 0)} in cash.`,
    `Frozen (stale oracle): ${input.frozen.length ? input.frozen.join(", ") : "none"}.`,
    "Signals (returns are total-return, vol annualised):",
    rows,
    "",
    "Start from the baseline (inverse-volatility with a momentum tilt) and adjust only where the signals justify it.",
    'Return {"targets": {"TICKER": percent_of_nav_number, ...}, "summary": "<=60 words", "perAsset": {"TICKER": "<=20 words"}, "risks": ["<=3 short items"]}.',
    "Targets are percentages (0-100) of NAV; omitted tickers mean 0. Do not include cash in targets.",
  ].join("\n");

  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (KEY) headers.Authorization = `Bearer ${KEY}`;
  const payload = JSON.stringify({
    model: MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await throttle();
      const res = await fetch(ENDPOINT, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(120_000) });
      if (res.status === 402 || res.status === 429 || res.status >= 500) {
        const text = await res.text();
        const retry = Number(/retry after (\d+)/i.exec(text)?.[1] ?? 20);
        console.warn(`model busy (HTTP ${res.status}), retrying in ${retry + 2}s`);
        await new Promise((r) => setTimeout(r, (Math.min(retry, 90) + 2) * 1000));
        lastCallAt = 0;
        continue;
      }
      if (!res.ok) {
        console.warn(`model call failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        return null;
      }
      const body = await res.json();
      const content = String(body.choices?.[0]?.message?.content ?? "{}");
      const parsed = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
      const targets: Weights = {};
      for (const [t, v] of Object.entries(parsed.targets ?? {})) {
        const n = Number(v);
        if (Number.isFinite(n)) targets[t.toUpperCase().replace(/C$/, "")] = n / 100;
      }
      if (!Object.keys(targets).length) return null;
      return {
        model: String(body.model ?? MODEL),
        targets,
        summary: String(parsed.summary ?? "").slice(0, 600),
        perAsset: Object.fromEntries(
          Object.entries(parsed.perAsset ?? {}).map(([k, v]) => [k.toUpperCase().replace(/C$/, ""), String(v).slice(0, 200)]),
        ),
        risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 3).map((r: unknown) => String(r).slice(0, 200)) : [],
      };
    } catch (e) {
      console.warn(`model call failed: ${(e as Error).message}`);
      if (attempt === 2) return null;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  return null;
}
