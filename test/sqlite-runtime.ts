import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export function sqliteRuntime() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of [
    '0001_initial.sql',
    '0002_source_registry.sql',
    '0003_ingestion_and_relations.sql',
    '0004_user_view_history.sql',
    '0005_bounded_parts.sql',
    '0006_view_proposals_and_visibility.sql',
    '0007_listening_progress.sql',
    '0008_media_intake.sql',
  ])
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  class Statement {
    constructor(
      readonly sql: string,
      readonly values: unknown[] = [],
    ) {}
    bind(...values: unknown[]) {
      return new Statement(this.sql, values);
    }
    async first(column?: string) {
      const value = sqlite.prepare(this.sql).get(...(this.values as never[]));
      return value ? (column ? value[column] : value) : null;
    }
    async all() {
      return { results: sqlite.prepare(this.sql).all(...(this.values as never[])) };
    }
    async run() {
      return {
        meta: {
          changes: Number(sqlite.prepare(this.sql).run(...(this.values as never[])).changes),
        },
      };
    }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const stmt of statements) result.push(await stmt.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
  const env = {
    DB: db,
    ENVIRONMENT: 'local',
    AI_ENABLED: 'true',
    OPENAI_MODEL: 'fixture-model',
    OPENAI_API_KEY: 'injected-test-only',
    DAILY_BUDGET_MICRO_USD: '1000000',
    MONTHLY_BUDGET_MICRO_USD: '3000000',
    INPUT_MICRO_USD_PER_TOKEN: '1',
    OUTPUT_MICRO_USD_PER_TOKEN: '2',
  } as Env;
  return { db, env, sqlite };
}
