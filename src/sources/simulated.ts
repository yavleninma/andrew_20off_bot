import type { DealSignal, Side } from "../types.js";
import type { DealsSource } from "./base.js";

const TICKERS = ["SBER", "GAZP", "YDEX", "LKOH", "TATN", "MOEX"];

function randomSide(): Side {
  return Math.random() > 0.5 ? "buy" : "sell";
}

type SimulatedMode = "random" | "always";

export class SimulatedDealsSource implements DealsSource {
  private counter = 0;

  constructor(
    private readonly mode: SimulatedMode = "always",
    private readonly idPrefix = "sim"
  ) {}

  getName(): string {
    return "simulated";
  }

  async pollNewDeals(): Promise<DealSignal[]> {
    const shouldEmit = this.mode === "always" ? true : Math.random() > 0.6;
    if (!shouldEmit) {
      return [];
    }
    this.counter += 1;
    const ticker = TICKERS[Math.floor(Math.random() * TICKERS.length)];
    const signalPrice = Number((100 + Math.random() * 400).toFixed(2));
    const signalQty = 1 + Math.floor(Math.random() * 5);
    return [
      {
        sourceDealId: `${this.idPrefix}-${Date.now()}-${this.counter}`,
        ticker,
        side: randomSide(),
        signalPrice,
        signalQty,
        signalTime: new Date().toISOString()
      }
    ];
  }
}
