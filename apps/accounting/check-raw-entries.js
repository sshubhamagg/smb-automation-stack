#!/usr/bin/env node
/**
 * raw_entries structure verification
 *
 * Reads a 25-row sample from the raw_entries tab, checks it against the
 * expected schema, and prints a structured report of any inconsistencies.
 *
 * Run: node apps/accounting/check-raw-entries.js
 */

'use strict';

const path  = require('path');
const fs    = require('fs');
const { google } = require(path.resolve(__dirname, '../../modules/sheets/node_modules/googleapis'));

// ---------------------------------------------------------------------------
// 1. Load and parse .env manually
//    The env file has a duplicate-key typo:
//      GOOGLE_SERVICE_ACCOUNT_JSON=GOOGLE_SERVICE_ACCOUNT_JSON={...}
//    We strip the accidental prefix so the value parses as valid JSON.
// ---------------------------------------------------------------------------

const envRaw = fs.readFileSync(path.resolve(__dirname, '.env'), 'utf-8');
const env = {};
for (const line of envRaw.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

const SHEET_ID = env['SHEET_ID'];
const SAJ_PREFIX = 'GOOGLE_SERVICE_ACCOUNT_JSON=';
let rawJson = env['GOOGLE_SERVICE_ACCOUNT_JSON'] ?? '';
if (rawJson.startsWith(SAJ_PREFIX)) rawJson = rawJson.slice(SAJ_PREFIX.length);

if (!SHEET_ID)  { console.error('SHEET_ID missing from .env'); process.exit(1); }
if (!rawJson)   { console.error('GOOGLE_SERVICE_ACCOUNT_JSON missing from .env'); process.exit(1); }

let credentials;
try {
  credentials = JSON.parse(rawJson);
} catch (e) {
  console.error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON:', e.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Schema definition (from docs/schema.md)
// ---------------------------------------------------------------------------

const EXPECTED_COLUMNS = [
  'row_id', 'date', 'type', 'amount',
  'debit_account', 'credit_account',
  'entity', 'notes', 'status', 'error_reason'
];

const VALID_STATUSES = new Set(['pending', 'in_progress', 'processed', 'failed', '']);
const DATE_RE        = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_RE      = /^\d+(\.\d+)?$/;

// ---------------------------------------------------------------------------
// 3. Validation helpers
// ---------------------------------------------------------------------------

function validateDate(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  return m >= 1 && m <= 12 && d >= 1 && d <= days;
}

function validateAmount(s) {
  const t = (s || '').trim();
  if (!t) return false;
  if (!AMOUNT_RE.test(t)) return false;
  return Number(t) > 0;
}

function validateRow(row, rowNum) {
  const issues = [];

  // row_id — must be non-empty
  if (!row.row_id || !String(row.row_id).trim()) {
    issues.push({ field: 'row_id', value: row.row_id, rule: 'must be non-empty unique string' });
  }

  // date — must be present and a valid YYYY-MM-DD calendar date
  if (!row.date) {
    issues.push({ field: 'date', value: row.date, rule: 'missing — must be YYYY-MM-DD' });
  } else if (!validateDate(row.date)) {
    issues.push({ field: 'date', value: row.date, rule: 'must be a valid YYYY-MM-DD calendar date' });
  }

  // amount — positive decimal only
  if (!validateAmount(row.amount)) {
    issues.push({ field: 'amount', value: row.amount, rule: 'must be a positive number matching /^\\d+(\\.\\d+)?$/' });
  }

  // debit_account — must be non-empty
  if (!row.debit_account || !String(row.debit_account).trim()) {
    issues.push({ field: 'debit_account', value: row.debit_account, rule: 'must be non-empty' });
  }

  // credit_account — must be non-empty
  if (!row.credit_account || !String(row.credit_account).trim()) {
    issues.push({ field: 'credit_account', value: row.credit_account, rule: 'must be non-empty' });
  }

  // debit_account !== credit_account
  if (row.debit_account && row.credit_account &&
      row.debit_account.trim().toLowerCase() === row.credit_account.trim().toLowerCase()) {
    issues.push({ field: 'debit_account / credit_account', value: row.debit_account, rule: 'debit and credit accounts must be different' });
  }

  // status — must be a recognised value
  const statusNorm = (row.status || '').toLowerCase().trim();
  if (!VALID_STATUSES.has(statusNorm)) {
    issues.push({ field: 'status', value: row.status, rule: `must be one of: pending, in_progress, processed, failed (got "${row.status}")` });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 4. Read sample from Sheets
// ---------------------------------------------------------------------------

async function run() {
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key:   credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  console.log('\n── Connecting to Google Sheets ──────────────────────────────');
  console.log(`  Sheet ID : ${SHEET_ID}`);
  console.log(`  Tab      : raw_entries`);
  console.log(`  Sample   : rows 1–26 (header + 25 data rows)\n`);

  let values;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'raw_entries!A1:J26',
    });
    values = res.data.values ?? [];
  } catch (err) {
    const code = err.code || err.status;
    if (code === 404) console.error('ERROR: Sheet or tab not found. Verify SHEET_ID and that the tab is named "raw_entries".');
    else if (code === 401 || code === 403) console.error('ERROR: Authentication failed. Verify GOOGLE_SERVICE_ACCOUNT_JSON and that the service account has Viewer access to the sheet.');
    else console.error('ERROR calling Sheets API:', err.message);
    process.exit(1);
  }

  if (values.length === 0) {
    console.log('⚠  Tab raw_entries is completely empty (no header row found).');
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // 5. Header check
  // ---------------------------------------------------------------------------

  const headerRow  = values[0].map(h => String(h).trim().toLowerCase());
  const dataValues = values.slice(1);

  console.log('── Header Check ─────────────────────────────────────────────');
  console.log(`  Found    : [${headerRow.join(', ')}]`);
  console.log(`  Expected : [${EXPECTED_COLUMNS.join(', ')}]\n`);

  const headerIssues = [];
  if (headerRow.length !== EXPECTED_COLUMNS.length) {
    headerIssues.push(`column count mismatch — found ${headerRow.length}, expected ${EXPECTED_COLUMNS.length}`);
  }
  EXPECTED_COLUMNS.forEach((col, i) => {
    if (headerRow[i] !== col) {
      headerIssues.push(`col[${i}]: found "${headerRow[i]}", expected "${col}"`);
    }
  });
  const extraCols = headerRow.filter(h => !EXPECTED_COLUMNS.includes(h));
  if (extraCols.length) {
    headerIssues.push(`unexpected columns: [${extraCols.join(', ')}]`);
  }

  if (headerIssues.length === 0) {
    console.log('  ✓ Header matches expected schema\n');
  } else {
    console.log('  ✗ HEADER ISSUES:');
    headerIssues.forEach(i => console.log(`      - ${i}`));
    console.log();
  }

  // ---------------------------------------------------------------------------
  // 6. Row-level validation
  // ---------------------------------------------------------------------------

  if (dataValues.length === 0) {
    console.log('  (No data rows in sample)\n');
    process.exit(0);
  }

  // Map raw arrays to objects using the actual header row
  const rows = dataValues.map(cells => {
    const obj = {};
    headerRow.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
    return obj;
  });

  console.log('── Row Validation ───────────────────────────────────────────');
  console.log(`  Sample size : ${rows.length} row(s)\n`);

  const rowIssues = [];
  let cleanCount  = 0;

  rows.forEach((row, idx) => {
    const rowNum  = idx + 2; // +2: 1-based + header offset
    const issues  = validateRow(row, rowNum);
    if (issues.length > 0) {
      rowIssues.push({ rowNum, issues });
    } else {
      cleanCount++;
    }
  });

  if (rowIssues.length === 0) {
    console.log(`  ✓ All ${cleanCount} sampled row(s) pass validation\n`);
  } else {
    console.log(`  ✓ Clean rows : ${cleanCount}`);
    console.log(`  ✗ Rows with issues : ${rowIssues.length}\n`);
    rowIssues.forEach(({ rowNum, issues }) => {
      console.log(`  Row ${rowNum}:`);
      issues.forEach(({ field, value, rule }) => {
        const display = value === undefined || value === '' ? '(empty)' : `"${value}"`;
        console.log(`    ✗ ${field} = ${display}`);
        console.log(`        → ${rule}`);
      });
      console.log();
    });
  }

  // ---------------------------------------------------------------------------
  // 7. Summary
  // ---------------------------------------------------------------------------

  console.log('── Summary ──────────────────────────────────────────────────');

  const totalIssues = headerIssues.length + rowIssues.length;
  if (totalIssues === 0) {
    console.log('  ✓ Structure is correct. Safe to proceed with full run.\n');
  } else {
    console.log(`  ✗ ${headerIssues.length} header issue(s) + ${rowIssues.length} row(s) with issues`);
    console.log('  Fix the above before running the workflow.\n');
    console.log('── Expected schema (raw_entries) ───────────────────────────');
    console.log('  Columns (A–J, 10 total, header in row 1):');
    const rules = [
      'row_id        — unique string, user-assigned, never changed',
      'date          — YYYY-MM-DD, valid calendar date',
      'type          — freeform (expense / income / transfer)',
      'amount        — positive decimal, digits only e.g. 100 or 99.50',
      'debit_account — non-empty, must exist in accounts tab',
      'credit_account— non-empty, must differ from debit_account',
      'entity        — freeform counterparty name',
      'notes         — freeform description (can be empty)',
      'status        — pending | in_progress | processed | failed',
      'error_reason  — pipe-separated error codes (engine-written, empty initially)',
    ];
    rules.forEach(r => console.log(`    ${r}`));
    console.log();
  }
}

run().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
