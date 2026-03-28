import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionInput, DealSignal, SignalStatus } from "./types.js";

export type SignalRow = {
  id: number;
  sourceDealId: string;
  ticker: string;
  side: "buy" | "sell";
  signalPrice: number;
  signalQty: number;
  signalTime: string;
  status: SignalStatus;
  accountLabel: string | null;
  operationType: string | null;
  operationLabel: string | null;
  sourceDescription: string | null;
};

export type SignalHistoryRow = SignalRow & {
  userAction: "repeat" | "ignore" | null;
  manualPrice: number | null;
  manualQty: number | null;
  actionTime: string | null;
  commissionSaved: number | null;
  slippageCost: number | null;
  netEffect: number | null;
};

export type MetricRow = {
  signalId: number;
  commissionSaved: number;
  slippageCost: number;
  netEffect: number;
  calcTime: string;
};

export class AppDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceDealId TEXT UNIQUE NOT NULL,
        ticker TEXT NOT NULL,
        side TEXT NOT NULL,
        signalPrice REAL NOT NULL,
        signalQty REAL NOT NULL,
        signalTime TEXT NOT NULL,
        accountLabel TEXT,
        operationType TEXT,
        operationLabel TEXT,
        sourceDescription TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signalId INTEGER NOT NULL,
        userAction TEXT NOT NULL,
        manualPrice REAL,
        manualQty REAL,
        actionTime TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(signalId) REFERENCES signals(id)
      );

      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signalId INTEGER UNIQUE NOT NULL,
        commissionSaved REAL NOT NULL,
        slippageCost REAL NOT NULL,
        netEffect REAL NOT NULL,
        calcTime TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(signalId) REFERENCES signals(id)
      );

      CREATE TABLE IF NOT EXISTS authorized_chats (
        chatId TEXT PRIMARY KEY,
        username TEXT,
        addedAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    this.ensureSignalsColumn("accountLabel", "TEXT");
    this.ensureSignalsColumn("operationType", "TEXT");
    this.ensureSignalsColumn("operationLabel", "TEXT");
    this.ensureSignalsColumn("sourceDescription", "TEXT");
  }

  private ensureSignalsColumn(columnName: string, columnDef: string): void {
    const columns = this.db.prepare("PRAGMA table_info(signals)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }
    this.db.exec(`ALTER TABLE signals ADD COLUMN ${columnName} ${columnDef}`);
  }

  upsertSignal(signal: DealSignal): number | null {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO signals (
        sourceDealId, ticker, side, signalPrice, signalQty, signalTime, accountLabel, operationType, operationLabel, sourceDescription, status
      ) VALUES (
        @sourceDealId, @ticker, @side, @signalPrice, @signalQty, @signalTime, @accountLabel, @operationType, @operationLabel, @sourceDescription, 'new'
      )
    `);
    const info = stmt.run(signal);
    if (info.changes === 0) {
      return null;
    }
    return Number(info.lastInsertRowid);
  }

  getSignalById(signalId: number): SignalRow | undefined {
    return this.db
      .prepare("SELECT * FROM signals WHERE id = ?")
      .get(signalId) as SignalRow | undefined;
  }

  getSignalBySourceDealId(sourceDealId: string): SignalRow | undefined {
    return this.db
      .prepare("SELECT * FROM signals WHERE sourceDealId = ?")
      .get(sourceDealId) as SignalRow | undefined;
  }

  getRecentSignals(limit: number): SignalHistoryRow[] {
    return this.db
      .prepare(`
        SELECT
          s.*,
          a.userAction AS userAction,
          a.manualPrice AS manualPrice,
          a.manualQty AS manualQty,
          a.actionTime AS actionTime,
          m.commissionSaved AS commissionSaved,
          m.slippageCost AS slippageCost,
          m.netEffect AS netEffect
        FROM signals s
        LEFT JOIN actions a
          ON a.id = (
            SELECT a2.id
            FROM actions a2
            WHERE a2.signalId = s.id
            ORDER BY datetime(a2.actionTime) DESC, a2.id DESC
            LIMIT 1
          )
        LEFT JOIN metrics m ON m.signalId = s.id
        ORDER BY datetime(s.signalTime) DESC, s.id DESC
        LIMIT ?
      `)
      .all(limit) as SignalHistoryRow[];
  }

  recordAction(input: ActionInput): void {
    const actionStmt = this.db.prepare(`
      INSERT INTO actions (signalId, userAction, manualPrice, manualQty, actionTime)
      VALUES (@signalId, @action, @manualPrice, @manualQty, @actionTime)
    `);
    actionStmt.run({
      signalId: input.signalId,
      action: input.action,
      actionTime: input.actionTime,
      manualPrice: input.manualPrice ?? null,
      manualQty: input.manualQty ?? null
    });

    const status = input.action === "repeat" ? "repeated" : "ignored";
    this.db
      .prepare("UPDATE signals SET status = ? WHERE id = ?")
      .run(status, input.signalId);
  }

  upsertMetric(metric: MetricRow): void {
    this.db
      .prepare(`
        INSERT INTO metrics (signalId, commissionSaved, slippageCost, netEffect, calcTime)
        VALUES (@signalId, @commissionSaved, @slippageCost, @netEffect, @calcTime)
        ON CONFLICT(signalId) DO UPDATE SET
          commissionSaved = excluded.commissionSaved,
          slippageCost = excluded.slippageCost,
          netEffect = excluded.netEffect,
          calcTime = excluded.calcTime
      `)
      .run(metric);
  }

  getActionsWithoutMetrics(): Array<{
    signalId: number;
    side: "buy" | "sell";
    signalPrice: number;
    signalQty: number;
    manualPrice: number | null;
    manualQty: number | null;
    userAction: "repeat" | "ignore";
  }> {
    return this.db
      .prepare(`
        SELECT
          a.signalId AS signalId,
          s.side AS side,
          s.signalPrice AS signalPrice,
          s.signalQty AS signalQty,
          a.manualPrice AS manualPrice,
          a.manualQty AS manualQty,
          a.userAction AS userAction
        FROM actions a
        JOIN signals s ON s.id = a.signalId
        LEFT JOIN metrics m ON m.signalId = a.signalId
        WHERE m.signalId IS NULL
      `)
      .all() as Array<{
      signalId: number;
      side: "buy" | "sell";
      signalPrice: number;
      signalQty: number;
      manualPrice: number | null;
      manualQty: number | null;
      userAction: "repeat" | "ignore";
    }>;
  }

  getDailySummary(): {
    totalSignals: number;
    repeated: number;
    ignored: number;
    totalCommissionSaved: number;
    totalSlippageCost: number;
    totalNetEffect: number;
  } {
    const counts = this.db
      .prepare(`
        SELECT
          COUNT(*) AS totalSignals,
          SUM(CASE WHEN status = 'repeated' THEN 1 ELSE 0 END) AS repeated,
          SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END) AS ignored
        FROM signals
        WHERE datetime(signalTime) >= datetime('now', '-1 day')
      `)
      .get() as {
      totalSignals: number | null;
      repeated: number | null;
      ignored: number | null;
    };

    const metrics = this.db
      .prepare(`
        SELECT
          COALESCE(SUM(commissionSaved), 0) AS totalCommissionSaved,
          COALESCE(SUM(slippageCost), 0) AS totalSlippageCost,
          COALESCE(SUM(netEffect), 0) AS totalNetEffect
        FROM metrics
        WHERE datetime(calcTime) >= datetime('now', '-1 day')
      `)
      .get() as {
      totalCommissionSaved: number;
      totalSlippageCost: number;
      totalNetEffect: number;
    };

    return {
      totalSignals: counts.totalSignals ?? 0,
      repeated: counts.repeated ?? 0,
      ignored: counts.ignored ?? 0,
      totalCommissionSaved: metrics.totalCommissionSaved,
      totalSlippageCost: metrics.totalSlippageCost,
      totalNetEffect: metrics.totalNetEffect
    };
  }

  upsertAuthorizedChat(chatId: string, username?: string): void {
    this.db
      .prepare(`
        INSERT INTO authorized_chats (chatId, username)
        VALUES (?, ?)
        ON CONFLICT(chatId) DO UPDATE SET
          username = excluded.username
      `)
      .run(chatId, username ?? null);
  }

  getAuthorizedChatIds(): string[] {
    const rows = this.db
      .prepare("SELECT chatId FROM authorized_chats")
      .all() as Array<{ chatId: string }>;
    return rows.map((row) => row.chatId);
  }

  close(): void {
    this.db.close();
  }
}
