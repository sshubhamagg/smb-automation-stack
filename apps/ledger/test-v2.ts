/**
 * Ledger V2 Integration Test
 *
 * 1. Clears existing sheet data
 * 2. Populates with varied test data
 * 3. Runs all query flows and captures responses
 * 4. Asserts expected values
 */

import 'dotenv/config';
import { execute as storageExecute } from 'storage-module';
import { runFlow } from 'engine-module';
import type { Modules } from 'engine-module';

import { buildInitialContext as buildEntryCtx, ledgerEntryFlow } from '../../flows/ledger/ledger-entry/flow';
import { buildInitialContext as buildBalanceCtx, ledgerBalanceFlow } from '../../flows/ledger/ledger-balance/flow';
import { buildInitialContext as buildSummaryCtx, ledgerSummaryFlow } from '../../flows/ledger/ledger-summary/flow';
import { buildInitialContext as buildPartyCtx, ledgerPartyFlow } from '../../flows/ledger/ledger-party/flow';
import { buildInitialContext as buildDeleteCtx, ledgerDeleteFlow } from '../../flows/ledger/ledger-delete/flow';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SHEET_ID   = process.env['LEDGER_SHEET_ID']    ?? '';
const OWNER      = process.env['LEDGER_OWNER_PHONE'] ?? '';
const TEST_USER  = OWNER;
const config     = { sheetId: SHEET_ID, ownerPhone: OWNER };

const today     = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const twoDays   = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Mock communication — captures messages instead of sending to WhatsApp
// ---------------------------------------------------------------------------

let lastMessage = '';

