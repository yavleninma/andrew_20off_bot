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

type SourceAccount = {
  id: string;
  label: string;
};

function buildAccountLabel(accountId: string, accountName?: string): string {
  const cleanedName = accountName?.trim();
  if (cleanedName) {
    return cleanedName;
  }
  const shortId = accountId.length > 6 ? accountId.slice(-6) : accountId;
  return `Счет ...${shortId}`;
}

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
  private accounts?: SourceAccount[];
  private readonly accountCursors = new Map<string, string>();
  private initialized = false;
  private readonly figiToTicker = new Map<string, string>();

  constructor(token: string, cfg?: Partial<TinkoffSourceConfig>) {
    this.api = new TinkoffInvestApi({ token });
    this.cfg = {
      accountId: cfg?.accountId,
      lookbackMinutes: cfg?.lookbackMinutes ?? 180,
      skipHistoryOnStart: cfg?.skipHistoryOnStart ?? true
    };
  }

  getName(): string {
    return "tinkoff";
  }

  private async getTargetAccounts(): Promise<SourceAccount[]> {
    if (this.accounts) {
      return this.accounts;
    }
    const res = await this.api.users.getAccounts({});
    const allAccounts = res.accounts
      .filter((acc) => Boolean(acc.id))
      .map((acc) => ({
        id: String(acc.id),
        label: buildAccountLabel(String(acc.id), acc.name),
        status: acc.status
      }));

    if (allAccounts.length === 0) {
      throw new Error("Не удалось найти ни одного счета в Tinkoff API");
    }

    if (this.cfg.accountId) {
      const selected = allAccounts.find((acc) => acc.id === this.cfg.accountId);
      if (!selected) {
        throw new Error(`TINKOFF_ACCOUNT_ID=${this.cfg.accountId} не найден среди доступных счетов`);
      }
      this.accounts = [{ id: selected.id, label: selected.label }];
      this.log.info("tinkoff.account_selected", "Using configured account", {
        accountId: selected.id,
        accountLabel: selected.label
      });
      return this.accounts;
    }

    const active = allAccounts.filter((acc) => acc.status === 2);
    const selected = active.length > 0 ? active : allAccounts;
    this.accounts = selected.map((acc) => ({ id: acc.id, label: acc.label }));
    this.log.info("tinkoff.accounts_selected", "Using all selected accounts", {
      selectedCount: this.accounts.length,
      accountIds: this.accounts.map((acc) => acc.id)
    });
    return this.accounts;
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

  private async getOpsByCursor(accountId: string) {
    return this.api.operations.getOperationsByCursor({
      accountId,
      cursor: this.accountCursors.get(accountId) || undefined,
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
    const accounts = await this.getTargetAccounts();
    const out: DealSignal[] = [];
    for (const account of accounts) {
      const res = await this.getOpsByCursor(account.id);
      const items = res.items ?? [];
      const prevCursor = this.accountCursors.get(account.id) ?? "";
      this.accountCursors.set(account.id, res.nextCursor || prevCursor);

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
          sourceDealId: `tinkoff-${account.id}-${item.cursor || item.id}`,
          ticker,
          side,
          signalPrice: price,
          signalQty,
          signalTime: (item.date ?? new Date()).toISOString(),
          accountId: account.id,
          accountLabel: account.label
        });
      }

      this.log.info("tinkoff.poll_account_complete", "Polled account operations", {
        accountId: account.id,
        accountLabel: account.label,
        fetchedItems: items.length
      });
    }

    const isFirstPoll = !this.initialized;
    this.initialized = true;
    if (isFirstPoll && this.cfg.skipHistoryOnStart) {
      this.log.info("tinkoff.poll_skip_history", "Skipping historical operations on first poll", {
        skippedDeals: out.length
      });
      return [];
    }

    this.log.info("tinkoff.poll_complete", "Polled and transformed operations across accounts", {
      accountsCount: accounts.length,
      emittedDeals: out.length
    });
    return out;
  }
}
