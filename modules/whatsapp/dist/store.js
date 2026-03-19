"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteStore = exports.RedisStore = void 0;
exports.createStore = createStore;
const redis_1 = require("redis");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
class RedisStore {
    client;
    constructor(redisUrl) {
        this.client = (0, redis_1.createClient)({ url: redisUrl });
    }
    async connect() {
        await this.client.connect();
    }
    async get(key) {
        return this.client.get(key);
    }
    async setnx(key, value, ttl) {
        const result = await this.client.set(key, value, { NX: true, EX: ttl });
        return result === 'OK';
    }
    async set(key, value, ttl) {
        await this.client.set(key, value, { EX: ttl });
    }
    async incr(key, ttlIfNew) {
        const count = await this.client.incr(key);
        if (count === 1) {
            await this.client.expire(key, ttlIfNew);
        }
        return count;
    }
    async ping() {
        try {
            const result = await this.client.ping();
            return result === 'PONG';
        }
        catch {
            return false;
        }
    }
    async disconnect() {
        await this.client.disconnect();
    }
}
exports.RedisStore = RedisStore;
class SqliteStore {
    db;
    constructor(sqlitePath) {
        this.db = new better_sqlite3_1.default(sqlitePath);
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    }
    pruneExpired(key) {
        this.db.prepare('DELETE FROM store WHERE key = ? AND expires_at <= ?').run(key, Date.now());
    }
    async get(key) {
        this.pruneExpired(key);
        const row = this.db
            .prepare('SELECT value FROM store WHERE key = ? AND expires_at > ?')
            .get(key, Date.now());
        return row?.value ?? null;
    }
    async setnx(key, value, ttl) {
        const expiresAt = Date.now() + ttl * 1000;
        try {
            const transact = this.db.transaction(() => {
                this.db.prepare('DELETE FROM store WHERE key = ? AND expires_at <= ?').run(key, Date.now());
                const result = this.db
                    .prepare('INSERT OR IGNORE INTO store (key, value, expires_at) VALUES (?, ?, ?)')
                    .run(key, value, expiresAt);
                return result.changes === 1;
            });
            return transact();
        }
        catch {
            return false;
        }
    }
    async set(key, value, ttl) {
        const expiresAt = Date.now() + ttl * 1000;
        this.db
            .prepare('INSERT OR REPLACE INTO store (key, value, expires_at) VALUES (?, ?, ?)')
            .run(key, value, expiresAt);
    }
    async incr(key, ttlIfNew) {
        const expiresAt = Date.now() + ttlIfNew * 1000;
        const transact = this.db.transaction(() => {
            const existing = this.db
                .prepare('SELECT value, expires_at FROM store WHERE key = ? AND expires_at > ?')
                .get(key, Date.now());
            if (existing) {
                const newVal = parseInt(existing.value, 10) + 1;
                this.db
                    .prepare('UPDATE store SET value = ? WHERE key = ?')
                    .run(String(newVal), key);
                return newVal;
            }
            else {
                this.db
                    .prepare('INSERT OR REPLACE INTO store (key, value, expires_at) VALUES (?, ?, ?)')
                    .run(key, '1', expiresAt);
                return 1;
            }
        });
        return transact();
    }
    async ping() {
        try {
            this.db.prepare('SELECT 1').get();
            return true;
        }
        catch {
            return false;
        }
    }
    async disconnect() {
        this.db.close();
    }
}
exports.SqliteStore = SqliteStore;
async function createStore(backend, redisUrl, sqlitePath) {
    if (backend === 'redis') {
        const store = new RedisStore(redisUrl);
        await store.connect();
        return store;
    }
    else {
        return new SqliteStore(sqlitePath);
    }
}
