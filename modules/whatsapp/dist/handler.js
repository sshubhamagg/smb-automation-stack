"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initHandler = initHandler;
exports.buildErrorResponse = buildErrorResponse;
exports.handleVerification = handleVerification;
exports.handleHealth = handleHealth;
exports.handleSend = handleSend;
exports.handleInbound = handleInbound;
const node_crypto_1 = require("node:crypto");
const logger_1 = require("./logger");
const validator_1 = require("./validator");
const normalizer_1 = require("./normalizer");
const idempotency_1 = require("./idempotency");
const rateLimiter_1 = require("./rateLimiter");
const outbound_1 = require("./outbound");
let _config = null;
let _store = null;
function initHandler(config, store) {
    _config = config;
    _store = store;
}
function buildErrorResponse(code, message, correlationId, details) {
    const resp = {
        error: true,
        code,
        message,
        correlation_id: correlationId,
    };
    if (details)
        resp.details = details;
    return resp;
}
async function handleVerification(request, reply) {
    const config = _config;
    const query = request.query;
    const hubMode = query['hub.mode'];
    const hubVerifyToken = query['hub.verify_token'];
    const hubChallenge = query['hub.challenge'];
    if (hubMode === 'subscribe' && hubVerifyToken === config.whatsappVerifyToken) {
        await reply.status(200).send(hubChallenge);
    }
    else {
        await reply.status(403).send({ error: true, code: 'FORBIDDEN', message: 'Invalid verify token' });
    }
}
async function handleHealth(_request, reply) {
    const store = _store;
    let storePingOk = false;
    try {
        storePingOk = await store.ping();
    }
    catch {
        storePingOk = false;
    }
    const storeStatus = storePingOk ? 'ok' : 'unreachable';
    const overallStatus = storePingOk ? 'ok' : 'degraded';
    await reply.status(200).send({
        status: overallStatus,
        service: 'ok',
        store: storeStatus,
        timestamp: new Date().toISOString(),
    });
}
async function handleSend(request, reply) {
    const config = _config;
    const body = request.body;
    const correlationId = body?.['correlationId'] ?? (0, node_crypto_1.randomUUID)();
    let validated;
    try {
        validated = (0, validator_1.validateOutbound)(body);
    }
    catch (err) {
        if (err instanceof validator_1.ValidationError) {
            await reply.status(400).send(buildErrorResponse(err.code, err.message, correlationId, err.field ? { field: err.field } : undefined));
            return;
        }
        await reply.status(400).send(buildErrorResponse('INVALID_PAYLOAD', 'Invalid request body', correlationId));
        return;
    }
    const outboundCheck = await (0, rateLimiter_1.checkGlobalOutbound)();
    if (!outboundCheck.allowed) {
        await reply.status(429).send(buildErrorResponse('RATE_LIMIT_EXCEEDED', 'Global outbound rate limit exceeded', correlationId, {
            retry_after_seconds: outboundCheck.retryAfter,
        }));
        return;
    }
    const result = await (0, outbound_1.sendMessage)(validated.recipient, validated.text, validated.correlationId, config);
    if (result.status === 'accepted') {
        await reply.status(200).send(result);
    }
    else if (result.status === 'throttled') {
        await reply.status(429).send(result);
    }
    else {
        await reply.status(502).send(result);
    }
}
async function handleInbound(request, reply) {
    const config = _config;
    const handlerCorrelationId = (0, node_crypto_1.randomUUID)();
    let idempotencyWriteComplete = false;
    const pipeline = (async () => {
        // Step a: global inbound rate limit
        const globalCheck = await (0, rateLimiter_1.checkGlobalInbound)();
        if (!globalCheck.allowed) {
            await reply.status(429).send(buildErrorResponse('RATE_LIMIT_EXCEEDED', 'Global inbound rate limit exceeded', handlerCorrelationId, {
                retry_after_seconds: globalCheck.retryAfter,
            }));
            return 'done';
        }
        // Step b: verify signature
        const rawBodyValue = request.rawBody;
        if (!rawBodyValue) {
            await reply.status(400).send(buildErrorResponse('INVALID_PAYLOAD', 'Missing raw body', handlerCorrelationId));
            return 'done';
        }
        const rawBody = Buffer.isBuffer(rawBodyValue)
            ? rawBodyValue
            : Buffer.from(rawBodyValue);
        const sigHeader = request.headers['x-hub-signature-256'] ?? '';
        const sigValid = (0, validator_1.verifySignature)(rawBody, sigHeader, config.whatsappAppSecret);
        if (!sigValid) {
            (0, logger_1.log)({
                level: 'WARN',
                status: 'signature_invalid',
                correlationId: handlerCorrelationId,
                direction: 'inbound',
            });
            await reply.status(401).send(buildErrorResponse('SIGNATURE_INVALID', 'Invalid webhook signature', handlerCorrelationId));
            return 'done';
        }
        // Step c: validate inbound payload
        let validated;
        try {
            validated = (0, validator_1.validateInbound)(request.body);
        }
        catch (err) {
            if (err instanceof validator_1.ValidationError) {
                await reply.status(400).send(buildErrorResponse(err.code, err.message, handlerCorrelationId, err.field ? { field: err.field } : undefined));
                return 'done';
            }
            await reply.status(400).send(buildErrorResponse('INVALID_PAYLOAD', 'Invalid webhook payload', handlerCorrelationId));
            return 'done';
        }
        // Status update case (null return = no messages)
        if (validated === null) {
            await reply.status(200).send({ status: 'ok' });
            return 'done';
        }
        // Step d: log ignored messages (messages[1+])
        const rawMessages = request.body?.['entry'];
        const allMessages = rawMessages?.[0]?.['changes'];
        const messagesArray = allMessages?.[0]?.['value']?.['messages'];
        if (Array.isArray(messagesArray) && messagesArray.length > 1) {
            for (let i = 1; i < messagesArray.length; i++) {
                const msg = messagesArray[i];
                const ignoredId = typeof msg['id'] === 'string' ? msg['id'] : `unknown-${i}`;
                (0, logger_1.log)({
                    level: 'INFO',
                    status: 'ignored',
                    messageId: ignoredId,
                    correlationId: handlerCorrelationId,
                    direction: 'inbound',
                });
            }
        }
        // Step e: per-user rate limit
        const userPhone = (0, normalizer_1.toE164)(validated.from);
        const userCheck = await (0, rateLimiter_1.checkPerUser)(userPhone);
        if (!userCheck.allowed) {
            await reply.status(429).send(buildErrorResponse('RATE_LIMIT_EXCEEDED', 'Per-user rate limit exceeded', handlerCorrelationId, {
                retry_after_seconds: userCheck.retryAfter,
            }));
            return 'done';
        }
        // Step f: idempotency check
        const { isNew, cachedOutput } = await (0, idempotency_1.checkAndLock)(validated.messageId);
        if (!isNew) {
            const responseBody = cachedOutput
                ? { ...cachedOutput, status: 'duplicate' }
                : { status: 'duplicate', message_id: validated.messageId };
            (0, logger_1.log)({
                level: 'INFO',
                status: 'duplicate',
                messageId: validated.messageId,
                correlationId: handlerCorrelationId,
                direction: 'inbound',
            });
            await reply.status(200).send(responseBody);
            return 'done';
        }
        // Step g: normalize
        const normalized = (0, normalizer_1.normalize)(validated);
        // Use the handler-level correlationId for consistency in logs
        const normalizedWithCorrelation = { ...normalized, correlation_id: handlerCorrelationId };
        // Step h: write output to idempotency store
        await (0, idempotency_1.writeOutput)(validated.messageId, normalizedWithCorrelation);
        idempotencyWriteComplete = true;
        // Step i: reply with normalized output
        (0, logger_1.log)({
            level: 'INFO',
            status: 'received',
            messageId: validated.messageId,
            correlationId: handlerCorrelationId,
            userId: userPhone,
            direction: 'inbound',
            normalizedOutput: normalizedWithCorrelation,
        });
        await reply.status(200).send(normalizedWithCorrelation);
        return 'done';
    })();
    const timeoutMs = config.webhookTimeoutSeconds * 1000;
    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), timeoutMs);
    });
    const raceResult = await Promise.race([pipeline, timeoutPromise]);
    if (raceResult === 'TIMEOUT') {
        const status = idempotencyWriteComplete ? 'timeout' : 'timeout_unsafe';
        (0, logger_1.log)({
            level: 'WARN',
            status,
            correlationId: handlerCorrelationId,
            direction: 'inbound',
        });
        if (!reply.sent) {
            await reply.status(200).send({ status });
        }
    }
}
