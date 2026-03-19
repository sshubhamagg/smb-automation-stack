"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initIdempotency = initIdempotency;
exports.buildKey = buildKey;
exports.checkAndLock = checkAndLock;
exports.writeOutput = writeOutput;
const logger_1 = require("./logger");
let _store = null;
let _ttl = 86400;
function initIdempotency(store, ttlSeconds) {
    _store = store;
    _ttl = ttlSeconds;
}
function buildKey(messageId) {
    return `idempotency:${messageId}`;
}
async function checkAndLock(messageId) {
    if (!_store) {
        return { isNew: true, cachedOutput: null };
    }
    try {
        const key = buildKey(messageId);
        const isNew = await _store.setnx(key, 'processing', _ttl);
        if (isNew) {
            return { isNew: true, cachedOutput: null };
        }
        const existing = await _store.get(key);
        if (existing === null || existing === 'processing') {
            return { isNew: false, cachedOutput: null };
        }
        try {
            const parsed = JSON.parse(existing);
            return { isNew: false, cachedOutput: parsed };
        }
        catch {
            return { isNew: false, cachedOutput: null };
        }
    }
    catch (err) {
        (0, logger_1.log)({
            level: 'WARN',
            status: 'idempotency_store_error',
            correlationId: messageId,
            direction: 'inbound',
            error: err instanceof Error ? err.message : String(err),
        });
        return { isNew: true, cachedOutput: null };
    }
}
async function writeOutput(messageId, output) {
    if (!_store)
        return;
    try {
        const key = buildKey(messageId);
        await _store.set(key, JSON.stringify(output), _ttl);
    }
    catch {
        // Silently continue — caller handles
    }
}
