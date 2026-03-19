"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function requireEnv(name) {
    const value = process.env[name];
    if (!value || value.trim() === '') {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value.trim();
}
function optionalInt(name, defaultValue) {
    const raw = process.env[name];
    if (!raw)
        return defaultValue;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed <= 0) {
        throw new Error(`Invalid value for ${name}: must be a positive integer, got "${raw}"`);
    }
    return parsed;
}
function optionalLogLevel(name, defaultValue) {
    const raw = process.env[name];
    if (!raw)
        return defaultValue;
    const valid = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    const upper = raw.toUpperCase();
    if (!valid.includes(upper)) {
        throw new Error(`Invalid value for ${name}: must be one of ${valid.join(', ')}, got "${raw}"`);
    }
    return upper;
}
function optionalStoreBackend(name, defaultValue) {
    const raw = process.env[name];
    if (!raw)
        return defaultValue;
    if (raw !== 'redis' && raw !== 'sqlite') {
        throw new Error(`Invalid value for ${name}: must be 'redis' or 'sqlite', got "${raw}"`);
    }
    return raw;
}
function loadConfig() {
    const whatsappVerifyToken = requireEnv('WHATSAPP_VERIFY_TOKEN');
    const whatsappAppSecret = requireEnv('WHATSAPP_APP_SECRET');
    const whatsappApiToken = requireEnv('WHATSAPP_API_TOKEN');
    const whatsappPhoneNumberId = requireEnv('WHATSAPP_PHONE_NUMBER_ID');
    const config = {
        whatsappVerifyToken,
        whatsappAppSecret,
        whatsappApiToken,
        whatsappPhoneNumberId,
        storeBackend: optionalStoreBackend('STORE_BACKEND', 'redis'),
        redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
        sqlitePath: process.env['SQLITE_PATH'] ?? './whatsapp.db',
        idempotencyTtlSeconds: optionalInt('IDEMPOTENCY_TTL_SECONDS', 86400),
        rateLimitGlobalInbound: optionalInt('RATE_LIMIT_GLOBAL_INBOUND', 1000),
        rateLimitPerUser: optionalInt('RATE_LIMIT_PER_USER', 10),
        rateLimitOutbound: optionalInt('RATE_LIMIT_OUTBOUND', 100),
        rateLimitWindowSeconds: optionalInt('RATE_LIMIT_WINDOW_SECONDS', 60),
        webhookTimeoutSeconds: optionalInt('WEBHOOK_TIMEOUT_SECONDS', 5),
        outboundTimeoutSeconds: optionalInt('OUTBOUND_TIMEOUT_SECONDS', 10),
        logLevel: optionalLogLevel('LOG_LEVEL', 'INFO'),
        logMaxPayloadBytes: optionalInt('LOG_MAX_PAYLOAD_BYTES', 2048),
        port: optionalInt('PORT', 8000),
    };
    return Object.freeze(config);
}
