import type { AppDb } from "./db.js";
import type { DealSignal } from "./types.js";
import type { SourceAccountInitialState } from "./sources/base.js";

type AnalyticsConfig = {
  mainAccountValue: number;
  mirrorAccountValue: number;
  commissionRate: number;
};

type SizingMode = "initial_portfolio" | "configured_portfolio" | "signal_qty";

type SizingHint = {
  recommendedQty: number;
  mode: SizingMode;
  sourceTradeValue: number;
  sourceTradePercent: number | null;
  sourcePortfolioValue: number | null;
  mirrorTradeValue: number | null;
  capturedAt: string | null;
  startPositionQty: number | null;
  signalPercentOfStartPosition: number | null;
};

export class AnalyticsService {
  private readonly initialAccountStateById = new Map<string, SourceAccountInitialState>();

  constructor(
    private readonly db: AppDb,
    private readonly cfg: AnalyticsConfig
  ) {}

  setInitialAccountState(states: SourceAccountInitialState[]): void {
    this.initialAccountStateById.clear();
    for (const state of states) {
      this.initialAccountStateById.set(state.accountId, state);
    }
  }

  private roundRecommendedQty(rawQty: number): number {
    return Math.max(1, Math.round(rawQty));
  }

  private calcConfiguredRecommendedQty(signalQty: number): number {
    if (this.cfg.mainAccountValue <= 0 || this.cfg.mirrorAccountValue <= 0) {
      return signalQty;
    }
    const raw = signalQty * (this.cfg.mirrorAccountValue / this.cfg.mainAccountValue);
    return this.roundRecommendedQty(raw);
  }

  buildSizingHint(signal: Pick<DealSignal, "accountId" | "ticker" | "signalPrice" | "signalQty" | "signalTime">): SizingHint {
    const sourceTradeValue = signal.signalPrice * signal.signalQty;
    const initialState = signal.accountId ? this.initialAccountStateById.get(signal.accountId) : undefined;
    const capturedAtMs = initialState ? Date.parse(initialState.capturedAt) : Number.NaN;
    const signalTimeMs = Date.parse(signal.signalTime);
    const canUseInitialPortfolio = Boolean(
      initialState
      && initialState.totalPortfolioValue
      && initialState.totalPortfolioValue > 0
      && (!Number.isFinite(capturedAtMs) || !Number.isFinite(signalTimeMs) || signalTimeMs >= capturedAtMs - 1000)
    );

    const startPositionQty = initialState?.positions.find((position) => position.ticker === signal.ticker)?.quantity ?? null;
    const signalPercentOfStartPosition = startPositionQty && startPositionQty > 0
      ? signal.signalQty / startPositionQty
      : null;

    const sourcePortfolioValue = canUseInitialPortfolio
      ? initialState?.totalPortfolioValue ?? null
      : this.cfg.mainAccountValue > 0
        ? this.cfg.mainAccountValue
        : null;

    if (!sourcePortfolioValue || sourcePortfolioValue <= 0 || this.cfg.mirrorAccountValue <= 0) {
      return {
        recommendedQty: signal.signalQty,
        mode: "signal_qty",
        sourceTradeValue,
        sourceTradePercent: null,
        sourcePortfolioValue,
        mirrorTradeValue: null,
        capturedAt: canUseInitialPortfolio ? initialState?.capturedAt ?? null : null,
        startPositionQty,
        signalPercentOfStartPosition
      };
    }

    const sourceTradePercent = sourceTradeValue / sourcePortfolioValue;
    const mirrorTradeValue = sourceTradePercent * this.cfg.mirrorAccountValue;
    const rawRecommendedQty = signal.signalPrice > 0
      ? mirrorTradeValue / signal.signalPrice
      : this.calcConfiguredRecommendedQty(signal.signalQty);

    return {
      recommendedQty: this.roundRecommendedQty(rawRecommendedQty),
      mode: canUseInitialPortfolio ? "initial_portfolio" : "configured_portfolio",
      sourceTradeValue,
      sourceTradePercent,
      sourcePortfolioValue,
      mirrorTradeValue,
      capturedAt: canUseInitialPortfolio ? initialState?.capturedAt ?? null : null,
      startPositionQty,
      signalPercentOfStartPosition
    };
  }

  calcRecommendedQty(signal: Pick<DealSignal, "accountId" | "ticker" | "signalPrice" | "signalQty" | "signalTime">): number {
    return this.buildSizingHint(signal).recommendedQty;
  }

  runPendingCalculations(): void {
    const rows = this.db.getActionsWithoutMetrics();
    for (const row of rows) {
      const qty = row.manualQty ?? this.calcRecommendedQty({
        accountId: row.accountId ?? undefined,
        ticker: row.ticker,
        signalPrice: row.signalPrice,
        signalQty: row.signalQty,
        signalTime: row.signalTime
      });

      let slippageCost = 0;
      if (row.userAction === "repeat" && row.manualPrice != null) {
        if (row.side === "buy") {
          slippageCost = (row.manualPrice - row.signalPrice) * qty;
        } else {
          slippageCost = (row.signalPrice - row.manualPrice) * qty;
        }
      }

      const commissionSaved = row.userAction === "repeat"
        ? row.signalPrice * qty * this.cfg.commissionRate
        : 0;

      const netEffect = commissionSaved - slippageCost;

      this.db.upsertMetric({
        signalId: row.signalId,
        commissionSaved,
        slippageCost,
        netEffect,
        calcTime: new Date().toISOString()
      });
    }
  }
}
