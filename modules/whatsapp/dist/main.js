"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildApp = buildApp;
exports.start = start;
const fastify_1 = __importDefault(require("fastify"));
const fastify_raw_body_1 = __importDefault(require("fastify-raw-body"));
const config_1 = require("./config");
const store_1 = require("./store");
const logger_1 = require("./logger");
const idempotency_1 = require("./idempotency");
const rateLimiter_1 = require("./rateLimiter");
const handler_1 = require("./handler");
async function buildApp(config, store) {
    (0, logger_1.initLogger)(config);
    (0, idempotency_1.initIdempotency)(store, config.idempotencyTtlSeconds);
    (0, rateLimiter_1.initRateLimiter)(store, config);
    (0, handler_1.initHandler)(config, store);
    const app = (0, fastify_1.default)({ logger: false });
    await app.register(fastify_raw_body_1.default, {
        field: 'rawBody',
        global: true,
        encoding: false,
        runFirst: true,
    });
    app.post('/webhook', handler_1.handleInbound);
    app.get('/webhook', handler_1.handleVerification);
    app.post('/send', handler_1.handleSend);
    app.get('/health', handler_1.handleHealth);
    return app;
}
async function start() {
    const config = (0, config_1.loadConfig)();
    const store = await (0, store_1.createStore)(config.storeBackend, config.redisUrl, config.sqlitePath);
    const app = await buildApp(config, store);
    process.on('SIGTERM', async () => {
        process.stdout.write(JSON.stringify({ level: 'INFO', message: 'Shutting down...' }) + '\n');
        await store.disconnect();
        process.exit(0);
    });
    process.on('SIGINT', async () => {
        process.stdout.write(JSON.stringify({ level: 'INFO', message: 'Shutting down...' }) + '\n');
        await store.disconnect();
        process.exit(0);
    });
    await app.listen({ port: config.port, host: '0.0.0.0' });
    process.stdout.write(JSON.stringify({
        level: 'INFO',
        message: 'WhatsApp module started',
        port: config.port,
        storeBackend: config.storeBackend,
    }) + '\n');
}
if (require.main === module) {
    start().catch((err) => {
        process.stderr.write(JSON.stringify({ level: 'ERROR', message: String(err) }) + '\n');
        process.exit(1);
    });
}
