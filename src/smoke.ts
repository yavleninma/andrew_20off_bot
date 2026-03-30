import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalyticsService } from "./analytics.js";
import { AppDb } from "./db.js";
import { SimulatedDealsSource } from "./sources/simulated.js";

async function run(): Promise<void> {
  const dbPath = join(tmpdir(), `andrew-20off-smoke-${Date.now()}.db`);
  const db = new AppDb(dbPath);

  const analytics = new AnalyticsService(db, {
    mainAccountValue: 1000000,
    mirrorAccountValue: 100000,
    commissionRate: 0.2
  });

  const now = new Date().toISOString();
  analytics.setInitialAccountState([
    {
      accountId: "main",
      accountLabel: "Main",
      capturedAt: now,
      totalPortfolioValue: 1000000,
      positions: [{ ticker: "TEST", quantity: 20 }]
    }
  ]);

  const hint = analytics.buildSizingHint({
    accountId: "main",
    ticker: "TEST",
    signalPrice: 100,
    signalQty: 20,
    signalTime: now
  });

  if (hint.recommendedQty !== 2) {
    throw new Error(`Smoke failed: expected recommended qty 2, got ${hint.recommendedQty}`);
  }

  const source = new SimulatedDealsSource("always", "smoke");
  const deals = await source.pollNewDeals();
  if (!Array.isArray(deals) || deals.length === 0) {
    throw new Error("Smoke failed: simulated source did not emit deals");
  }

  db.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
