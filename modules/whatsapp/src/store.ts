import { createClient } from 'redis';
import Database from 'better-sqlite3';

export interface Store {
  get(key: string): Promise<string | null>;
  setnx(key: string, value: string, ttl: number): Promise<boolean>;
  set(key: string, value: string, ttl: number): Promise<void>;
  incr(key: string, ttlIfNew: number): Promise<number>;
  ping(): Promise<boolean>;
  disconnect(): Promise<void>;
}

export class RedisStore implements Store {
  private client: ReturnType<typeof createClient>;

  constructor(redisUrl: string) {
    this.client = createClient({ url: redisUrl });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async setnx(key: string, value: string, ttl: number): Promise<boolean> {
    const result = await this.client.set(key, value, { NX: true, EX: ttl });
    return result === 'OK';
  }

  async set(key: string, value: string, ttl: number): Promise<void> {
    await this.client.set(key, value, { EX: ttl });
  }

  async incr(key: string, ttlIfNew: number): Promise<number> {
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, ttlIfNew);
    }
    return count;
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }
}

interface StoreRow {
  key: string;
  value: string;
  expires_at: number;
}

export class SqliteStore implements Store {
  private db: Database.Database;

  constructor(sqlitePath: string) {
    this.db = new Database(sqlitePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  private pruneExpired(key: string): void {
    this.db.prepare('DELETE FROM store WHERE key = ? AND expires_at <= ?').run(key, Date.now());
  }

  async get(key: string): Promise<string | null> {
    this.pruneExpired(key);
    const row = this.db
      .prepare('SELECT value FROM store WHERE key = ? AND expires_at > ?')
      .get(key, Date.now()) as Pick<StoreRow, 'value'> | undefined;
    return row?.value ?? null;
  }

  async setnx(key: string, value: string, ttl: number): Promise<boolean> {
    const expiresAt = Date.now() + ttl * 1000;
    try {
      const transact = this.db.transaction(() => {
        this.db.prepare('DELETE FROM store WHERE key = ? AND expires_at <= ?').run(key, Date.now());
        const result = this.db
          .prepare('INSERT OR IGNORE INTO store (key, value, expires_at) VALUES (?, ?, ?)')
          .run(key, value, expiresAt);
        return result.changes === 1;
      });
      return transact() as boolean;
    } catch {
      return false;
    }
  }

  async set(key: string, value: string, ttl: number): Promise<void> {
    const expiresAt = Date.now() + ttl * 1000;
    this.db
      .prepare('INSERT OR REPLACE INTO store (key, value, expires_at) VALUES (?, ?, ?)')
      .run(key, value, expiresAt);
  }

  async incr(key: string, ttlIfNew: number): Promise<number> {
    const expiresAt = Date.now() + ttlIfNew * 1000;
    const transact = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT value, expires_at FROM store WHERE key = ? AND expires_at > ?')
        .get(key, Date.now()) as Pick<StoreRow, 'value' | 'expires_at'> | undefined;

      if (existing) {
        const newVal = parseInt(existing.value, 10) + 1;
        this.db
          .prepare('UPDATE store SET value = ? WHERE key = ?')
          .run(String(newVal), key);
        return newVal;
      } else {
        this.db
          .prepare('INSERT OR REPLACE INTO store (key, value, expires_at) VALUES (?, ?, ?)')
          .run(key, '1', expiresAt);
        return 1;
      }
    });
    return transact() as number;
  }

  async ping(): Promise<boolean> {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.db.close();
  }
}

export async function createStore(
  backend: 'redis' | 'sqlite',
  redisUrl: string,
  sqlitePath: string
): Promise<Store> {
  if (backend === 'redis') {
    const store = new RedisStore(redisUrl);
    await store.connect();
    const shutdown = () => { void store.disconnect(); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return store;
  } else {
    return new SqliteStore(sqlitePath);
  }
}
