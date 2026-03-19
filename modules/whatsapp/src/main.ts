import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import rawBodyPlugin from 'fastify-raw-body';
import { loadConfig } from './config';
import type { Config } from './config';
import { createStore } from './store';
import type { Store } from './store';
import { initLogger } from './logger';
import { initIdempotency } from './idempotency';
import { initRateLimiter } from './rateLimiter';
import { initHandler, handleInbound, handleVerification, handleSend, handleHealth } from './handler';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string | Buffer;
  }
}

export async function buildApp(config: Config, store: Store): Promise<FastifyInstance> {
  initLogger(config);
  initIdempotency(store, config.idempotencyTtlSeconds);
  initRateLimiter(store, config);
  initHandler(config, store);

  const app = Fastify({ logger: false });

  await app.register(rawBodyPlugin, {
    field: 'rawBody',
    global: true,
    encoding: false,
    runFirst: true,
  });

  app.post('/webhook', handleInbound);
  app.get('/webhook', handleVerification);
  app.post('/send', handleSend);
  app.get('/health', handleHealth);

  return app;
}

export async function start(): Promise<void> {
  const config = loadConfig();
  const store = await createStore(config.storeBackend, config.redisUrl, config.sqlitePath);
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

  process.stdout.write(
    JSON.stringify({
      level: 'INFO',
      message: 'WhatsApp module started',
      port: config.port,
      storeBackend: config.storeBackend,
    }) + '\n'
  );
}

if (require.main === module) {
  start().catch((err: unknown) => {
    process.stderr.write(
      JSON.stringify({ level: 'ERROR', message: String(err) }) + '\n'
    );
    process.exit(1);
  });
}
