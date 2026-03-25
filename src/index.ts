import "dotenv/config";
import cron from "node-cron";
import { z } from "zod";
import { AppDb } from "./db.js";
import { SignalBot } from "./bot.js";
import type { DealsSource } from "./sources/base.js";
import { SimulatedDealsSource } from "./sources/simulated.js";
import { TinkoffDealsSource } from "./sources/tinkoff-placeholder.js";
import { SandboxDealsSource } from "./sources/sandbox.js";
import { AnalyticsService } from "./analytics.js";
import type { DealSignal } from "./types.js";
import { logger } from "./logger.js";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  BOT_ACCESS_PASSWORD: z.string().min(4),
  ALLOWED_CHAT_IDS: z.string().optional(),
  SOURCE_MODE: z.enum(["simulated", "sandbox", "tinkoff"]).default("sandbox"),
  SIMULATED_EMIT_MODE: z.enum(["random", "always"]).default("always"),
  TINKOFF_TOKEN: z.string().optional(),
  TINKOFF_ACCOUNT_ID: z.string().optional(),
  TINKOFF_LOOKBACK_MINUTES: z.coerce.number().default(180),
  TINKOFF_SKIP_HISTORY_ON_START: z.coerce.boolean().default(true),
  DB_PATH: z.string().default("./data/app.db"),
  POLL_SECONDS: z.coerce.number().default(15),
  DAILY_DIGEST_CRON: z.string().default("0 21 * * *"),
  MAIN_ACCOUNT_VALUE: z.coerce.number().default(1000000),
  MIRROR_ACCOUNT_VALUE: z.coerce.number().default(100000),
  COMMISSION_RATE: z.coerce.number().default(0.2),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info")
});

const env = envSchema.parse(process.env);
const appLogger = logger.child({ module: "index" });

function maskSecret(value: string, keep = 4): string {
  if (value.length <= keep * 2) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function makeSource(): DealsSource {
  if (env.SOURCE_MODE === "sandbox") {
    return new SandboxDealsSource();
  }
  if (env.SOURCE_MODE === "tinkoff") {
    if (!env.TINKOFF_TOKEN) {
      throw new Error("SOURCE_MODE=tinkoff требует TINKOFF_TOKEN");
    }
    appLogger.info("tinkoff.token_loaded", "Tinkoff token loaded from env", {
      tokenMask: maskSecret(env.TINKOFF_TOKEN)
    });
    if (env.TINKOFF_ACCOUNT_ID) {
      appLogger.info("tinkoff.account_configured", "Account id configured via env", {
        accountId: env.TINKOFF_ACCOUNT_ID
      });
    } else {
      appLogger.info("tinkoff.account_auto_pick", "Account id not set, source will auto-pick active account");
    }
    return new TinkoffDealsSource(env.TINKOFF_TOKEN, {
      accountId: env.TINKOFF_ACCOUNT_ID,
      lookbackMinutes: env.TINKOFF_LOOKBACK_MINUTES,
      skipHistoryOnStart: env.TINKOFF_SKIP_HISTORY_ON_START
    });
  }
  return new SimulatedDealsSource(env.SIMULATED_EMIT_MODE);
}

async function main() {
  const db = new AppDb(env.DB_PATH);
  const analytics = new AnalyticsService(db, {
    mainAccountValue: env.MAIN_ACCOUNT_VALUE,
    mirrorAccountValue: env.MIRROR_ACCOUNT_VALUE,
    commissionRate: env.COMMISSION_RATE
  });
  const source = makeSource();

  const createAndSendSignal = async (deal: DealSignal) => {
    const insertedId = db.upsertSignal(deal);
    if (!insertedId) {
      return;
    }
    await bot.sendSignalToAuthorizedChats(deal, insertedId);
  };

  const emitTestSignal = async () => {
    const now = Date.now();
    const deal: DealSignal = {
      sourceDealId: `manual-test-${now}`,
      ticker: "TEST",
      side: "buy",
      signalPrice: 123.45,
      signalQty: 1,
      signalTime: new Date(now).toISOString()
    };
    await createAndSendSignal(deal);
  };

  const bot = new SignalBot(
    {
      token: env.TELEGRAM_BOT_TOKEN,
      accessPassword: env.BOT_ACCESS_PASSWORD,
      onTestSignal: emitTestSignal
    },
    db,
    analytics
  );

  if (env.ALLOWED_CHAT_IDS) {
    const ids = env.ALLOWED_CHAT_IDS.split(",").map((v) => v.trim()).filter(Boolean);
    for (const chatId of ids) {
      db.upsertAuthorizedChat(chatId);
    }
  }

  appLogger.info("boot.launch_bot", "Launching telegram bot", { source: source.getName() });
  void bot.launch()
    .then(() => appLogger.info("boot.bot_launched", "Telegram bot launched", { source: source.getName() }))
    .catch((err) => appLogger.error("boot.bot_launch_failed", "Telegram bot failed to launch", { error: err }));
  appLogger.info("boot.poll_interval", "Poll interval configured", { pollSeconds: env.POLL_SECONDS });

  const processDealsOnce = async (origin: string) => {
    try {
      const deals = await source.pollNewDeals();
      appLogger.info("poll.fetched", "Fetched deals from source", { origin, dealsCount: deals.length, source: source.getName() });
      for (const deal of deals) {
        await createAndSendSignal(deal);
      }
    } catch (err) {
      appLogger.error("poll.failed", "Failed to poll deals", { origin, error: err, source: source.getName() });
    }
  };

  await processDealsOnce("boot");
  const pollTimer = setInterval(() => {
    void processDealsOnce("interval");
  }, env.POLL_SECONDS * 1000);

  cron.schedule(env.DAILY_DIGEST_CRON, async () => {
    try {
      analytics.runPendingCalculations();
      await bot.sendDailyDigestToAuthorizedChats();
    } catch (err) {
      appLogger.error("digest.failed", "Failed to send daily digest", { error: err });
    }
  });

  process.once("SIGINT", async () => {
    appLogger.warn("shutdown.sigint", "Received SIGINT, stopping services");
    clearInterval(pollTimer);
    await bot.stop();
    db.close();
    process.exit(0);
  });
  process.once("SIGTERM", async () => {
    appLogger.warn("shutdown.sigterm", "Received SIGTERM, stopping services");
    clearInterval(pollTimer);
    await bot.stop();
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  appLogger.error("boot.fatal", "Application terminated with fatal error", { error: err });
  process.exit(1);
});
