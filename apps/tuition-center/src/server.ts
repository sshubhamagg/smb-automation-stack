import 'dotenv/config';
import express, { Request, Response } from 'express';
import { receive } from 'ingestion-module';
import { handleTeacherMessage, handleFeeInit, handleFeeReminders } from './handler';

const PORT         = parseInt(process.env['PORT'] ?? '3003', 10);
const VERIFY_TOKEN = process.env['WEBHOOK_VERIFY_TOKEN'] ?? '';

// ---------------------------------------------------------------------------
// Cron: monthly fee initialization — 1st of month at 08:00
// ---------------------------------------------------------------------------

function scheduleMonthlyFeeInit(): void {
  function msUntilNext1stAt8am(): number {
    const now  = new Date();
    const next = new Date(now);
    next.setDate(1);
    next.setHours(8, 0, 0, 0);
    // If 1st is in the past this month, advance to next month
    if (next <= now) {
      next.setMonth(next.getMonth() + 1);
      next.setDate(1);
      next.setHours(8, 0, 0, 0);
    }
    return next.getTime() - now.getTime();
  }

  function scheduleNext(): void {
    const delay = msUntilNext1stAt8am();
    console.log(`[tuition] Next fee-init in ${Math.round(delay / 60000)}m`);
    setTimeout(async () => {
      await handleFeeInit().catch((err: unknown) => {
        console.error('[tuition] Cron fee-init error:', err instanceof Error ? err.message : err);
      });
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

// ---------------------------------------------------------------------------
// Cron: daily fee reminders at 09:00
// ---------------------------------------------------------------------------

function scheduleDailyReminders(): void {
  function msUntilNext9am(): number {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  function scheduleNext(): void {
    const delay = msUntilNext9am();
    console.log(`[tuition] Next reminder in ${Math.round(delay / 60000)}m`);
    setTimeout(async () => {
      await handleFeeReminders().catch((err: unknown) => {
        console.error('[tuition] Cron reminder error:', err instanceof Error ? err.message : err);
      });
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// ── GET /webhook — Meta webhook verification ──────────────────────────────

app.get('/webhook', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[tuition] Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.warn('[tuition] Webhook verification failed');
    res.sendStatus(403);
  }
});

// ── POST /webhook — Incoming WhatsApp messages ────────────────────────────

app.post('/webhook', (req: Request, res: Response) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const result = await receive({ source: 'whatsapp', provider: 'meta', payload: req.body });

      if (!result.ok) {
        if (result.reason === 'status_update') return;
        console.log('[tuition] Skipping:', result.reason);
        return;
      }

      const { userId, message } = result.event;
      if (!message) { console.log('[tuition] Non-text event from', userId); return; }

      console.log('[tuition] Inbound from', userId);
      await handleTeacherMessage({ phone_number: userId, text_body: message, message_type: 'text' });
    } catch (err) {
      console.error('[tuition] Webhook error:', err instanceof Error ? err.message : err);
    }
  });
});

// ── POST /run/fee-init — Manual trigger for monthly fee initialization ────

app.post('/run/fee-init', (_req: Request, res: Response) => {
  res.json({ status: 'triggered' });

  setImmediate(async () => {
    await handleFeeInit().catch((err: unknown) => {
      console.error('[tuition] Manual fee-init error:', err instanceof Error ? err.message : err);
    });
  });
});

// ── POST /run/reminders — Manual trigger for fee reminders ───────────────

app.post('/run/reminders', (_req: Request, res: Response) => {
  res.json({ status: 'triggered' });

  setImmediate(async () => {
    await handleFeeReminders().catch((err: unknown) => {
      console.error('[tuition] Manual reminder error:', err instanceof Error ? err.message : err);
    });
  });
});

// ── GET /health ───────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', app: 'tuition-center' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[tuition] Running on port ${PORT}`);
  scheduleMonthlyFeeInit();
  scheduleDailyReminders();
});
