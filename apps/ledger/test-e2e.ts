/**
 * Ledger E2E Tests
 *
 * Starts the actual HTTP server, sends real Meta webhook payloads via HTTP,
 * and verifies Google Sheet state changes for write operations.
 *
 * Reads and query flows (balance, summary, ledger party) are verified
 * by confirming the sheet is NOT mutated and the flow ran without errors.
 *
 * Note: Read flows send real WhatsApp messages to LEDGER_OWNER_PHONE.
 */

import 'dotenv/config';
import { spawn, ChildProcess } from 'child_process';
import { execute as storageExecute } from 'storage-module';
import * as http from 'http';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SHEET_ID  = process.env['LEDGER_SHEET_ID']    ?? '';
const OWNER     = process.env['LEDGER_OWNER_PHONE'] ?? '';
const PORT      = parseInt(process.env['PORT'] ?? '3000', 10);
const BASE_URL  = `http://localhost:${PORT}`;
// Local AI (Mistral) is slower — give it more time to respond
const AI_MODE   = (process.env['LEDGER_AI_PROVIDER'] === 'local') || (process.env['LEDGER_MODE'] === 'ai');
const WAIT_MS   = AI_MODE ? 12_000 : 4_000;

const today     = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const twoDays   = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let server: ChildProcess | null = null;

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
    failed++;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Meta webhook payload builder
// ---------------------------------------------------------------------------

let msgCounter = 0;