const modules: Modules = {
  storage: (input: unknown) => storageExecute(input as Parameters<typeof storageExecute>[0]),
  communication: async (input: unknown) => {
    const { message } = input as { to: string; message: string };
    lastMessage = message;
    return { ok: true as const, output: null };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
    failed++;
  }
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

// ---------------------------------------------------------------------------
// Step 1 — Clear existing rows
// ---------------------------------------------------------------------------

async function clearSheet(): Promise<void> {
  console.log('\n=== CLEARING SHEET ===\n');
  const rows = await readAllRows();
  console.log(`  Found ${rows.length} existing rows, clearing...`);
  for (let i = rows.length; i >= 1; i--) {
    await clearRow(i);
  }
  console.log('  Sheet cleared.');
}

// ---------------------------------------------------------------------------
// Step 2 — Populate with test data
// ---------------------------------------------------------------------------

const TEST_DATA: string[][] = [
  // Date         Type      Amount   Party         Category    User
  [twoDays,   'credit',  '5000',   'rahul',      '',          TEST_USER],
  [twoDays,   'debit',   '1200',   'groceries',  'food',      TEST_USER],
  [twoDays,   'credit',  '3000',   'sharma',     'salary',    TEST_USER],
  [yesterday, 'debit',   '800',    'utilities',  'electric',  TEST_USER],
  [yesterday, 'credit',  '2000',   'rahul',      'advance',   TEST_USER],
  [yesterday, 'debit',   '500',    'transport',  '',          TEST_USER],
  [today,     'credit',  '1500',   'sharma',     '',          TEST_USER],
  [today,     'debit',   '600',    'groceries',  'food',      TEST_USER],
  [today,     'credit',  '800',    'rahul',      '',          TEST_USER],
  [today,     'debit',   '250',    'transport',  '',          TEST_USER],
];

async function populateSheet(): Promise<void> {
  console.log('\n=== POPULATING SHEET ===\n');
  for (const row of TEST_DATA) {
    await writeRow(row);
    console.log(`  + ${row[0]}  ${row[1].padEnd(6)}  ${row[2].padStart(6)}  ${row[3]}${row[4] ? ` (${row[4]})` : ''}`);
  }
  console.log(`\n  Written: ${TEST_DATA.length} rows`);
}

// ---------------------------------------------------------------------------
// Step 3 — Run all query tests
// ---------------------------------------------------------------------------

async function testBalance(): Promise<void> {
  console.log('\n=== TEST: balance ===\n');

  const { context } = buildBalanceCtx({ phone_number: TEST_USER, config });
  const result = await runFlow(ledgerBalanceFlow, context, modules);

  assert('flow completed ok', result.ok);

  // Expected from TEST_DATA (all rows for all users, but only TEST_USER rows match):
  // credits: 5000 + 3000 + 2000 + 1500 + 800 = 12300
  // debits : 1200 + 800  + 500  + 600  + 250 = 3350
  // balance: 12300 - 3350 = 8950
  assert('message contains Credits',  lastMessage.includes('Credits'));
  assert('message contains Debits',   lastMessage.includes('Debits'));
  assert('message contains Balance',  lastMessage.includes('Balance'));
  assert('credits = 12300.00',        lastMessage.includes('12300.00'));
  assert('debits  = 3350.00',         lastMessage.includes('3350.00'));
  assert('balance = +8950.00',        lastMessage.includes('8950.00'));

  console.log('\n  Response:\n' + lastMessage.split('\n').map(l => '  ' + l).join('\n'));
}

async function testSummaryToday(): Promise<void> {
  console.log('\n=== TEST: summary today ===\n');

  const { context } = buildSummaryCtx({ phone_number: TEST_USER, config });
  const result = await runFlow(ledgerSummaryFlow, context, modules);

  assert('flow completed ok', result.ok);

  // Today's rows:
  // credit 1500 sharma
  // debit  600  groceries
  // credit 800  rahul
  // debit  250  transport
  // credits: 1500 + 800 = 2300
  // debits : 600  + 250 = 850
  // net: 1450
  assert('message contains today\'s date', lastMessage.includes(today));
  assert('credits = 2300.00',             lastMessage.includes('2300.00'));
  assert('debits  = 850.00',              lastMessage.includes('850.00'));
  assert('net     = +1450.00',            lastMessage.includes('1450.00'));

  console.log('\n  Response:\n' + lastMessage.split('\n').map(l => '  ' + l).join('\n'));
}

async function testLedgerPartyRahul(): Promise<void> {
  console.log('\n=== TEST: ledger rahul ===\n');

  const { context } = buildPartyCtx({ phone_number: TEST_USER, party: 'rahul', config });
  const result = await runFlow(ledgerPartyFlow, context, modules);

  assert('flow completed ok', result.ok);

  // rahul rows:
  // credit 5000 (twoDays)
  // credit 2000 (yesterday)
  // credit 800  (today)
  // credits: 7800, debits: 0, net: +7800
  assert('message contains Ledger: rahul',  lastMessage.toLowerCase().includes('rahul'));
  assert('credits = 7800.00',               lastMessage.includes('7800.00'));
  assert('debits  = 0.00',                  lastMessage.includes('0.00'));
  assert('net     = +7800.00',              lastMessage.includes('+7800.00'));

  console.log('\n  Response:\n' + lastMessage.split('\n').map(l => '  ' + l).join('\n'));
}

async function testLedgerPartyGroceries(): Promise<void> {
  console.log('\n=== TEST: ledger groceries ===\n');

  const { context } = buildPartyCtx({ phone_number: TEST_USER, party: 'groceries', config });
  const result = await runFlow(ledgerPartyFlow, context, modules);

  assert('flow completed ok', result.ok);

  // groceries rows: debit 1200 (twoDays) + debit 600 (today)
  // credits: 0, debits: 1800, net: -1800
  assert('message contains groceries',  lastMessage.toLowerCase().includes('groceries'));
  assert('debits = 1800.00',            lastMessage.includes('1800.00'));
  assert('net is negative',             lastMessage.includes('-1800.00'));

  console.log('\n  Response:\n' + lastMessage.split('\n').map(l => '  ' + l).join('\n'));
}

async function testLedgerPartyNotFound(): Promise<void> {
  console.log('\n=== TEST: ledger unknownperson ===\n');

  const { context } = buildPartyCtx({ phone_number: TEST_USER, party: 'unknownperson', config });
  const result = await runFlow(ledgerPartyFlow, context, modules);

  assert('flow completed ok',              result.ok);
  assert('message says no transactions',   lastMessage.toLowerCase().includes('no transactions'));

  console.log('\n  Response:\n' + lastMessage.split('\n').map(l => '  ' + l).join('\n'));
}

async function testAddEntry(): Promise<void> {
  console.log('\n=== TEST: add credit 999 testparty ===\n');

  const ctxResult = buildEntryCtx({
    phone_number: TEST_USER,
    text_body: 'add credit 999 testparty',
    config,
  });

  assert('buildInitialContext ok', ctxResult.ok);
  if (!ctxResult.ok) return;

  const result = await runFlow(ledgerEntryFlow, ctxResult.context, modules);
  assert('flow completed ok', result.ok);
  assert('message says recorded', lastMessage.toLowerCase().includes('recorded'));
  assert('amount 999 in message', lastMessage.includes('999'));

  console.log('\n  Response:\n' + lastMessage.split('\n').map(l => '  ' + l).join('\n'));
}

async function testDuplicateDetection(): Promise<void> {
  console.log('\n=== TEST: duplicate — add same entry again ===\n');

  // Same entry as testAddEntry above
  const ctxResult = buildEntryCtx({
    phone_number: TEST_USER,
    text_body: 'add credit 999 testparty',
    config,
  });

  assert('buildInitialContext ok', ctxResult.ok);
  if (!ctxResult.ok) return;

  const result = await runFlow(ledgerEntryFlow, ctxResult.context, modules);
  assert('flow completed ok', result.ok);
  assert('message says duplicate', lastMessage.toLowerCase().includes('duplicate'));

  console.log('\n  Response:\n' + lastMessage.split('\n').map(l => '  ' + l).join('\n'));
}

async function testInvalidAdd(): Promise<void> {
  console.log('\n=== TEST: invalid command (missing amount) ===\n');

  const ctxResult = buildEntryCtx({
    phone_number: TEST_USER,
    text_body: 'add credit rahul',
    config,
  });

  assert('buildInitialContext returns invalid_format', !ctxResult.ok && ctxResult.reason === 'invalid_format');
  console.log(`  reason: ${ctxResult.ok ? 'ok (unexpected)' : ctxResult.reason}`);
}

async function testDeleteLast(): Promise<void> {
  console.log('\n=== TEST: delete last ===\n');

  const rowsBefore = await readAllRows();
  const userRowsBefore = rowsBefore.filter(r => r['User'] === TEST_USER && r['Type'] !== '');
  const lastRow = userRowsBefore[userRowsBefore.length - 1];

  console.log(`  Last entry before delete: ${JSON.stringify(lastRow)}`);

  const { context } = buildDeleteCtx({ phone_number: TEST_USER, config });
  const result = await runFlow(ledgerDeleteFlow, context, modules);

  assert('flow completed ok', result.ok);
  assert('message says deleted', lastMessage.toLowerCase().includes('deleted'));
  assert('message contains last party', lastMessage.toLowerCase().includes((lastRow?.['Party'] ?? '').toLowerCase()));

  const rowsAfter = await readAllRows();
  const userRowsAfter = rowsAfter.filter(r => r['User'] === TEST_USER && r['Type'] !== '');
  assert('row count decreased by 1', userRowsAfter.length === userRowsBefore.length - 1);

  console.log('\n  Response:\n' + lastMessage.split('\n').map(l => '  ' + l).join('\n'));
}

async function testDeleteNoEntries(): Promise<void> {
  console.log('\n=== TEST: delete last — user with no entries ===\n');

  const { context } = buildDeleteCtx({ phone_number: '+910000000000', config });
  const result = await runFlow(ledgerDeleteFlow, context, modules);

  assert('flow completed ok', result.ok);
  assert('message says no entries', lastMessage.toLowerCase().includes('no entries'));

  console.log('\n  Response:\n' + lastMessage.split('\n').map(l => '  ' + l).join('\n'));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!SHEET_ID || !OWNER) {
    console.error('ERROR: LEDGER_SHEET_ID and LEDGER_OWNER_PHONE must be set in .env');
    process.exit(1);
  }

  console.log(`Sheet  : ${SHEET_ID}`);
  console.log(`User   : ${TEST_USER}`);
  console.log(`Today  : ${today}`);

  await clearSheet();
  await populateSheet();

  await testBalance();
  await testSummaryToday();
  await testLedgerPartyRahul();
  await testLedgerPartyGroceries();
  await testLedgerPartyNotFound();
  await testAddEntry();
  await testDuplicateDetection();
  await testInvalidAdd();
  await testDeleteLast();
  await testDeleteNoEntries();

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
