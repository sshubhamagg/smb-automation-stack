// ============================================================
// VC Engine — Express Server
//
// Triggers:
//   POST /run      — manual trigger (e.g. from cron or CI)
//   GET  /health   — health check
//
// The engine has no inbound webhook — it reads from Google Sheets
// and writes back to Google Sheets. Triggered externally.
// ============================================================

import 'dotenv/config';
import express, { Request, Response } from 'express';
import { handleVcEngine } from './handler';

const PORT = parseInt(process.env['PORT'] ?? '3003', 10);

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// POST /run — trigger the full VC engine pipeline
// ---------------------------------------------------------------------------

app.post('/run', (_req: Request, res: Response) => {
  // Acknowledge immediately — processing runs asynchronously
  res.json({ status: 'accepted', message: 'VC Engine pipeline started' });

  setImmediate(async () => {
    try {
      await handleVcEngine();
    } catch (err) {
      console.error('[vc-engine] Unhandled error:', err instanceof Error ? err.message : err);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', app: 'vc-engine' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[vc-engine] Running on port ${PORT}`);
});