function metaPayload(from: string, text: string): Record<string, unknown> {
  msgCounter++;
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'test-entry-id',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '1234567890',
                phone_number_id: 'test-phone-number-id',
              },
              messages: [
                {
                  id: `wamid.test-${Date.now()}-${msgCounter}`,
                  from: from.replace('+', ''),  // Meta sends without leading +
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function postWebhook(payload: unknown): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: '/webhook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, res => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getHealth(): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get(`${BASE_URL}/health`, res => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(maxWaitMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await getHealth()) return true;
    await sleep(300);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

async function readAllRows(): Promise<Record<string, string>[]> {
  const r = await storageExecute({
    provider: 'sheets',
    operation: 'read',
    resource: SHEET_ID,
    options: { range: 'Ledger' },
  });
  if (!r.ok) throw new Error(`Read failed: ${r.error}`);
  return ((r.output as { rows?: Record<string, string>[] })?.rows ?? []);
}

async function writeRow(data: string[]): Promise<void> {
  const r = await storageExecute({
    provider: 'sheets',
    operation: 'write',
    resource: SHEET_ID,
    data,
    options: { range: 'Ledger' },
  });
  if (!r.ok) throw new Error(`Write failed: ${r.error}`);
}

async function clearRow(rowIndex: number): Promise<void> {
  const r = await storageExecute({
    provider: 'sheets',
    operation: 'update',
    resource: SHEET_ID,
    data: ['', '', '', '', '', ''],
    options: { range: 'Ledger', rowIndex },
  });
  if (!r.ok) throw new Error(`Clear row ${rowIndex} failed: ${r.error}`);
}

async function clearSheet(): Promise<void> {
  const rows = await readAllRows();
  for (let i = rows.length; i >= 1; i--) {
    await clearRow(i);
  }
}

function activeRows(rows: Record<string, string>[]): Record<string, string>[] {
  return rows.filter(r => r['Type'] === 'credit' || r['Type'] === 'debit');
}

// ---------------------------------------------------------------------------
// Test data — same set as test-v2 for consistent expectations
// ---------------------------------------------------------------------------

const TEST_DATA: string[][] = [
  [twoDays,   'credit', '5000', 'rahul',      '',         OWNER],
  [twoDays,   'debit',  '1200', 'groceries',  'food',     OWNER],
  [twoDays,   'credit', '3000', 'sharma',     'salary',   OWNER],
  [yesterday, 'debit',  '800',  'utilities',  'electric', OWNER],
  [yesterday, 'credit', '2000', 'rahul',      'advance',  OWNER],
  [yesterday, 'debit',  '500',  'transport',  '',         OWNER],
  [today,     'credit', '1500', 'sharma',     '',         OWNER],
  [today,     'debit',  '600',  'groceries',  'food',     OWNER],
  [today,     'credit', '800',  'rahul',      '',         OWNER],
  [today,     'debit',  '250',  'transport',  '',         OWNER],
];

async function populateSheet(): Promise<void> {
  for (const row of TEST_DATA) {
    await writeRow(row);
  }
}

// ---------------------------------------------------------------------------
// Individual tests
// ---------------------------------------------------------------------------

async function testServerHealthcheck(): Promise<void> {
  console.log('\n=== TEST: /health endpoint ===\n');
  const ok = await getHealth();
  assert('server responds to /health', ok);
}

async function testAddEntry(): Promise<void> {
  console.log('\n=== TEST: add credit 4200 e2etestparty ===\n');

  const rowsBefore = activeRows(await readAllRows());
  const countBefore = rowsBefore.length;

  const res = await postWebhook(metaPayload(OWNER, 'add credit 4200 e2etestparty'));
  assert('server returns 200', res.status === 200);

  // Wait for async processing — sheet write + comm send
  await sleep(WAIT_MS);

  const rowsAfter = activeRows(await readAllRows());
  assert('row count increased by 1', rowsAfter.length === countBefore + 1, `before=${countBefore} after=${rowsAfter.length}`);

  const newRow = rowsAfter[rowsAfter.length - 1];
  assert('row type = credit',      newRow?.['Type']   === 'credit');
  assert('row amount = 4200',      newRow?.['Amount'] === '4200');
  assert('row party = e2etestparty', newRow?.['Party'] === 'e2etestparty');
  assert('row user = owner phone', newRow?.['User']   === OWNER);
}

async function testDuplicateDetection(): Promise<void> {
  console.log('\n=== TEST: duplicate add (same entry again) ===\n');

  const rowsBefore = activeRows(await readAllRows());
  const countBefore = rowsBefore.length;

  const res = await postWebhook(metaPayload(OWNER, 'add credit 4200 e2etestparty'));
  assert('server returns 200', res.status === 200);

  await sleep(WAIT_MS);

  const rowsAfter = activeRows(await readAllRows());
  assert('row count unchanged (duplicate rejected)', rowsAfter.length === countBefore, `before=${countBefore} after=${rowsAfter.length}`);
}

async function testAddDebitWithKShorthand(): Promise<void> {
  console.log('\n=== TEST: add debit 1.5k kshorthandparty ===\n');

  const rowsBefore = activeRows(await readAllRows());
  const countBefore = rowsBefore.length;

  const res = await postWebhook(metaPayload(OWNER, 'add debit 1.5k kshorthandparty'));
  assert('server returns 200', res.status === 200);

  await sleep(WAIT_MS);

  const rowsAfter = activeRows(await readAllRows());
  assert('row count increased by 1', rowsAfter.length === countBefore + 1);

  const newRow = rowsAfter[rowsAfter.length - 1];
  assert('row type = debit',            newRow?.['Type']   === 'debit');
  assert('row amount = 1500',           newRow?.['Amount'] === '1500');
  assert('row party = kshorthandparty', newRow?.['Party']  === 'kshorthandparty');
}

async function testBalanceQuery(): Promise<void> {
  console.log('\n=== TEST: balance (read-only, no sheet mutation) ===\n');

  const rowsBefore = activeRows(await readAllRows());
  const countBefore = rowsBefore.length;

  const res = await postWebhook(metaPayload(OWNER, 'balance'));
  assert('server returns 200', res.status === 200);

  await sleep(WAIT_MS);

  const rowsAfter = activeRows(await readAllRows());
  assert('sheet unchanged (read-only)', rowsAfter.length === countBefore);
  console.log('  (WhatsApp balance reply sent to owner phone)');
}

async function testSummaryQuery(): Promise<void> {
  console.log('\n=== TEST: summary today (read-only) ===\n');

  const rowsBefore = activeRows(await readAllRows());
  const countBefore = rowsBefore.length;

  const res = await postWebhook(metaPayload(OWNER, 'summary today'));
  assert('server returns 200', res.status === 200);

  await sleep(WAIT_MS);

  const rowsAfter = activeRows(await readAllRows());
  assert('sheet unchanged (read-only)', rowsAfter.length === countBefore);
  console.log('  (WhatsApp summary reply sent to owner phone)');
}

async function testLedgerPartyQuery(): Promise<void> {
  console.log('\n=== TEST: ledger rahul (read-only) ===\n');

  const rowsBefore = activeRows(await readAllRows());
  const countBefore = rowsBefore.length;

  const res = await postWebhook(metaPayload(OWNER, 'ledger rahul'));
  assert('server returns 200', res.status === 200);

  await sleep(WAIT_MS);

  const rowsAfter = activeRows(await readAllRows());
  assert('sheet unchanged (read-only)', rowsAfter.length === countBefore);
  console.log('  (WhatsApp ledger reply sent to owner phone)');
}

async function testDeleteLast(): Promise<void> {
  console.log('\n=== TEST: delete last ===\n');

  const rowsBefore = activeRows(await readAllRows());
  const countBefore = rowsBefore.length;
  const lastRowBefore = rowsBefore[rowsBefore.length - 1];
  console.log(`  Last row before delete: ${JSON.stringify(lastRowBefore)}`);

  const res = await postWebhook(metaPayload(OWNER, 'delete last'));
  assert('server returns 200', res.status === 200);

  await sleep(WAIT_MS);

  const rowsAfter = activeRows(await readAllRows());
  assert('row count decreased by 1', rowsAfter.length === countBefore - 1, `before=${countBefore} after=${rowsAfter.length}`);

  if (rowsAfter.length < countBefore) {
    const lastRowAfter = rowsAfter[rowsAfter.length - 1];
    const deletedParty   = lastRowBefore?.['Party']  ?? '';
    const remainingParty = lastRowAfter?.['Party']   ?? '';
    assert(
      'deleted row no longer last',
      deletedParty !== remainingParty || rowsAfter.length === 0,
    );
  }
}

async function testInvalidCommand(): Promise<void> {
  console.log('\n=== TEST: invalid command (no sheet mutation) ===\n');

  const rowsBefore = activeRows(await readAllRows());
  const countBefore = rowsBefore.length;

  const res = await postWebhook(metaPayload(OWNER, 'hello this is not a valid command'));
  assert('server returns 200', res.status === 200);

  await sleep(WAIT_MS);

  const rowsAfter = activeRows(await readAllRows());
  assert('sheet unchanged (invalid command ignored)', rowsAfter.length === countBefore);
  console.log('  (help/invalid message sent to owner phone in structured mode)');
}

async function testStatusUpdateIgnored(): Promise<void> {
  console.log('\n=== TEST: Meta status-only update (no messages array) ===\n');

  // Meta sends these for message delivery receipts — no messages array
  const statusPayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-id',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '123', phone_number_id: 'pid' },
              statuses: [{ id: 'wamid.xxx', status: 'delivered', timestamp: '1234567890', recipient_id: '91999' }],
            },
          },
        ],
      },
    ],
  };

  const rowsBefore = activeRows(await readAllRows());
  const countBefore = rowsBefore.length;

  const res = await postWebhook(statusPayload);
  assert('server returns 200', res.status === 200);

  await sleep(2000);

  const rowsAfter = activeRows(await readAllRows());
  assert('sheet unchanged (status update skipped)', rowsAfter.length === countBefore);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function freePort(): Promise<void> {
  return new Promise(resolve => {
    // Find and kill any process using our port
    const lsof = spawn('lsof', ['-ti', `:${PORT}`]);
    let pids = '';
    lsof.stdout?.on('data', (d: Buffer) => { pids += d.toString(); });
    lsof.on('close', () => {
      const list = pids.trim().split('\n').filter(Boolean);
      if (list.length === 0) { resolve(); return; }
      console.log(`  Killing existing process(es) on port ${PORT}: ${list.join(', ')}`);
      const kill = spawn('kill', ['-9', ...list]);
      kill.on('close', () => setTimeout(resolve, 500)); // brief wait for port to free
    });
    lsof.on('error', () => resolve()); // lsof not available — skip
  });
}

