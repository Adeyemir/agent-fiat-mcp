import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { BankAccount, Payout, PayoutState } from "./types.js";
import { requireThat } from "./errors.js";

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS payouts (id TEXT PRIMARY KEY, mode TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS demo_transfers (id TEXT PRIMARY KEY, order_id TEXT UNIQUE NOT NULL, units TEXT NOT NULL)");
    this.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('demo_balance','100000000')").run();
  }
  getBank(mode: string): BankAccount | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(`bank:${mode}`);
    return row ? JSON.parse(String(row.value)) as BankAccount : undefined;
  }
  setBank(mode: string, bank: BankAccount) {
    this.db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`bank:${mode}`, JSON.stringify(bank));
  }
  insert(payout: Payout) {
    this.db.prepare("INSERT INTO payouts(id,mode,state,data) VALUES (?,?,?,?)").run(payout.id, payout.mode, payout.state, JSON.stringify(payout));
  }
  get(id: string): Payout {
    const row = this.db.prepare("SELECT data FROM payouts WHERE id=?").get(id);
    requireThat(row, "PAYOUT_NOT_FOUND", "No payout with that ID exists in this local profile.");
    return JSON.parse(String(row.data)) as Payout;
  }
  save(payout: Payout) {
    this.db.prepare("UPDATE payouts SET state=?, data=? WHERE id=?").run(payout.state, JSON.stringify(payout), payout.id);
  }
  saveIfState(payout: Payout, expected: PayoutState): boolean {
    return this.db.prepare("UPDATE payouts SET state=?,data=? WHERE id=? AND state=?").run(payout.state, JSON.stringify(payout), payout.id, expected).changes === 1;
  }
  claim(payout: Payout, expected: PayoutState, next: PayoutState): boolean {
    const updated = { ...payout, state: next };
    const result = this.db.prepare("UPDATE payouts SET state=?,data=? WHERE id=? AND state=?").run(next, JSON.stringify(updated), payout.id, expected);
    if (result.changes === 1) { payout.state = next; return true; }
    return false;
  }
  recent(mode: string): Payout[] {
    return this.db.prepare("SELECT data FROM payouts WHERE mode=? ORDER BY rowid DESC LIMIT 10").all(mode).map(row => JSON.parse(String(row.data)) as Payout);
  }
  demoBalance(): bigint {
    return BigInt(String(this.db.prepare("SELECT value FROM settings WHERE key='demo_balance'").get()!.value));
  }
  demoTransfer(orderId: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM demo_transfers WHERE order_id=?").get(orderId);
    return row ? String(row.id) : undefined;
  }
  submitDemo(orderId: string, amount: bigint): string {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT id,units FROM demo_transfers WHERE order_id=?").get(orderId);
      if (existing) {
        requireThat(String(existing.units) === amount.toString(), "INVALID_DEMO", "A simulated order cannot be paid with a different amount.");
        this.db.exec("COMMIT");
        return String(existing.id);
      }
      const available = this.demoBalance();
      requireThat(amount > 0n && amount <= available, "INSUFFICIENT_BALANCE", "The simulated Arc balance cannot cover this payout.");
      const id = `demo-settlement-${randomUUID()}`;
      this.db.prepare("INSERT INTO demo_transfers(id,order_id,units) VALUES (?,?,?)").run(id, orderId, amount.toString());
      this.db.prepare("UPDATE settings SET value=? WHERE key='demo_balance'").run((available - amount).toString());
      this.db.exec("COMMIT");
      return id;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close() { this.db.close(); }
}
