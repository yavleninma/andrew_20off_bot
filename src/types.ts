export type Side = "buy" | "sell";

export type SignalStatus = "new" | "repeated" | "ignored";

export type UserAction = "repeat" | "ignore";

export type DealSignal = {
  sourceDealId: string;
  ticker: string;
  side: Side;
  signalPrice: number;
  signalQty: number;
  signalTime: string;
  accountId?: string;
  accountLabel?: string;
  operationType?: string;
  operationLabel?: string;
  sourceDescription?: string;
};

export type ActionInput = {
  signalId: number;
  action: UserAction;
  actionTime: string;
  manualPrice?: number;
  manualQty?: number;
};
