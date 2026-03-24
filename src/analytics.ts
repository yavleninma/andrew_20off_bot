import type { AppDb } from "./db.js";

type AnalyticsConfig = {
  mainAccountValue: number;
  mirrorAccountValue: number;
  commissionRate: number;
};

export class AnalyticsService {
  constructor(
    private readonly db: AppDb,
    private readonly cfg: AnalyticsConfig
  ) {}

  calcRecommendedQty(signalQty: number): number {
    if (this.cfg.mirrorAccountValue <= 0) {
      return signalQty;
    }
    const raw = signalQty * (this.cfg.mainAccountValue / this.cfg.mirrorAccountValue);
    return Math.max(1, Math.round(raw));
  }

  runPendingCalculations(): void {
    const rows = this.db.getActionsWithoutMetrics();
    for (const row of rows) {
      const qty = row.manualQty ?? this.calcRecommendedQty(row.signalQty);

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
