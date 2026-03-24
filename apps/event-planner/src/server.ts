import 'dotenv/config';
import express, { Request, Response } from 'express';
import { receive } from 'ingestion-module';
import { handlePlannerMessage, handleReminders } from './handler';

const PORT         = parseInt(process.env['PORT'] ?? '3002', 10);
const VERIFY_TOKEN = process.env['WEBHOOK_VERIFY_TOKEN'] ?? '';

// ---------------------------------------------------------------------------
// Cron: daily reminders at 09:00 local time
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
    console.log(`[event-planner] Next reminder in ${Math.round(delay / 60000)}m`);
    setTimeout(async () => {
      await handleReminders().catch((err: unknown) => {
        console.error('[event-planner] Cron reminder error:', err instanceof Error ? err.message : err);
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

// ── GET /webhook — Meta webhook verification ─────────────────────────────

app.get('/webhook', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[event-planner] Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.warn('[event-planner] Webhook verification failed');
    res.sendStatus(403);
  }
});

// ── POST /webhook — Incoming WhatsApp messages ───────────────────────────

app.post('/webhook', (req: Request, res: Response) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const result = await receive({ source: 'whatsapp', provider: 'meta', payload: req.body });

      if (!result.ok) {
        if (result.reason === 'status_update') return;
        console.log('[event-planner] Skipping:', result.reason);
        return;
      }

      const { userId, message } = result.event;
      if (!message) { console.log('[event-planner] Non-text event from', userId); return; }

      console.log('[event-planner] Inbound from', userId);
      await handlePlannerMessage({ phone_number: userId, text_body: message, message_type: 'text' });
    } catch (err) {
      console.error('[event-planner] Webhook error:', err instanceof Error ? err.message : err);
    }
  });
});

// ── POST /run/reminders — Manual reminder trigger ────────────────────────

app.post('/run/reminders', (_req: Request, res: Response) => {
  res.json({ status: 'triggered' });

  setImmediate(async () => {
    await handleReminders().catch((err: unknown) => {
      console.error('[event-planner] Manual reminder error:', err instanceof Error ? err.message : err);
    });
  });
});

// ── GET /health ──────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', app: 'event-planner' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[event-planner] Running on port ${PORT}`);
  scheduleDailyReminders();
});
