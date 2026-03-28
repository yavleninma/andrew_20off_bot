import type { DealSignal } from "../types.js";

export type SourceDebugOperation = {
  accountId?: string;
  accountLabel?: string;
  ticker?: string;
  figi?: string;
  operationType?: string;
  operationLabel?: string;
  side?: "buy" | "sell" | null;
  quantity?: number;
  price?: number;
  date?: string;
  description?: string;
  signalEligible: boolean;
  skipReason?: string;
};

export interface DealsSource {
  pollNewDeals(): Promise<DealSignal[]>;
  getName(): string;
  getRecentOperations?(limit: number): Promise<SourceDebugOperation[]>;
}
