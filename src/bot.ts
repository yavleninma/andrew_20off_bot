import { Markup, Telegraf } from "telegraf";
import type { AppDb } from "./db.js";
import type { DealSignal } from "./types.js";
import type { AnalyticsService } from "./analytics.js";
import { logger } from "./logger.js";

type BotConfig = {
  token: string;
  accessPassword: string;
  onTestSignal?: () => Promise<void>;
};

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function makeQuickHelp(): string {
  return [
    "Как пользоваться:",
    "1) Жди сигнал с кнопками.",
    "2) Повторил -> отправь /fill или /fillsum.",
    "3) Игнор -> просто пропуск сигнала.",
    "",
    "Команды:",
    "/fill <signalId> <price> <qty>",
    "/fillsum <signalId> <price> <amountRub>",
    "/testsignal"
  ].join("\n");
}

export class SignalBot {
  private readonly bot: Telegraf;
  private readonly accessPassword: string;
  private readonly onTestSignal?: () => Promise<void>;
  private readonly log = logger.child({ module: "bot" });

  constructor(
    cfg: BotConfig,
    private readonly db: AppDb,
    private readonly analytics: AnalyticsService
  ) {
    this.bot = new Telegraf(cfg.token);
    this.accessPassword = cfg.accessPassword;
    this.onTestSignal = cfg.onTestSignal;
    this.setupHandlers();
  }

  private isAuthorized(chatId?: number): boolean {
    if (!chatId) {
      return false;
    }
    return this.db.getAuthorizedChatIds().includes(String(chatId));
  }

  private setupHandlers() {
    this.bot.start(async (ctx) => {
      const chatId = ctx.chat?.id;
      if (this.isAuthorized(chatId)) {
        await ctx.reply(`Бот активен.\n${makeQuickHelp()}`);
        return;
      }
      await ctx.reply("Доступ закрыт. Введи пароль: /auth <password>");
    });

    this.bot.command("auth", async (ctx) => {
      const msg = ctx.message;
      if (!msg || !("text" in msg)) {
        return;
      }
      const parts = msg.text.trim().split(/\s+/);
      if (parts.length < 2) {
        await ctx.reply("Формат: /auth <password>");
        return;
      }
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.reply("Не удалось определить chat id.");
        return;
      }
      const candidate = parts[1];
      if (candidate !== this.accessPassword) {
        this.log.warn("auth.failed", "Authorization failed due to wrong password", {
          chatId: String(chatId),
          username: ctx.from?.username
        });
        await ctx.reply("Неверный пароль.");
        return;
      }
      this.db.upsertAuthorizedChat(String(chatId), ctx.from?.username);
      this.log.info("auth.success", "Chat authorized successfully", {
        chatId: String(chatId),
        username: ctx.from?.username
      });
      await ctx.reply(`Доступ выдан.\n${makeQuickHelp()}`);
    });

