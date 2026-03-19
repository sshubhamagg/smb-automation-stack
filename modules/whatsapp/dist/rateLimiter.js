"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initRateLimiter = initRateLimiter;
exports.buildKey = buildKey;
exports.checkGlobalInbound = checkGlobalInbound;
exports.checkPerUser = checkPerUser;
exports.checkGlobalOutbound = checkGlobalOutbound;
const logger_1 = require("./logger");
let _store = null;
let _config = {
    globalInbound: 1000,
    perUser: 10,
    outbound: 100,
    windowSeconds: 60,
};
function initRateLimiter(store, config) {
    _store = store;
    _config = {
        globalInbound: config.rateLimitGlobalInbound,
        perUser: config.rateLimitPerUser,
        outbound: config.rateLimitOutbound,
        windowSeconds: config.rateLimitWindowSeconds,
    };
}
function buildKey(tier, identifier) {
    return `ratelimit:${tier}:${identifier}`;
}
async function check(key, limit, correlationId) {
    if (!_store) {
        return { allowed: true, retryAfter: 0 };
    }
    try {
        const count = await _store.incr(key, _config.windowSeconds);
        if (count > limit) {
            return { allowed: false, retryAfter: _config.windowSeconds };
        }
        return { allowed: true, retryAfter: 0 };
    }
    catch (err) {
        (0, logger_1.log)({
            level: 'WARN',
            status: 'rate_limiter_store_error',
            correlationId,
            direction: 'inbound',
            error: err instanceof Error ? err.message : String(err),
        });
        return { allowed: true, retryAfter: 0 };
    }
}
async function checkGlobalInbound() {
    const key = buildKey('inbound', 'global');
    return check(key, _config.globalInbound, 'global-inbound');
}
async function checkPerUser(phoneE164) {
    const key = buildKey('inbound', phoneE164);
    return check(key, _config.perUser, phoneE164);
}
async function checkGlobalOutbound() {
    const key = buildKey('outbound', 'global');
    return check(key, _config.outbound, 'global-outbound');
}
