import { TinkoffInvestApi } from "tinkoff-invest-api";
import { InstrumentIdType } from "tinkoff-invest-api/dist/generated/instruments.js";
import { OperationState, OperationType } from "tinkoff-invest-api/dist/generated/operations.js";
import type { DealSignal } from "../types.js";
import type { DealsSource } from "./base.js";
import { logger } from "../logger.js";

type TinkoffSourceConfig = {
  accountId?: string;
  lookbackMinutes: number;
  skipHistoryOnStart: boolean;
};

function toIsoDateBefore(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

function isTradeOperation(type: OperationType): boolean {
  return (
    type === OperationType.OPERATION_TYPE_BUY ||
    type === OperationType.OPERATION_TYPE_BUY_CARD ||
    type === OperationType.OPERATION_TYPE_BUY_MARGIN ||
    type === OperationType.OPERATION_TYPE_SELL ||
    type === OperationType.OPERATION_TYPE_SELL_CARD ||
    type === OperationType.OPERATION_TYPE_SELL_MARGIN
  );
}

function toSide(type: OperationType): "buy" | "sell" | null {
  if (
    type === OperationType.OPERATION_TYPE_BUY ||
    type === OperationType.OPERATION_TYPE_BUY_CARD ||
    type === OperationType.OPERATION_TYPE_BUY_MARGIN
  ) {
    return "buy";
  }
  if (
    type === OperationType.OPERATION_TYPE_SELL ||
    type === OperationType.OPERATION_TYPE_SELL_CARD ||
    type === OperationType.OPERATION_TYPE_SELL_MARGIN
  ) {
    return "sell";
  }
  return null;
}

export class TinkoffDealsSource implements DealsSource {
  private readonly api: TinkoffInvestApi;
  private readonly cfg: TinkoffSourceConfig;
  private readonly log = logger.child({ module: "source.tinkoff" });
  private accountId?: string;
  private cursor = "";
  private initialized = false;
  private readonly figiToTicker = new Map<string, string>();

  constructor(token: string, cfg?: Partial<TinkoffSourceConfig>) {
    this.api = new TinkoffInvestApi({ token });
    this.cfg = {
      accountId: cfg?.accountId,
      lookbackMinutes: cfg?.lookbackMinutes ?? 180,
      skipHistoryOnStart: cfg?.skipHistoryOnStart ?? true
    };
    this.accountId = this.cfg.accountId;
  }

  getName(): string {
    return "tinkoff";
  }

  private async ensureAccountId(): Promise<string> {
    if (this.accountId) {
      return this.accountId;
    }
    const res = await this.api.users.getAccounts({});
    const activeAccount = res.accounts.find((acc) => acc.status === 2) ?? res.accounts[0];
    if (!activeAccount?.id) {
      throw new Error("Не удалось найти активный счет в Tinkoff API");
    }
    this.accountId = activeAccount.id;
    this.log.info("tinkoff.account_selected", "Selected active account from API", {
      accountId: activeAccount.id
    });
    return activeAccount.id;
  }

  private async resolveTicker(figi: string): Promise<string> {
    if (!figi) {
      return "UNKNOWN";
    }
    const cached = this.figiToTicker.get(figi);
    if (cached) {
      return cached;
    }
    try {
      const res = await this.api.instruments.getInstrumentBy({
        idType: InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
        id: figi
      });
      const ticker = res.instrument?.ticker || figi;
      this.figiToTicker.set(figi, ticker);
      return ticker;
    } catch {
      return figi;
    }
  }

  private async getOpsByCursor() {
    const accountId = await this.ensureAccountId();
    return this.api.operations.getOperationsByCursor({
      accountId,
      cursor: this.cursor || undefined,
      from: toIsoDateBefore(this.cfg.lookbackMinutes),
      state: OperationState.OPERATION_STATE_EXECUTED,
      operationTypes: [
        OperationType.OPERATION_TYPE_BUY,
        OperationType.OPERATION_TYPE_BUY_CARD,
        OperationType.OPERATION_TYPE_BUY_MARGIN,
        OperationType.OPERATION_TYPE_SELL,
        OperationType.OPERATION_TYPE_SELL_CARD,
        OperationType.OPERATION_TYPE_SELL_MARGIN
      ],
      limit: 200,
      withoutCommissions: true
    });
  }

  async pollNewDeals(): Promise<DealSignal[]> {
    const res = await this.getOpsByCursor();
    const items = res.items ?? [];
    this.cursor = res.nextCursor || this.cursor;

    if (!this.initialized) {
      this.initialized = true;
      if (this.cfg.skipHistoryOnStart) {
        return [];
      }
    }

    const out: DealSignal[] = [];
    for (const item of items) {
      if (!isTradeOperation(item.type)) {
        continue;
      }
      const side = toSide(item.type);
      if (!side) {
        continue;
      }
      const signalQty = item.quantityDone || item.quantity || 0;
      if (!signalQty) {
        continue;
      }
      const price = item.price ? this.api.helpers.toNumber(item.price) : 0;
      if (!price) {
        continue;
      }
      const ticker = await this.resolveTicker(item.figi);
      out.push({
        sourceDealId: `tinkoff-${item.cursor || item.id}`,
        ticker,
        side,
        signalPrice: price,
        signalQty,
        signalTime: (item.date ?? new Date()).toISOString()
      });
    }
    this.log.info("tinkoff.poll_complete", "Polled and transformed operations", {
      fetchedItems: items.length,
      emittedDeals: out.length
    });
    return out;
  }
}
