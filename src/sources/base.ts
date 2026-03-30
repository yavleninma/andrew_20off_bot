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

export type SourceAccount = {
  id: string;
  label: string;
};

export type SourceStartupPosition = {
  ticker: string;
  quantity: number;
  figi?: string;
};

export type SourceAccountInitialState = {
  accountId: string;
  accountLabel?: string;
  capturedAt: string;
  totalPortfolioValue?: number;
  positions: SourceStartupPosition[];
};

export interface DealsSource {
  pollNewDeals(): Promise<DealSignal[]>;
  getName(): string;
  getRecentOperations?(limit: number): Promise<SourceDebugOperation[]>;
  getAccounts?(): Promise<SourceAccount[]>;
  getInitialAccountState?(): Promise<SourceAccountInitialState[]>;
}
