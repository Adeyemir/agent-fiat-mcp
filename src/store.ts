import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BankAccount } from "./types.js";
import { requireThat } from "./errors.js";
import type { LivePayout, LivePayoutState } from "./live-types.js";

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS live_payouts (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL)",
    );
  }
  getBank(scope: string): BankAccount | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(`bank:${scope}`);
    return row ? (JSON.parse(String(row.value)) as BankAccount) : undefined;
  }
  setBank(scope: string, bank: BankAccount) {
    this.db
      .prepare(
        "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(`bank:${scope}`, JSON.stringify(bank));
  }
  insertLive(payout: LivePayout) {
    this.db
      .prepare("INSERT INTO live_payouts(id,state,data) VALUES (?,?,?)")
      .run(payout.id, payout.state, JSON.stringify(payout));
  }
  live(id: string): LivePayout {
    const row = this.db.prepare("SELECT data FROM live_payouts WHERE id=?").get(id);
    requireThat(row, "PAYOUT_NOT_FOUND", "No live payout with that ID exists in this profile.");
    return JSON.parse(String(row.data)) as LivePayout;
  }
  saveLive(payout: LivePayout, expected: LivePayoutState): boolean {
    return (
      this.db
        .prepare("UPDATE live_payouts SET state=?,data=? WHERE id=? AND state=?")
        .run(payout.state, JSON.stringify(payout), payout.id, expected).changes === 1
    );
  }
  recentLive(): LivePayout[] {
    return this.db
      .prepare("SELECT data FROM live_payouts ORDER BY rowid DESC LIMIT 10")
      .all()
      .map((row) => JSON.parse(String(row.data)) as LivePayout);
  }
  close() {
    this.db.close();
  }
}
