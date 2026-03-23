import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express, { Request, Response } from 'express';
import cron from 'node-cron';
import { runFlow } from 'engine-module';
import type { ExecutionContext, Modules } from 'engine-module';
import { execute as storageExecute } from 'storage-module';
import { execute as commExecute } from 'communication-module';
import { run as intelligenceRun } from 'intelligence-module';
import { receive } from 'ingestion-module';

import { handleMiningReport } from '../../../flows/mining-reporting/src/handler';
import { dailySummaryFlow } from '../../../flows/daily-summary/src/flow';
import { missedReportsFlow } from '../../../flows/missed-reports/src/flow';

const PORT = process.env['PORT'] ?? '3000';
const VERIFY_TOKEN = process.env['WEBHOOK_VERIFY_TOKEN'] ?? '';
const OWNER_PHONE = process.env['OWNER_PHONE'] ?? '';
const SHEET_ID = process.env['SHEET_ID'] ?? '';

const managersPath = path.resolve(__dirname, '../../../flows/config/managers.json');
const MANAGERS_CONFIG = JSON.parse(fs.readFileSync(managersPath, 'utf-8')) as Record<
  string,
  { mines: string[]; ownerPhone: string; sheetId: string }
>;
const MANAGERS: Record<string, string[]> = Object.fromEntries(
  Object.entries(MANAGERS_CONFIG).map(([phone, cfg]) => [phone, cfg.mines]),
);

const modules: Modules = {
  storage: (input) => storageExecute(input as Parameters<typeof storageExecute>[0]),
  communication: (input) => commExecute(input as { to: string; message: string }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intelligence: (input) => intelligenceRun(input as any),
};

let isRunningDailySummary = false;
let isRunningMissedReports = false;
let lastExecutionTime = 0;
const MIN_INTERVAL_MS = 2000;

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastExecutionTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise(res => setTimeout(res, MIN_INTERVAL_MS - elapsed));
  }
  lastExecutionTime = Date.now();
}

const executionRegistry = new Map<string, boolean>();

function getTodayKey(flowName: string): string {
  return `${flowName}:${new Date().toISOString().slice(0, 10)}`;
}

async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 2000): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.error(`[retry] Attempt ${i + 1} failed`, err);
      if (i < attempts - 1) await new Promise(res => setTimeout(res, delayMs));
    }
  }
  throw lastError;
}

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Scheduled flow runners
// ---------------------------------------------------------------------------

async function runDailySummary(): Promise<void> {
  const key = getTodayKey('daily-summary');
  if (executionRegistry.has(key)) { console.log('[skip] daily-summary already ran today'); return; }
  if (isRunningDailySummary) { console.log('[skip] daily-summary already running'); return; }
  isRunningDailySummary = true;
  try {
    const ctx: ExecutionContext = {
      event: {},
      state: { config: { ownerPhone: OWNER_PHONE, sheetId: SHEET_ID } },
    };
    await throttle();
    const result = await retry(() => runFlow(dailySummaryFlow, ctx, modules));
    console.log('[daily-summary] result:', result.ok);
    executionRegistry.set(key, true);
  } finally {
    isRunningDailySummary = false;
  }
}

async function runMissedReports(): Promise<void> {
  const key = getTodayKey('missed-reports');
  if (executionRegistry.has(key)) { console.log('[skip] missed-reports already ran today'); return; }
  if (isRunningMissedReports) { console.log('[skip] missed-reports already running'); return; }
  isRunningMissedReports = true;
  try {
    const ctx: ExecutionContext = {
      event: {},
      state: { config: { ownerPhone: OWNER_PHONE, sheetId: SHEET_ID, managers: MANAGERS } },
    };
    await throttle();
    const result = await retry(() => runFlow(missedReportsFlow, ctx, modules));
    console.log('[missed-reports] result:', result.ok);
    executionRegistry.set(key, true);
  } finally {
    isRunningMissedReports = false;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[mining] Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.warn('[mining] Webhook verification failed');
    res.sendStatus(403);
  }
});

app.post('/webhook', (req: Request, res: Response) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const result = await receive({ source: 'whatsapp', provider: 'meta', payload: req.body });
      if (!result.ok) {
        if (result.reason === 'status_update') return;
        console.log('[mining] Skipping:', result.reason);
        return;
      }
      const { userId, message, metadata } = result.event;
      if (!message) { console.log('[mining] Non-text event from', userId); return; }
      const phone = `whatsapp:${userId}`;
      const messageId = metadata?.messageId ?? '';
      console.log('[mining] Inbound from', phone);
      await handleMiningReport({ userId: phone, message, messageId } as Parameters<typeof handleMiningReport>[0]);
    } catch (err) {
      console.error('[mining] Webhook error:', err instanceof Error ? err.message : err);
    }
  });
});

app.post('/run/daily-summary', async (_req: Request, res: Response) => {
  if (!OWNER_PHONE || !SHEET_ID) { res.status(500).json({ ok: false, error: 'Missing env vars' }); return; }
  await runDailySummary().catch((err: unknown) => console.error('[daily-summary]', err));
  res.json({ ok: true });
});

app.post('/run/missed-reports', async (_req: Request, res: Response) => {
  if (!OWNER_PHONE || !SHEET_ID) { res.status(500).json({ ok: false, error: 'Missing env vars' }); return; }
  await runMissedReports().catch((err: unknown) => console.error('[missed-reports]', err));
  res.json({ ok: true });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', app: 'mining' });
});

// ---------------------------------------------------------------------------
// Cron jobs
// ---------------------------------------------------------------------------

cron.schedule('0 18 * * *', async () => {
  console.log('[cron] missed-reports');
  await runMissedReports().catch((err: unknown) => console.error('[cron]', err));
});

cron.schedule('0 20 * * *', async () => {
  console.log('[cron] daily-summary');
  await runDailySummary().catch((err: unknown) => console.error('[cron]', err));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(Number(PORT), () => {
  console.log(`[mining] Running on port ${PORT}`);
  console.log('[mining] Crons: missed-reports@18:00 | daily-summary@20:00');
});
