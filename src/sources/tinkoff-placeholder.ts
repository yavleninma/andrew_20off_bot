import { TinkoffInvestApi } from "tinkoff-invest-api";
import { InstrumentIdType } from "tinkoff-invest-api/dist/generated/instruments.js";
import { OperationState, OperationType, operationTypeToJSON } from "tinkoff-invest-api/dist/generated/operations.js";
import type { DealSignal } from "../types.js";
import type { DealsSource, SourceAccount, SourceDebugOperation } from "./base.js";
import { logger } from "../logger.js";

type TinkoffSourceConfig = {
  accountId?: string;
  lookbackMinutes: number;
  skipHistoryOnStart: boolean;
};

const SIDE_BY_OPERATION_TYPE = new Map<OperationType, "buy" | "sell">([
  [OperationType.OPERATION_TYPE_BUY, "buy"],
  [OperationType.OPERATION_TYPE_BUY_CARD, "buy"],
  [OperationType.OPERATION_TYPE_BUY_MARGIN, "buy"],
  [OperationType.OPERATION_TYPE_DELIVERY_BUY, "buy"],
  [OperationType.OPERATION_TYPE_SELL, "sell"],
  [OperationType.OPERATION_TYPE_SELL_CARD, "sell"],
  [OperationType.OPERATION_TYPE_SELL_MARGIN, "sell"],
  [OperationType.OPERATION_TYPE_DELIVERY_SELL, "sell"]
]);

const ALL_OPERATION_TYPES = Object.values(OperationType)
  .filter((value): value is OperationType => typeof value === "number")
  .filter((value) => value !== OperationType.OPERATION_TYPE_UNSPECIFIED && value !== OperationType.UNRECOGNIZED);
const DEBUG_LOOKBACK_MINUTES = 7 * 24 * 60;

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

function toSide(type: OperationType): "buy" | "sell" | null {
  return SIDE_BY_OPERATION_TYPE.get(type) ?? null;
}

function getOperationTypeName(type: OperationType): string {
  return operationTypeToJSON(type);
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

  async getAccounts(): Promise<SourceAccount[]> {
    return this.getTargetAccounts();
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
      operationTypes: ALL_OPERATION_TYPES,
      limit: 200,
      withoutCommissions: true
    });
  }

  async getRecentOperations(limit: number): Promise<SourceDebugOperation[]> {
    const accounts = await this.getTargetAccounts();
    const collected: SourceDebugOperation[] = [];

    for (const account of accounts) {
      const res = await this.api.operations.getOperationsByCursor({
        accountId: account.id,
        from: toIsoDateBefore(Math.max(this.cfg.lookbackMinutes, DEBUG_LOOKBACK_MINUTES)),
        state: OperationState.OPERATION_STATE_EXECUTED,
        operationTypes: ALL_OPERATION_TYPES,
        limit: Math.min(Math.max(limit, 1), 50),
        withoutCommissions: false
      });

      for (const item of res.items ?? []) {
        if (collected.length >= limit) {
          break;
        }

        const operationType = getOperationTypeName(item.type);
        const side = toSide(item.type);
        const quantity = item.quantityDone || item.quantity || 0;
        const price = item.price ? this.api.helpers.toNumber(item.price) : undefined;
        let skipReason: string | undefined;

        if (!side) {
          skipReason = `unsupported:${operationType}`;
        } else if (!quantity) {
          skipReason = `empty_qty:${operationType}`;
        } else if (!price) {
          skipReason = `empty_price:${operationType}`;
        }

        const ticker = item.figi ? await this.resolveTicker(item.figi) : undefined;
        collected.push({
          accountId: account.id,
          accountLabel: account.label,
          ticker,
          figi: item.figi || undefined,
          operationType,
          operationLabel: item.name || undefined,
          side,
          quantity,
          price,
          date: item.date ? item.date.toISOString() : undefined,
          description: item.description || undefined,
          signalEligible: !skipReason,
          skipReason
        });
      }

      if (collected.length >= limit) {
        break;
      }
    }

    return collected
      .sort((a, b) => new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime())
      .slice(0, limit);
  }

  async pollNewDeals(): Promise<DealSignal[]> {
    const accounts = await this.getTargetAccounts();
    const out: DealSignal[] = [];

    for (const account of accounts) {
      const res = await this.getOpsByCursor(account.id);
      const items = res.items ?? [];
      const skippedByReason = new Map<string, number>();
      let emittedDeals = 0;

      const prevCursor = this.accountCursors.get(account.id) ?? "";
      this.accountCursors.set(account.id, res.nextCursor || prevCursor);

      for (const item of items) {
        const operationType = getOperationTypeName(item.type);
        const side = toSide(item.type);
        if (!side) {
          skippedByReason.set(`unsupported:${operationType}`, (skippedByReason.get(`unsupported:${operationType}`) ?? 0) + 1);
          continue;
        }

        const signalQty = item.quantityDone || item.quantity || 0;
        if (!signalQty) {
          skippedByReason.set(`empty_qty:${operationType}`, (skippedByReason.get(`empty_qty:${operationType}`) ?? 0) + 1);
          continue;
        }

        const price = item.price ? this.api.helpers.toNumber(item.price) : 0;
        if (!price) {
          skippedByReason.set(`empty_price:${operationType}`, (skippedByReason.get(`empty_price:${operationType}`) ?? 0) + 1);
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
          accountLabel: account.label,
          operationType,
          operationLabel: item.name || undefined,
          sourceDescription: item.description || undefined
        });
        emittedDeals += 1;
      }

      this.log.info("tinkoff.poll_account_complete", "Polled account operations", {
        accountId: account.id,
        accountLabel: account.label,
        fetchedItems: items.length,
        emittedDeals,
        skippedSummary: Object.fromEntries(skippedByReason)
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
