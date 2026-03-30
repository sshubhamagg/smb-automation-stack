import 'dotenv/config';
import express, { Request, Response } from 'express';
import cron from 'node-cron';
import { runFlow } from 'engine-module';
import type { ExecutionContext, Modules } from 'engine-module';
import { execute as storageExecute } from 'storage-module';
import { execute as commExecute } from 'communication-module';
import { receive } from 'ingestion-module';

import { handleFieldSalesReport } from './handler';
import { missingReportEscalationFlow } from '../../../flows/field-sales/missing-report-escalation/flow';
import { dailyPerformanceSummaryFlow } from '../../../flows/field-sales/daily-performance-summary/flow';
import type { MissingReportConfig } from '../../../flows/field-sales/missing-report-escalation/flow';
import type { PerformanceSummaryConfig } from '../../../flows/field-sales/daily-performance-summary/flow';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT            = process.env['PORT']                 ?? '3001';
const VERIFY_TOKEN    = process.env['WEBHOOK_VERIFY_TOKEN'] ?? '';
const MANAGER_PHONE   = process.env['MANAGER_PHONE']        ?? '';
const MANAGER_ID      = process.env['MANAGER_ID']           ?? '';
const BROADCAST_PHONE = process.env['BROADCAST_PHONE']      ?? '';

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

const modules: Modules = {
  storage:       (input) => storageExecute(input as Parameters<typeof storageExecute>[0]),
  communication: (input) => commExecute(input as { to: string; message: string }),
};

// ---------------------------------------------------------------------------
// Concurrency locks + execution registry
// ---------------------------------------------------------------------------

let isRunningMissingReports  = false;
let isRunningDailySummary    = false;
let lastExecutionTime        = 0;
const MIN_INTERVAL_MS        = 2000;

const executionRegistry = new Map<string, boolean>();

function getTodayKey(flowName: string): string {
  return `${flowName}:${new Date().toISOString().slice(0, 10)}`;
}

async function throttle(): Promise<void> {
  const now     = Date.now();
  const elapsed = now - lastExecutionTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((res) => setTimeout(res, MIN_INTERVAL_MS - elapsed));
  }
  lastExecutionTime = Date.now();
}

async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 2000): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.error(`[retry] Attempt ${i + 1} failed`, err);
      if (i < attempts - 1) await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Scheduled flow runners
// ---------------------------------------------------------------------------

async function runMissingReports(): Promise<void> {
  const key = getTodayKey('missing-reports');
  if (executionRegistry.has(key)) { console.log('[skip] missing-reports already ran today'); return; }
  if (isRunningMissingReports) { console.log('[skip] missing-reports already running'); return; }
  isRunningMissingReports = true;
  try {
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const config: MissingReportConfig = {
      date:                  today,
      manager_phone:         MANAGER_PHONE,
      team_broadcast_phone:  BROADCAST_PHONE,
    };
    const ctx: ExecutionContext = { event: {}, state: { config } };
    await throttle();
    const result = await retry(() => runFlow(missingReportEscalationFlow, ctx, modules));
    console.log('[missing-reports] result:', result.ok);
    executionRegistry.set(key, true);
  } finally {
    isRunningMissingReports = false;
  }
}

async function runDailySummary(): Promise<void> {
  const key = getTodayKey('daily-summary');
  if (executionRegistry.has(key)) { console.log('[skip] daily-summary already ran today'); return; }
  if (isRunningDailySummary) { console.log('[skip] daily-summary already running'); return; }
  isRunningDailySummary = true;
  try {
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const repsJson = process.env['FIELD_SALES_REPS_JSON'];
    const reps = repsJson ? (JSON.parse(repsJson) as unknown[]) : [];
    const config: PerformanceSummaryConfig = {
      date:          today,
      manager_id:    MANAGER_ID,
      manager_phone: MANAGER_PHONE,
      reps:          reps as PerformanceSummaryConfig['reps'],
    };
    const ctx: ExecutionContext = { event: {}, state: { config } };
    await throttle();
    const result = await retry(() => runFlow(dailyPerformanceSummaryFlow, ctx, modules));
    console.log('[daily-summary] result:', result.ok);
    executionRegistry.set(key, true);
  } finally {
    isRunningDailySummary = false;
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// ── Webhook verification (Meta) ──────────────────────────────────────────────

app.get('/webhook', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[field-sales] Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.warn('[field-sales] Webhook verification failed');
    res.sendStatus(403);
  }
});

// ── Inbound WhatsApp messages ────────────────────────────────────────────────

app.post('/webhook', (req: Request, res: Response) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const result = await receive({ source: 'whatsapp', provider: 'meta', payload: req.body });
      if (!result.ok) {
        if (result.reason === 'status_update') return;
        console.log('[field-sales] Skipping:', result.reason);
        return;
      }
      const { userId, message } = result.event;
      if (!message) { console.log('[field-sales] Non-text event from', userId); return; }
      console.log('[field-sales] Inbound from', userId);
      await handleFieldSalesReport({ message, user: userId, timestamp: Date.now() });
    } catch (err) {
      console.error('[field-sales] Webhook error:', err instanceof Error ? err.message : err);
    }
  });
});

// ── Manual triggers ──────────────────────────────────────────────────────────

app.post('/run/missing-reports', async (_req: Request, res: Response) => {
  if (!MANAGER_PHONE || !BROADCAST_PHONE) {
    res.status(500).json({ ok: false, error: 'Missing env vars: MANAGER_PHONE, BROADCAST_PHONE' });
    return;
  }
  await runMissingReports().catch((err: unknown) => console.error('[missing-reports]', err));
  res.json({ ok: true });
});

app.post('/run/daily-summary', async (_req: Request, res: Response) => {
  if (!MANAGER_PHONE || !MANAGER_ID) {
    res.status(500).json({ ok: false, error: 'Missing env vars: MANAGER_PHONE, MANAGER_ID' });
    return;
  }
  await runDailySummary().catch((err: unknown) => console.error('[daily-summary]', err));
  res.json({ ok: true });
});

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', app: 'field-sales' });
});

// ---------------------------------------------------------------------------
// Cron jobs
// ---------------------------------------------------------------------------

// 18:00 — remind reps who haven't submitted yet
cron.schedule('0 18 * * *', async () => {
  console.log('[cron] missing-reports');
  await runMissingReports().catch((err: unknown) => console.error('[cron]', err));
});

// 20:00 — send daily performance summary to manager
cron.schedule('0 20 * * *', async () => {
  console.log('[cron] daily-summary');
  await runDailySummary().catch((err: unknown) => console.error('[cron]', err));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(Number(PORT), () => {
  console.log(`[field-sales] Running on port ${PORT}`);
  console.log('[field-sales] Crons: missing-reports@18:00 | daily-summary@20:00');
});
