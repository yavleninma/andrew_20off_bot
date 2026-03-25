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

  analytics.calcRecommendedQty(1);

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
