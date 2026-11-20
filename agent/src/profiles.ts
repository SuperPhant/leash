// Risk profiles used for the demo vaults and offered as presets in the app.
export interface Profile {
  id: string;
  name: string;
  style: string;
  tickers: string[];
  caps: number[];
  mandate: {
    minCashBps: number;
    maxTurnoverBps: number;
    turnoverWindow: number;
    maxSlippageBps: number;
    maxOracleAge: number;
    cooldown: number;
  };
}

const DAY = 24 * 3600;
const ALL = ["AAPL", "AMZN", "GOOGL", "META", "MSFT", "MSTR", "NVDA", "SNDK", "SPCX", "TSLA"];

export const PROFILES: Profile[] = [
  {
    id: "steady",
    name: "Steady Megacaps",
    style:
      "Capital preservation. Hold a diversified core of the six largest US megacaps, prefer lower volatility, trade rarely and only when weights drift or risk rises.",
    tickers: ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA"],
    caps: [2000, 2000, 2000, 2000, 2000, 2000],
    mandate: {
      minCashBps: 2000,
      maxTurnoverBps: 2500,
      turnoverWindow: DAY,
      maxSlippageBps: 30,
      maxOracleAge: DAY + 2 * 3600,
      cooldown: 6 * 3600,
    },
  },
  {
    id: "balanced",
    name: "Balanced Ten",
    style:
      "Diversified across all ten Coinbase tokenized stocks with Chainlink feeds. Tilt moderately toward recent relative strength, cut names whose volatility spikes.",
    tickers: ALL,
    caps: ALL.map(() => 1500),
    mandate: {
      minCashBps: 1000,
      maxTurnoverBps: 3500,
      turnoverWindow: DAY,
      maxSlippageBps: 40,
      maxOracleAge: DAY + 2 * 3600,
      cooldown: 4 * 3600,
    },
  },
  {
    id: "momentum",
    name: "Momentum Hunter",
    style:
      "Aggressive. Concentrate in the strongest recent performers among the ten names and rotate out of laggards quickly, within the caps.",
    tickers: ALL,
    caps: ALL.map(() => 3000),
    mandate: {
      minCashBps: 500,
      maxTurnoverBps: 6000,
      turnoverWindow: DAY,
      maxSlippageBps: 50,
      maxOracleAge: DAY + 2 * 3600,
      cooldown: 2 * 3600,
    },
  },
];
