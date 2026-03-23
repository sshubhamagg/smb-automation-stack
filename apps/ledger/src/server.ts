import 'dotenv/config';
import express, { Request, Response } from 'express';
import { receive } from 'ingestion-module';
import { handleLedgerMessage } from './handler';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
const VERIFY_TOKEN = process.env['WEBHOOK_VERIFY_TOKEN'] ?? '';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// GET /webhook — Meta webhook verification
// ---------------------------------------------------------------------------

app.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[ledger] Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.warn('[ledger] Webhook verification failed');
    res.sendStatus(403);
  }
});

// ---------------------------------------------------------------------------
// POST /webhook — Incoming WhatsApp messages
// ---------------------------------------------------------------------------

app.post('/webhook', (req: Request, res: Response) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const result = await receive({ source: 'whatsapp', provider: 'meta', payload: req.body });

      if (!result.ok) {
        if (result.reason === 'status_update') return;
        console.log('[ledger] Skipping:', result.reason);
        return;
      }

      const { userId, message } = result.event;
      if (!message) { console.log('[ledger] Non-text event from', userId); return; }

      console.log('[ledger] Inbound from', userId);
      await handleLedgerMessage({ phone_number: userId, text_body: message, message_type: 'text' });
    } catch (err) {
      console.error('[ledger] Webhook error:', err instanceof Error ? err.message : err);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', app: 'ledger' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[ledger] Running on port ${PORT}`);
});
