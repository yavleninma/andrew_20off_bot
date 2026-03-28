import { Markup, Telegraf } from "telegraf";
import type { AppDb } from "./db.js";
import type { DealSignal } from "./types.js";
import type { AnalyticsService } from "./analytics.js";
import { logger } from "./logger.js";

type BotConfig = {
  token: string;
  accessPassword: string;
  onTestSignal?: () => Promise<void>;
  getRecentSourceOperations?: (limit: number) => Promise<Array<{
    accountId?: string;
    accountLabel?: string;
    ticker?: string;
    figi?: string;
    operationType?: string;
    operationLabel?: string;
    side?: "buy" | "sell" | null;
    quantity?: number;
    price?: number;
    date?: string;
    description?: string;
    signalEligible: boolean;
    skipReason?: string;
  }>>;
};

type PendingManualEntry = {
  signalId: number;
  mode: "qty" | "sum";
};

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function formatRub(value: number): string {
  return `${round2(value)} руб.`;
}

function parseLocaleNumber(raw: string): number {
  return Number(raw.replace(",", "."));
}

function formatSignalStatus(status: string): string {
  if (status === "repeated") {
    return "повторен";
  }
  if (status === "ignored") {
    return "игнор";
  }
  return "новый";
}

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function makeQuickHelp(): string {
  return [
    "Быстрый сценарий:",
    "1) Дождись сигнала и нажми кнопку.",
    "2) Повторил -> нажми кнопку ввода и отправь 2 числа.",
    "3) Игнор -> ничего дополнительно делать не нужно.",
    "",
    "Команды:",
    "/fill <signalId> <price> <qty>",
    "/fillsum <signalId> <price> <amountRub>",
    "/history [count]",
    "/lastops [count]",
    "/testsignal",
    "/help"
  ].join("\n");
}

export class SignalBot {
  private readonly bot: Telegraf;
  private readonly accessPassword: string;
  private readonly onTestSignal?: () => Promise<void>;
  private readonly getRecentSourceOperations?: BotConfig["getRecentSourceOperations"];
  private readonly log = logger.child({ module: "bot" });
  private readonly pendingManualEntryByChat = new Map<string, PendingManualEntry>();

