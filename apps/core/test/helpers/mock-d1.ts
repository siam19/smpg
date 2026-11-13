import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/d1';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as schema from '../../src/db/schema';

class MockD1PreparedStatement {
  constructor(
    private db: Database,
    private sql: string,
    private params: any[] = []
  ) {}

  bind(...params: any[]) {
    return new MockD1PreparedStatement(this.db, this.sql, params);
  }

  async all() {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...this.params);
    return { results, success: true, meta: {} };
  }

  async run() {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    return {
      success: true,
      meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
    };
  }

  async get() {
    const stmt = this.db.prepare(this.sql);
    return stmt.get(...this.params) as any;
  }

  async raw() {
    const stmt = this.db.prepare(this.sql);
    return stmt.values(...this.params);
  }
}

export class MockD1Database {
  constructor(public db: Database) {}

  prepare(sql: string) {
    return new MockD1PreparedStatement(this.db, sql);
  }

  async batch(statements: MockD1PreparedStatement[]) {
    const results = [];
    for (const s of statements) {
      results.push(await s.all());
    }
    return results;
  }

  async exec(sql: string) {
    this.db.exec(sql);
    return { count: 1, duration: 0 };
  }
}

export function createTestD1(): { d1: D1Database; db: ReturnType<typeof drizzle> } {
  const sqlite = new Database(':memory:');

  const migrationsDir = join(__dirname, '../../migrations');
  const m1 = readFileSync(join(migrationsDir, '0001_initial_schema.sql'), 'utf-8');
  const m2 = readFileSync(join(migrationsDir, '0002_merchant_onboarding.sql'), 'utf-8');
  const m3 = readFileSync(join(migrationsDir, '0003_nullable_payment_method.sql'), 'utf-8');

  sqlite.exec(m1);
  sqlite.exec(m2);
  sqlite.exec(m3);

  const mockD1 = new MockD1Database(sqlite);
  const db = drizzle(mockD1 as unknown as D1Database, { schema });

  return { d1: mockD1 as unknown as D1Database, db };
}
