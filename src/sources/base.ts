import type { DealSignal } from "../types.js";

export interface DealsSource {
  pollNewDeals(): Promise<DealSignal[]>;
  getName(): string;
}
