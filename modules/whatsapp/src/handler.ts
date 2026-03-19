import { randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from './config';
import type { Store } from './store';
import { log } from './logger';
import { verifySignature, validateInbound, validateOutbound, ValidationError } from './validator';
import { normalize, toE164 } from './normalizer';
import { checkAndLock, writeOutput } from './idempotency';
import { checkGlobalInbound, checkPerUser, checkGlobalOutbound } from './rateLimiter';
import { sendMessage } from './outbound';

let _config: Config | null = null;
let _store: Store | null = null;

export function initHandler(config: Config, store: Store): void {
  _config = config;
  _store = store;
}

export interface ErrorResponse {
  error: true;
  code: string;
  message: string;
  correlation_id: string;
  message_id?: string;
  details?: Record<string, unknown>;
}

export function buildErrorResponse(
  code: string,
  message: string,
  correlationId: string,
  details?: Record<string, unknown>
): ErrorResponse {
  const resp: ErrorResponse = {
    error: true,
    code,
    message,
    correlation_id: correlationId,
  };
  if (details) resp.details = details;
  return resp;
}

export async function handleVerification(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const config = _config!;
  const query = request.query as Record<string, string>;
  const hubMode = query['hub.mode'];
  const hubVerifyToken = query['hub.verify_token'];
  const hubChallenge = query['hub.challenge'];

  if (hubMode === 'subscribe' && hubVerifyToken === config.whatsappVerifyToken) {
    await reply.status(200).send(hubChallenge);
  } else {
    await reply.status(403).send({ error: true, code: 'FORBIDDEN', message: 'Invalid verify token' });
  }
}

export async function handleHealth(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const store = _store!;
  let storePingOk = false;

  try {
    storePingOk = await store.ping();
  } catch {
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

export async function handleSend(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const config = _config!;
  const body = request.body as Record<string, unknown> | null | undefined;
  const correlationId = (body?.['correlationId'] as string | undefined) ?? randomUUID();

  let validated: ReturnType<typeof validateOutbound>;
  try {
    validated = validateOutbound(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      await reply.status(400).send(
        buildErrorResponse(err.code, err.message, correlationId, err.field ? { field: err.field } : undefined)
      );
      return;
    }
    await reply.status(400).send(
      buildErrorResponse('INVALID_PAYLOAD', 'Invalid request body', correlationId)
    );
    return;
  }

  const outboundCheck = await checkGlobalOutbound();
  if (!outboundCheck.allowed) {
    await reply.status(429).send(
      buildErrorResponse('RATE_LIMIT_EXCEEDED', 'Global outbound rate limit exceeded', correlationId, {
        retry_after_seconds: outboundCheck.retryAfter,
      })
    );
    return;
  }

  const result = await sendMessage(validated.recipient, validated.text, validated.correlationId, config);

  if (result.status === 'accepted') {
    await reply.status(200).send(result);
  } else if (result.status === 'throttled') {
    await reply.status(429).send(result);
  } else {
    await reply.status(502).send(result);
  }
}

export async function handleInbound(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const config = _config!;
  const handlerCorrelationId = randomUUID();
  let idempotencyWriteComplete = false;

  const pipeline = (async () => {
    // Step a: global inbound rate limit
    const globalCheck = await checkGlobalInbound();
    if (!globalCheck.allowed) {
      await reply.status(429).send(
        buildErrorResponse('RATE_LIMIT_EXCEEDED', 'Global inbound rate limit exceeded', handlerCorrelationId, {
          retry_after_seconds: globalCheck.retryAfter,
        })
      );
      return 'done';
    }

    // Step b: verify signature
    const rawBodyValue = request.rawBody;
    if (!rawBodyValue) {
      await reply.status(400).send(
        buildErrorResponse('INVALID_PAYLOAD', 'Missing raw body', handlerCorrelationId)
      );
      return 'done';
    }
    const rawBody: Buffer = Buffer.isBuffer(rawBodyValue)
      ? rawBodyValue
      : Buffer.from(rawBodyValue as string);
    const sigHeader = (request.headers['x-hub-signature-256'] as string | undefined) ?? '';
    const sigValid = verifySignature(rawBody, sigHeader, config.whatsappAppSecret);
    if (!sigValid) {
      log({
        level: 'WARN',
        status: 'signature_invalid',
        correlationId: handlerCorrelationId,
        direction: 'inbound',
      });
      await reply.status(401).send(
        buildErrorResponse('SIGNATURE_INVALID', 'Invalid webhook signature', handlerCorrelationId)
      );
      return 'done';
    }

    // Step c: validate inbound payload
    let validated: ReturnType<typeof validateInbound>;
    try {
      validated = validateInbound(request.body);
    } catch (err) {
      if (err instanceof ValidationError) {
        await reply.status(400).send(
          buildErrorResponse(err.code, err.message, handlerCorrelationId, err.field ? { field: err.field } : undefined)
        );
        return 'done';
      }
      await reply.status(400).send(
        buildErrorResponse('INVALID_PAYLOAD', 'Invalid webhook payload', handlerCorrelationId)
      );
      return 'done';
    }

    // Status update case (null return = no messages)
    if (validated === null) {
      await reply.status(200).send({ status: 'ok' });
      return 'done';
    }

    // Step d: log ignored messages (messages[1+])
    const rawMessages = (request.body as Record<string, unknown> | null)?.['entry'] as unknown[] | undefined;
    const allMessages = (rawMessages?.[0] as Record<string, unknown> | undefined)?.['changes'] as unknown[] | undefined;
    const messagesArray = ((allMessages?.[0] as Record<string, unknown> | undefined)?.['value'] as Record<string, unknown> | undefined)?.['messages'] as unknown[] | undefined;

    if (Array.isArray(messagesArray) && messagesArray.length > 1) {
      for (let i = 1; i < messagesArray.length; i++) {
        const msg = messagesArray[i] as Record<string, unknown>;
        const ignoredId = typeof msg['id'] === 'string' ? msg['id'] : `unknown-${i}`;
        log({
          level: 'INFO',
          status: 'ignored',
          messageId: ignoredId,
          correlationId: handlerCorrelationId,
          direction: 'inbound',
        });
      }
    }

    // Step e: per-user rate limit
    const userPhone = toE164(validated.from);
    const userCheck = await checkPerUser(userPhone);
    if (!userCheck.allowed) {
      await reply.status(429).send(
        buildErrorResponse('RATE_LIMIT_EXCEEDED', 'Per-user rate limit exceeded', handlerCorrelationId, {
          retry_after_seconds: userCheck.retryAfter,
        })
      );
      return 'done';
    }

    // Step f: idempotency check
    const { isNew, cachedOutput } = await checkAndLock(validated.messageId);
    if (!isNew) {
      const responseBody = cachedOutput
        ? { ...cachedOutput, status: 'duplicate' as const }
        : { status: 'duplicate' as const, message_id: validated.messageId };

      log({
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
    const normalized = normalize(validated);
    // Use the handler-level correlationId for consistency in logs
    const normalizedWithCorrelation = { ...normalized, correlation_id: handlerCorrelationId };

    // Step h: write output to idempotency store
    await writeOutput(validated.messageId, normalizedWithCorrelation);
    idempotencyWriteComplete = true;

    // Step i: reply with normalized output
    log({
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
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<'TIMEOUT'>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('TIMEOUT'), timeoutMs);
  });

  let raceResult: 'done' | 'TIMEOUT' = 'done';
  try {
    raceResult = await Promise.race([pipeline, timeoutPromise]) as 'done' | 'TIMEOUT';
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (raceResult === 'TIMEOUT') {
    const status = idempotencyWriteComplete ? 'timeout' : 'timeout_unsafe';
    log({
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