    this.bot.command("help", async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        await ctx.reply("Нет доступа. Сначала: /auth <password>");
        return;
      }
      await ctx.reply(makeQuickHelp());
    });

    this.bot.action(/^repeat:(\d+)$/, async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        await ctx.answerCbQuery("Нет доступа");
        return;
      }
      const signalId = Number(ctx.match[1]);
      await ctx.answerCbQuery();
      await ctx.reply(
        [
          "Как зафиксировать повтор:",
          `- По объему: /fill ${signalId} <price> <qty>`,
          `  Пример: /fill ${signalId} 123.45 10`,
          `- По сумме в рублях: /fillsum ${signalId} <price> <amountRub>`,
          `  Пример: /fillsum ${signalId} 123.45 10000`
        ].join("\n")
      );
    });

    this.bot.action(/^ignore:(\d+)$/, async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        await ctx.answerCbQuery("Нет доступа");
        return;
      }
      const signalId = Number(ctx.match[1]);
      this.db.recordAction({
        signalId,
        action: "ignore",
        actionTime: new Date().toISOString()
      });
      this.analytics.runPendingCalculations();
      await ctx.answerCbQuery("Отмечено как Игнор");
      await ctx.reply(`Сигнал #${signalId}: игнор`);
    });

    this.bot.command("fill", async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        await ctx.reply("Нет доступа. Сначала: /auth <password>");
        return;
      }
      const msg = ctx.message;
      if (!msg || !("text" in msg)) {
        return;
      }
      const parts = msg.text.trim().split(/\s+/);
      if (parts.length < 4) {
        await ctx.reply("Формат: /fill <signalId> <price> <qty>");
        return;
      }
      const signalId = Number(parts[1]);
      const manualPrice = Number(parts[2]);
      const manualQty = Number(parts[3]);
      if (!Number.isFinite(signalId) || !Number.isFinite(manualPrice) || !Number.isFinite(manualQty)) {
        await ctx.reply("Ошибка формата. Пример: /fill 12 123.45 10");
        return;
      }

      this.db.recordAction({
        signalId,
        action: "repeat",
        actionTime: new Date().toISOString(),
        manualPrice,
        manualQty
      });
      this.analytics.runPendingCalculations();
      await ctx.reply(`Сигнал #${signalId}: повтор подтвержден по цене ${manualPrice}, объем ${manualQty}`);
    });

    this.bot.command("fillsum", async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        await ctx.reply("Нет доступа. Сначала: /auth <password>");
        return;
      }
      const msg = ctx.message;
      if (!msg || !("text" in msg)) {
        return;
      }
      const parts = msg.text.trim().split(/\s+/);
      if (parts.length < 4) {
        await ctx.reply("Формат: /fillsum <signalId> <price> <amountRub>");
        return;
      }
      const signalId = Number(parts[1]);
      const manualPrice = Number(parts[2]);
      const amountRub = Number(parts[3]);
      if (!Number.isFinite(signalId) || !Number.isFinite(manualPrice) || !Number.isFinite(amountRub)) {
        await ctx.reply("Ошибка формата. Пример: /fillsum 12 123.45 10000");
        return;
      }
      if (manualPrice <= 0 || amountRub <= 0) {
        await ctx.reply("Цена и сумма должны быть больше 0.");
        return;
      }
      const manualQty = amountRub / manualPrice;

      this.db.recordAction({
        signalId,
        action: "repeat",
        actionTime: new Date().toISOString(),
        manualPrice,
        manualQty
      });
      this.analytics.runPendingCalculations();
      await ctx.reply(
        `Сигнал #${signalId}: повтор подтвержден по цене ${manualPrice}, сумма ${round2(amountRub)} RUB, объем ${round2(manualQty)}`
      );
    });

    this.bot.command("testsignal", async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        await ctx.reply("Нет доступа. Сначала: /auth <password>");
        return;
      }
      if (!this.onTestSignal) {
        await ctx.reply("Тестовый сигнал не настроен.");
        return;
      }
      await this.onTestSignal();
      await ctx.reply("Тестовый сигнал отправлен.");
    });
  }

  async launch() {
    await this.bot.launch();
  }

  async stop() {
    this.bot.stop();
  }

  async sendSignal(chatId: string, signal: DealSignal, signalId: number): Promise<void> {
    const recommendedQty = this.analytics.calcRecommendedQty(signal.signalQty);
    const text = [
      `Новый сигнал #${signalId}`,
      `${signal.ticker} | ${signal.side.toUpperCase()}`,
      `Цена сигнала: ${round2(signal.signalPrice)}`,
      `Объем сигнала: ${signal.signalQty}`,
      `Рекомендованный объем: ${recommendedQty}`,
      "",
      "Нажми: Повторил / Игнор"
    ].join("\n");

    await this.bot.telegram.sendMessage(
      chatId,
      text,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Повторил", `repeat:${signalId}`),
          Markup.button.callback("Игнор", `ignore:${signalId}`)
        ]
      ])
    );
  }

  async sendDailyDigest(chatId: string): Promise<void> {
    const sum = this.db.getDailySummary();
    const text = [
      "Итоги за 24ч",
      `Сигналов: ${sum.totalSignals}`,
      `Повторено: ${sum.repeated}, Игнор: ${sum.ignored}`,
      `Сэкономлено комиссии: ${round2(sum.totalCommissionSaved)}`,
      `Потери/выгода от проскальзывания: ${round2(sum.totalSlippageCost)}`,
      `Net effect: ${round2(sum.totalNetEffect)}`
    ].join("\n");
    await this.bot.telegram.sendMessage(chatId, text);
  }

  async sendSignalToAuthorizedChats(signal: DealSignal, signalId: number): Promise<void> {
    const chatIds = this.db.getAuthorizedChatIds();
    for (const chatId of chatIds) {
      try {
        await this.sendSignal(chatId, signal, signalId);
        this.log.info("telegram.signal_sent", "Signal sent to authorized chat", {
          chatId,
          signalId,
          ticker: signal.ticker,
          side: signal.side
        });
      } catch (err) {
        this.log.error("telegram.signal_send_failed", "Failed to send signal to chat", {
          chatId,
          signalId,
          error: err
        });
      }
    }
  }

  async sendDailyDigestToAuthorizedChats(): Promise<void> {
    const chatIds = this.db.getAuthorizedChatIds();
    for (const chatId of chatIds) {
      await this.sendDailyDigest(chatId);
    }
  }
}
