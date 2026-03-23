import 'dotenv/config';
import http from 'http';
import { handleMiningReport } from './src/handler';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN ?? '';

// ---------------------------------------------------------------------------
// Parse raw body from incoming request
// ---------------------------------------------------------------------------
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Extract (phone, text) from a Meta webhook payload
// Returns null if the payload is not a text message
// ---------------------------------------------------------------------------
function extractMessage(body: string): { phone: string; text: string } | null {
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    const entry = (payload['entry'] as any[])?.[0];
    const change = (entry?.['changes'] as any[])?.[0];
    const value = change?.['value'];
    const message = (value?.['messages'] as any[])?.[0];

    if (!message || message['type'] !== 'text') return null;

    const rawPhone: string = message['from'];          // e.g. "917017875169"
    const text: string = message['text']?.['body'] ?? '';

    return { phone: '+' + rawPhone, text };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200).end('ok');
    return;
  }

  // Meta webhook verification (GET /webhook)
  if (req.method === 'GET' && url.pathname === '/webhook') {
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
      console.log('[WEBHOOK] Verification successful');
      res.writeHead(200).end(challenge);
    } else {
      console.warn('[WEBHOOK] Verification failed — token mismatch or missing params');
      res.writeHead(403).end('Forbidden');
    }
    return;
  }

  // Incoming WhatsApp message (POST /webhook)
  if (req.method === 'POST' && url.pathname === '/webhook') {
    const body = await readBody(req);
    console.log('\n[WEBHOOK] Raw payload:', body);

    const extracted = extractMessage(body);

    if (!extracted) {
      console.log('[WEBHOOK] Not a text message — skipping');
      res.writeHead(200).end('ok');
      return;
    }

    console.log(`[WEBHOOK] Message from ${extracted.phone}:`);
    console.log(extracted.text);
    console.log('---');

    // Acknowledge immediately — Meta expects a 200 within 20s
    res.writeHead(200).end('ok');

    // Process asynchronously
    handleMiningReport({ userId: extracted.phone, message: extracted.text }).catch(
      (err: unknown) => console.error('[HANDLER ERROR]', err)
    );

    return;
  }

  res.writeHead(404).end('Not found');
});

server.listen(PORT, () => {
  console.log(`[SERVER] Mining reporting webhook listening on port ${PORT}`);
  console.log(`[SERVER] POST /webhook — incoming messages`);
  console.log(`[SERVER] GET  /webhook — Meta verification`);
  console.log(`[SERVER] GET  /health  — health check`);
});