  constructor(
    cfg: BotConfig,
    private readonly db: AppDb,
    private readonly analytics: AnalyticsService
  ) {
    this.bot = new Telegraf(cfg.token);
    this.accessPassword = cfg.accessPassword;
    this.onTestSignal = cfg.onTestSignal;
    this.getRecentSourceOperations = cfg.getRecentSourceOperations;
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
        await ctx.reply(`Бот готов к работе.\n${makeQuickHelp()}`);
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
        await ctx.reply("Не хватает пароля. Формат: /auth <password>");
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
        await ctx.reply("Неверный пароль. Проверь ввод и повтори попытку.");
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

    this.bot.command("history", async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        await ctx.reply("Нет доступа. Сначала: /auth <password>");
        return;
      }
      const msg = ctx.message;
      const rawCount = msg && "text" in msg ? msg.text.trim().split(/\s+/)[1] : undefined;
      const parsedCount = rawCount ? Number(rawCount) : 10;
      const limit = Number.isFinite(parsedCount) ? Math.min(Math.max(Math.trunc(parsedCount), 1), 30) : 10;
      const rows = this.db.getRecentSignals(limit);
      if (rows.length === 0) {
        await ctx.reply("История пока пустая.");
        return;
      }

      const text = rows.map((row) => {
        const parts = [
          `#${row.id} ${row.ticker} ${row.side.toUpperCase()} ${round2(row.signalPrice)} x ${round2(row.signalQty)}`,
          `${formatHistoryTime(row.signalTime)} | статус: ${formatSignalStatus(row.status)}`,
          row.accountLabel ? `счет: ${row.accountLabel}` : null,
          row.operationType ? `тип: ${row.operationType}` : null,
          row.operationLabel ? `операция: ${row.operationLabel}` : null,
          row.sourceDescription ? `описание: ${row.sourceDescription}` : null,
          row.userAction ? `действие: ${row.userAction}` : null,
          row.manualPrice != null ? `ручная цена: ${round2(row.manualPrice)}` : null,
          row.manualQty != null ? `ручный объем: ${round2(row.manualQty)}` : null,
          row.netEffect != null ? `эффект: ${formatRub(row.netEffect)}` : null,
          `sourceDealId: ${row.sourceDealId}`
        ].filter(Boolean);
        return parts.join("\n");
      }).join("\n\n");

      await ctx.reply(`Последние сигналы (${rows.length}):\n\n${text}`);
    });

    this.bot.command("lastops", async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        await ctx.reply("Нет доступа. Сначала: /auth <password>");
        return;
      }
      if (!this.getRecentSourceOperations) {
        await ctx.reply("Источник не поддерживает просмотр сырых операций.");
        return;
      }

      const msg = ctx.message;
      const rawCount = msg && "text" in msg ? msg.text.trim().split(/\s+/)[1] : undefined;
      const parsedCount = rawCount ? Number(rawCount) : 10;
      const limit = Number.isFinite(parsedCount) ? Math.min(Math.max(Math.trunc(parsedCount), 1), 20) : 10;

      try {
        const rows = await this.getRecentSourceOperations(limit);
        if (rows.length === 0) {
          await ctx.reply("Источник не вернул последних операций.");
          return;
        }

        const text = rows.map((row, index) => {
          const parts = [
            `${index + 1}. ${row.ticker ?? row.figi ?? "UNKNOWN"} ${row.side ? row.side.toUpperCase() : "NO_SIDE"}`,
            row.date ? `${formatHistoryTime(row.date)} | сигнал: ${row.signalEligible ? "yes" : "no"}` : `сигнал: ${row.signalEligible ? "yes" : "no"}`,
            row.accountLabel ? `счет: ${row.accountLabel}` : null,
            row.operationType ? `тип: ${row.operationType}` : null,
            row.operationLabel ? `операция: ${row.operationLabel}` : null,
            row.price != null ? `цена: ${round2(row.price)}` : null,
            row.quantity != null ? `объем: ${round2(row.quantity)}` : null,
            row.skipReason ? `причина skip: ${row.skipReason}` : null,
            row.description ? `описание: ${row.description}` : null
          ].filter(Boolean);
          return parts.join("\n");
        }).join("\n\n");

        await ctx.reply(`Последние операции из источника (${rows.length}):\n\n${text}`);
      } catch (err) {
        this.log.error("telegram.lastops_failed", "Failed to load recent source operations", { error: err });
        await ctx.reply("Не удалось получить последние операции из источника.");
      }
    });

    this.bot.action(/^repeat:(\d+)$/, async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        await ctx.answerCbQuery("Нет доступа");
        return;
      }
      const signalId = Number(ctx.match[1]);
      const chatId = ctx.chat?.id;
      if (chatId) {
        this.pendingManualEntryByChat.delete(String(chatId));
      }
      await ctx.answerCbQuery();
      await ctx.reply(
        [
          `Сигнал #${signalId}: зафиксируй повтор удобным способом.`,
          "",
          "Быстро: нажми кнопку и отправь 2 числа одним сообщением.",
          "Например: 123.45 10",
          "",
          "Классический режим тоже доступен:",
          `/fill ${signalId} <price> <qty>`,
          `/fillsum ${signalId} <price> <amountRub>`
        ].join("\n"),
        Markup.inlineKeyboard([
          [
            Markup.button.callback("Ввести цену + объем", `manual_qty:${signalId}`),
            Markup.button.callback("Ввести цену + сумму", `manual_sum:${signalId}`)
          ],
          [
            Markup.button.callback("Шаблон /fill", `template_fill:${signalId}`),
            Markup.button.callback("Шаблон /fillsum", `template_fillsum:${signalId}`)
          ]
        ])
      );
    });

    this.bot.action(/^manual_qty:(\d+)$/, async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        await ctx.answerCbQuery("Нет доступа");
        return;
      }
      const signalId = Number(ctx.match[1]);
      const chatId = ctx.chat?.id;
      if (chatId) {
        this.pendingManualEntryByChat.set(String(chatId), { signalId, mode: "qty" });
      }
      await ctx.answerCbQuery("Режим объема включен");
      await ctx.reply(
        [
          `Сигнал #${signalId}: отправь одним сообщением цену и объем.`,
          "Формат: <price> <qty>",
          "Пример: 123.45 10 (или 123,45 10)"
        ].join("\n")
      );
    });

    this.bot.action(/^manual_sum:(\d+)$/, async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        await ctx.answerCbQuery("Нет доступа");
        return;
      }
      const signalId = Number(ctx.match[1]);
      const chatId = ctx.chat?.id;
      if (chatId) {
        this.pendingManualEntryByChat.set(String(chatId), { signalId, mode: "sum" });
      }
      await ctx.answerCbQuery("Режим суммы включен");
      await ctx.reply(
        [
          `Сигнал #${signalId}: отправь одним сообщением цену и сумму в рублях.`,
          "Формат: <price> <amountRub>",
          "Пример: 123.45 10000 (или 123,45 10000)"
        ].join("\n")
      );
    });

    this.bot.action(/^template_fill:(\d+)$/, async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        await ctx.answerCbQuery("Нет доступа");
        return;
      }
      const signalId = Number(ctx.match[1]);
      await ctx.answerCbQuery("Шаблон отправлен");
      await ctx.reply(
        [
          "Скопируй и подставь свои значения:",
          `/fill ${signalId} 123.45 10`
        ].join("\n")
      );
    });

    this.bot.action(/^template_fillsum:(\d+)$/, async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        await ctx.answerCbQuery("Нет доступа");
        return;
      }
      const signalId = Number(ctx.match[1]);
      await ctx.answerCbQuery("Шаблон отправлен");
      await ctx.reply(
        [
          "Скопируй и подставь свои значения:",
          `/fillsum ${signalId} 123.45 10000`
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
        await ctx.reply(
          [
            "Нужны 3 параметра: signalId, price, qty.",
            "Формат: /fill <signalId> <price> <qty>",
            "Пример: /fill 12 123.45 10"
          ].join("\n")
        );
        return;
      }
      const signalId = Number(parts[1]);
      const manualPrice = parseLocaleNumber(parts[2]);
      const manualQty = parseLocaleNumber(parts[3]);
      if (!Number.isFinite(signalId) || !Number.isFinite(manualPrice) || !Number.isFinite(manualQty)) {
        await ctx.reply("Проверь значения: signalId, price и qty должны быть числами. Пример: /fill 12 123.45 10 или /fill 12 123,45 10");
        return;
      }
      if (manualPrice <= 0 || manualQty <= 0) {
        await ctx.reply("Цена и объем должны быть больше 0.");
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
      await ctx.reply(`Сигнал #${signalId}: повтор подтвержден. Цена ${manualPrice}, объем ${round2(manualQty)}.`);
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
        await ctx.reply(
          [
            "Нужны 3 параметра: signalId, price, amountRub.",
            "Формат: /fillsum <signalId> <price> <amountRub>",
            "Пример: /fillsum 12 123.45 10000"
          ].join("\n")
        );
        return;
      }
      const signalId = Number(parts[1]);
      const manualPrice = parseLocaleNumber(parts[2]);
      const amountRub = parseLocaleNumber(parts[3]);
      if (!Number.isFinite(signalId) || !Number.isFinite(manualPrice) || !Number.isFinite(amountRub)) {
        await ctx.reply(
          "Проверь значения: signalId, price и amountRub должны быть числами. Пример: /fillsum 12 123.45 10000 или /fillsum 12 123,45 10000"
        );
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
        `Сигнал #${signalId}: повтор подтвержден. Цена ${manualPrice}, сумма ${formatRub(amountRub)}, объем ${round2(manualQty)}.`
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

    this.bot.on("text", async (ctx) => {
      if (!this.isAuthorized(ctx.chat?.id)) {
        return;
      }
      const msg = ctx.message;
      if (!msg || !("text" in msg)) {
        return;
      }
      const text = msg.text.trim();
      if (text.startsWith("/")) {
        return;
      }
      const chatId = ctx.chat?.id;
      if (!chatId) {
        return;
      }
      const pending = this.pendingManualEntryByChat.get(String(chatId));
      if (!pending) {
        return;
      }
      const parts = text.split(/\s+/);
      if (parts.length < 2) {
        await ctx.reply("Нужно 2 числа через пробел. Пример: 123.45 10 или 123,45 10");
        return;
      }
      const manualPrice = parseLocaleNumber(parts[0]);
      const secondValue = parseLocaleNumber(parts[1]);
      if (!Number.isFinite(manualPrice) || !Number.isFinite(secondValue)) {
        await ctx.reply("Не удалось распознать числа. Пример: 123.45 10 или 123,45 10");
        return;
      }
      if (manualPrice <= 0 || secondValue <= 0) {
        await ctx.reply("Цена и второе значение должны быть больше 0.");
        return;
      }

      if (pending.mode === "qty") {
        const manualQty = secondValue;
        this.db.recordAction({
          signalId: pending.signalId,
          action: "repeat",
          actionTime: new Date().toISOString(),
          manualPrice,
          manualQty
        });
        this.analytics.runPendingCalculations();
        this.pendingManualEntryByChat.delete(String(chatId));
        await ctx.reply(
          `Сигнал #${pending.signalId}: повтор подтвержден. Цена ${manualPrice}, объем ${round2(manualQty)}.`
        );
        return;
      }

      const amountRub = secondValue;
      const manualQty = amountRub / manualPrice;
      this.db.recordAction({
        signalId: pending.signalId,
        action: "repeat",
        actionTime: new Date().toISOString(),
        manualPrice,
        manualQty
      });
      this.analytics.runPendingCalculations();
      this.pendingManualEntryByChat.delete(String(chatId));
      await ctx.reply(
        `Сигнал #${pending.signalId}: повтор подтвержден. Цена ${manualPrice}, сумма ${formatRub(amountRub)}, объем ${round2(manualQty)}.`
      );
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
    const operationTypeLine = signal.operationType ? `Тип операции: ${signal.operationType}` : null;
    const operationLabelLine = signal.operationLabel ? `Операция: ${signal.operationLabel}` : null;
    const accountLine = signal.accountLabel ? `Счет: ${signal.accountLabel}` : null;
    const text = [
      `Сигнал #${signalId}`,
      `Инструмент: ${signal.ticker}`,
      `Действие: ${signal.side.toUpperCase()}`,
      ...(accountLine ? [accountLine] : []),
      ...(operationTypeLine ? [operationTypeLine] : []),
      ...(operationLabelLine ? [operationLabelLine] : []),
      `Цена сигнала: ${round2(signal.signalPrice)}`,
      `Объем в сигнале: ${signal.signalQty}`,
      `Рекомендованный объем: ${recommendedQty}`,
      "",
      "Действие за 5 секунд:",
      "1) Повторил -> нажми кнопку и отправь 2 числа",
      "2) Игнор -> просто нажми кнопку Игнор"
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
      "Итоги за 24 часа",
      `Сигналов: ${sum.totalSignals}`,
      `Повторено: ${sum.repeated}, Игнор: ${sum.ignored}`,
      `Сэкономлено на комиссии: ${formatRub(sum.totalCommissionSaved)}`,
      `Эффект проскальзывания: ${formatRub(sum.totalSlippageCost)}`,
      `Чистый эффект: ${formatRub(sum.totalNetEffect)}`
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