async function startServer(): Promise<boolean> {
  console.log('\nStarting ledger server...');

  await freePort();

  const serverPath = path.join(__dirname, 'src', 'server.ts');
  server = spawn('npx', ['ts-node', serverPath], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  server.stdout?.on('data', (d: Buffer) => process.stdout.write(`  [server] ${d.toString()}`));
  server.stderr?.on('data', (d: Buffer) => process.stdout.write(`  [server:err] ${d.toString()}`));

  server.on('error', err => console.error('[e2e] Failed to start server:', err.message));

  const ready = await waitForServer(20_000);
  if (ready) {
    console.log(`Server ready on port ${PORT}\n`);
  } else {
    console.error('Server did not become ready in time');
  }
  return ready;
}

function stopServer(): void {
  if (server) {
    server.kill('SIGTERM');
    server = null;
    console.log('\nServer stopped.');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!SHEET_ID || !OWNER) {
    console.error('ERROR: LEDGER_SHEET_ID and LEDGER_OWNER_PHONE must be set in .env');
    process.exit(1);
  }

  console.log(`Sheet : ${SHEET_ID}`);
  console.log(`Owner : ${OWNER}`);
  console.log(`Port  : ${PORT}`);
  console.log(`Today : ${today}`);

  // Setup
  console.log('\n=== CLEARING & POPULATING SHEET ===\n');
  await clearSheet();
  await populateSheet();
  console.log(`  Populated ${TEST_DATA.length} rows`);

  const ready = await startServer();
  if (!ready) {
    console.error('Aborting: server failed to start');
    process.exit(1);
  }

  try {
    await testServerHealthcheck();
    await testAddEntry();
    await testDuplicateDetection();
    await testAddDebitWithKShorthand();
    await testBalanceQuery();
    await testSummaryQuery();
    await testLedgerPartyQuery();
    await testDeleteLast();
    await testInvalidCommand();
    await testStatusUpdateIgnored();
  } finally {
    stopServer();
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40));

  if (failed > 0) process.exit(1);
}

process.on('SIGINT', () => { stopServer(); process.exit(0); });
process.on('SIGTERM', () => { stopServer(); process.exit(0); });

main().catch(err => {
  console.error('Unhandled error:', err);
  stopServer();
  process.exit(1);
});
