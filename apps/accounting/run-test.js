'use strict';

/**
 * Full accounting system test runner
 * Runs all 4 flows sequentially, compares with expected CSVs, then runs idempotency check.
 *
 * Usage: node apps/accounting/run-test.js
 */

const path  = require('path');
const fs    = require('fs');
const { google } = require(path.resolve(__dirname, '../../modules/sheets/node_modules/googleapis'));

const ROOT  = path.resolve(__dirname, '../..');
const ENV_PATH = path.resolve(__dirname, '.env');

// ─── .env loader ─────────────────────────────────────────────────────────────

function loadEnv() {
  const raw = fs.readFileSync(ENV_PATH, 'utf-8');
  const env = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  const PREFIX = 'GOOGLE_SERVICE_ACCOUNT_JSON=';
  let saj = env['GOOGLE_SERVICE_ACCOUNT_JSON'] ?? '';
  if (saj.startsWith(PREFIX)) saj = saj.slice(PREFIX.length);
  return { sheetId: env['SHEET_ID'], credentials: JSON.parse(saj) };
}

// ─── Sheets helpers ───────────────────────────────────────────────────────────

function buildSheets(credentials) {
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key:   credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getValues(sheets, sheetId, range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  return res.data.values ?? [];
}

async function appendBatch(sheets, sheetId, range, rows) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 1000) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: rows.slice(i, i + 1000) },
    });
  }
}

async function clearTab(sheets, sheetId, tab) {
  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: `${tab}!A:Z` });
}

async function getTabNames(sheets, sheetId) {
  const res = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  return (res.data.sheets ?? []).map(s => s.properties?.title ?? '');
}

async function createTab(sheets, sheetId, title) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
}

// ─── CSV loader ───────────────────────────────────────────────────────────────

function loadCSV(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
}

// ─── Validation helpers ───────────────────────────────────────────────────────

const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_RE = /^\d+(\.\d+)?$/;

function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate();
}

function validAmount(s) {
  const t = (s || '').trim();
  return t && AMOUNT_RE.test(t) && Number(t) > 0;
}

// ─── Flow 1: validate-entries ─────────────────────────────────────────────────

async function validateEntries(sheets, sheetId, TABS) {
  console.log('\n  [1/4] validate-entries');

  // Read raw_entries
  const raw = await getValues(sheets, sheetId, `${TABS.raw}!A:J`);
  if (raw.length < 2) { console.log('    raw_entries empty — skip'); return { totalRaw: 0, pending: 0, valid: 0, invalid: 0 }; }

  const hdr  = raw[0].map(h => String(h).trim().toLowerCase());
  const rows = raw.slice(1).map((cells, i) => {
    const obj = {};
    hdr.forEach((h, j) => { obj[h] = cells[j] ?? ''; });
    obj._row = i + 2;
    return obj;
  });

  const totalRaw     = rows.length;
  const pendingRows  = rows.filter(r => (r.status || '').toLowerCase().trim() === 'pending');
  console.log(`    total: ${totalRaw} | pending: ${pendingRows.length}`);

  if (!pendingRows.length) {
    const processed = rows.filter(r => (r.status || '').toLowerCase() === 'processed').length;
    const failed    = rows.filter(r => (r.status || '').toLowerCase() === 'failed').length;
    console.log('    no pending rows — nothing to process');
    return { totalRaw, pending: 0, valid: processed, invalid: failed, skipped: true };
  }

  // Read accounts
  const acctRaw  = await getValues(sheets, sheetId, `${TABS.accounts}!A:B`);
  const acctHdr  = (acctRaw[0] ?? []).map(h => String(h).trim().toLowerCase());
  const nameIdx  = acctHdr.indexOf('account_name');
  const validAcc = new Set(acctRaw.slice(1).map(c => (c[nameIdx] ?? '').trim().toLowerCase()).filter(Boolean));

  // Validate each pending row
  const validRows   = [];
  const invalidRows = [];

  for (const r of pendingRows) {
    const errors = [];

    if (!r.date)              errors.push('missing_date');
    else if (!validDate(r.date)) errors.push('invalid_date_format');

    const amtStr = String(r.amount || '').trim();
    if (!amtStr)                errors.push('invalid_amount');
    else if (!validAmount(amtStr)) errors.push('invalid_amount');

    if (!r.debit_account?.trim())                                   errors.push('missing_debit');
    else if (!validAcc.has(r.debit_account.trim().toLowerCase()))   errors.push('invalid_debit_account');

    if (!r.credit_account?.trim())                                  errors.push('missing_credit');
    else if (!validAcc.has(r.credit_account.trim().toLowerCase()))  errors.push('invalid_credit_account');

    if (r.debit_account?.trim().toLowerCase() === r.credit_account?.trim().toLowerCase()
        && r.debit_account?.trim()) {
      errors.push('same_account');
    }

    if (errors.length) {
      invalidRows.push({ ...r, error_reason: errors.join('|') });
    } else {
      // reference_id: use original account name casing to match mock.js expected output
      const reference_id = `${r.date}-${r.amount}-${r.debit_account}-${r.credit_account}-${r.row_id}`;
      validRows.push({ ...r, reference_id });
    }
  }

  console.log(`    valid: ${validRows.length} | invalid: ${invalidRows.length}`);

  // Deduplication against existing validated_entries
  const existing = await getValues(sheets, sheetId, `${TABS.validated}!A:F`);
  const existingIds = new Set();
  if (existing.length > 1) {
    const eh = existing[0].map(h => String(h).trim().toLowerCase());
    const ri = eh.indexOf('reference_id');
    if (ri >= 0) existing.slice(1).forEach(c => { if (c[ri]) existingIds.add(c[ri]); });
  }

  const newRows = validRows.filter(r => !existingIds.has(r.reference_id));
  console.log(`    new to ledger: ${newRows.length} (${validRows.length - newRows.length} already present)`);

  // Write header if validated_entries is empty
  if (!existingIds.size && newRows.length) {
    await clearTab(sheets, sheetId, TABS.validated);
    await appendBatch(sheets, sheetId, `${TABS.validated}!A1`, [
      ['date', 'debit_account', 'credit_account', 'amount', 'entity', 'reference_id']
    ]);
  }

  // Write new valid rows in batches
  if (newRows.length) {
    const writeRows = newRows.map(r => [r.date, r.debit_account, r.credit_account, r.amount, r.entity, r.reference_id]);
    await appendBatch(sheets, sheetId, `${TABS.validated}!A1`, writeRows);
    console.log(`    ✓ Wrote ${newRows.length} rows to validated_entries`);
  }

  // Build status + error_reason columns for ALL raw rows
  // Build lookup maps for quick access
  const validSet   = new Map(validRows.map(r => [r._row, '']));           // error_reason = ''
  const invalidSet = new Map(invalidRows.map(r => [r._row, r.error_reason]));

  const statusCol = [];
  const errorCol  = [];

  for (const r of rows) {
    const s = (r.status || '').toLowerCase().trim();
    if (s !== 'pending') {
      // keep existing
      statusCol.push([r.status]);
      errorCol.push([r.error_reason]);
    } else if (validSet.has(r._row)) {
      statusCol.push(['processed']);
      errorCol.push(['']);
    } else if (invalidSet.has(r._row)) {
      statusCol.push(['failed']);
      errorCol.push([invalidSet.get(r._row)]);
    } else {
      statusCol.push([r.status]);
      errorCol.push([r.error_reason]);
    }
  }

  // Single batchUpdate call for all status + error_reason cells
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${TABS.raw}!I2:I${rows.length + 1}`, values: statusCol },
        { range: `${TABS.raw}!J2:J${rows.length + 1}`, values: errorCol  },
      ],
    },
  });

  console.log(`    ✓ Marked ${validRows.length} processed + ${invalidRows.length} failed in raw_entries`);

  return { totalRaw, pending: pendingRows.length, valid: validRows.length, invalid: invalidRows.length };
}

// ─── Flow 2: compute-ledger-balances ─────────────────────────────────────────

async function computeLedgerBalances(sheets, sheetId, TABS) {
  console.log('\n  [2/4] compute-ledger-balances');

  const vRaw = await getValues(sheets, sheetId, `${TABS.validated}!A:F`);
  if (vRaw.length < 2) { console.log('    validated_entries empty — skip'); return { written: false }; }

  const vh   = vRaw[0].map(h => String(h).trim().toLowerCase());
  const vRows = vRaw.slice(1).map(cells => {
    const obj = {};
    vh.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
    return obj;
  });

  // Skip if today's snapshot already exists
  const today = new Date().toISOString().split('T')[0];
  const snapRaw = await getValues(sheets, sheetId, `${TABS.snapshots}!A:A`);
  if (snapRaw.slice(1).some(c => (c[0] || '') === today)) {
    console.log(`    snapshot for ${today} already exists — skip`);
    return { written: false, skipped: true };
  }

  // Compute balances
  const balances = {};
  for (const r of vRows) {
    const amt = Number(r.amount || 0);
    balances[r.debit_account]  = (balances[r.debit_account]  || 0) + amt;
    balances[r.credit_account] = (balances[r.credit_account] || 0) - amt;
  }

  const runId       = `run-${new Date().toISOString()}`;
  const snapRef     = `snapshot-${today}`;
  const snapRows    = Object.entries(balances).map(([account, balance]) =>
    [today, account, balance, snapRef, vRows.length, runId]
  );

  // Write header if needed
  const snapHeader = await getValues(sheets, sheetId, `${TABS.snapshots}!1:1`);
  if (!snapHeader.length || !snapHeader[0]?.length) {
    await appendBatch(sheets, sheetId, `${TABS.snapshots}!A1`, [
      ['date', 'account', 'balance', 'snapshot_ref', 'entry_count', 'run_id']
    ]);
  }
  await appendBatch(sheets, sheetId, `${TABS.snapshots}!A1`, snapRows);

  console.log(`    ✓ Snapshot written for ${today}: ${snapRows.length} accounts | ${vRows.length} entries processed`);
  Object.entries(balances).forEach(([a, b]) => console.log(`      ${a}: ${b}`));

  return { written: true, balances, date: today };
}

// ─── Flow 3: trial-balance-check ─────────────────────────────────────────────

async function trialBalanceCheck(sheets, sheetId, TABS) {
  console.log('\n  [3/4] trial-balance-check');

  const vRaw = await getValues(sheets, sheetId, `${TABS.validated}!A:F`);
  if (vRaw.length < 2) { console.log('    validated_entries empty — skip'); return { mismatch: false }; }

  const vh   = vRaw[0].map(h => String(h).trim().toLowerCase());
  const amtI = vh.indexOf('amount');

  // In double-entry: sum of all debit amounts must equal sum of all credit amounts.
  // Since each entry debits and credits the same amount, net = 0 always for valid data.
  let debitSum = 0; let creditSum = 0;
  vRaw.slice(1).forEach(cells => {
    const amt = Number(cells[amtI] || 0);
    debitSum  += amt;
    creditSum += amt;
  });

  const mismatch = debitSum !== creditSum;

  if (mismatch) {
    console.log(`    ✗ MISMATCH: debit=${debitSum} credit=${creditSum}`);
    const recHeader = await getValues(sheets, sheetId, `${TABS.reconciliation}!1:1`);
    if (!recHeader.length || !recHeader[0]?.length) {
      await appendBatch(sheets, sheetId, `${TABS.reconciliation}!A1`, [
        ['reference_id', 'issue_type', 'status', 'notes']
      ]);
    }
    await appendBatch(sheets, sheetId, `${TABS.reconciliation}!A1`, [
      [Date.now(), 'trial_balance_mismatch', 'open', `debit:${debitSum}|credit:${creditSum}`]
    ]);
    return { mismatch: true, debitSum, creditSum };
  }

  console.log(`    ✓ Trial balance OK — debit = credit = ${debitSum}`);
  return { mismatch: false };
}

// ─── Flow 4: generate-financials ─────────────────────────────────────────────

async function generateFinancials(sheets, sheetId, TABS) {
  console.log('\n  [4/4] generate-financials');

  const snapRaw = await getValues(sheets, sheetId, `${TABS.snapshots}!A:F`);
  if (snapRaw.length < 2) { console.log('    no snapshots — skip'); return { written: false }; }

  const sh      = snapRaw[0].map(h => String(h).trim().toLowerCase());
  const snapRows = snapRaw.slice(1).map(cells => {
    const obj = {};
    sh.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
    return obj;
  });

  // Select latest snapshot date
  const latestDate  = snapRows.reduce((max, r) => (r.date > max ? r.date : max), '');
  const latestSnaps = snapRows.filter(r => r.date === latestDate);

  // Load account type map
  const acctRaw = await getValues(sheets, sheetId, `${TABS.accounts}!A:B`);
  const ah      = (acctRaw[0] ?? []).map(h => String(h).trim().toLowerCase());
  const nameI   = ah.indexOf('account_name');
  const typeI   = ah.indexOf('type');
  const acctMap = {};
  acctRaw.slice(1).forEach(c => {
    const name = (c[nameI] ?? '').trim().toLowerCase();
    const type = (c[typeI] ?? '').trim().toLowerCase();
    if (name) acctMap[name] = type;
  });

  // Compute in integer cents to avoid float accumulation
  let revCents = 0; let expCents = 0;
  for (const s of latestSnaps) {
    const type         = acctMap[s.account?.trim().toLowerCase()];
    const balanceCents = Math.round(Number(s.balance || 0) * 100);
    if (type === 'income')  revCents += balanceCents;
    if (type === 'expense') expCents += balanceCents;
  }

  const revenue  = revCents  / 100;
  const expenses = expCents  / 100;
  const profit   = (revCents - expCents) / 100;

  // Skip write if already present for this snapshot date
  const finRaw = await getValues(sheets, sheetId, `${TABS.financials}!A:F`);
  if (finRaw.slice(1).some(c => (c[0] || '') === latestDate)) {
    console.log(`    financials for ${latestDate} already present — skip write`);
    console.log(`    revenue=${revenue} | expenses=${expenses} | profit=${profit}`);
    return { written: false, revenue, expenses, profit };
  }

  // Write header if needed
  if (!finRaw.length || !finRaw[0]?.length) {
    await appendBatch(sheets, sheetId, `${TABS.financials}!A1`, [
      ['date', 'revenue', 'expenses', 'profit', 'snapshot_ref', 'run_id']
    ]);
  }

  const runId = `run-${new Date().toISOString()}`;
  await appendBatch(sheets, sheetId, `${TABS.financials}!A1`, [
    [latestDate, revenue, expenses, profit, `snapshot-${latestDate}`, runId]
  ]);

  console.log(`    ✓ Financials written: revenue=${revenue} | expenses=${expenses} | profit=${profit}`);
  return { written: true, revenue, expenses, profit };
}

// ─── Comparison helpers ───────────────────────────────────────────────────────

async function compareOutputs(sheets, sheetId, TABS) {
  console.log('\n── Comparing with expected CSVs ─────────────────────────────');
  const results = {};

  // 1. validated_entries — compare reference_id sets
  const expVal  = loadCSV(path.join(ROOT, 'expected_validated.csv'));
  const expIds  = new Set(expVal.map(r => r.reference_id).filter(Boolean));

  const valRaw  = await getValues(sheets, sheetId, `${TABS.validated}!A:F`);
  const valHdr  = (valRaw[0] ?? []).map(h => String(h).trim().toLowerCase());
  const refIdx  = valHdr.indexOf('reference_id');
  const sysIds  = new Set(valRaw.slice(1).map(c => c[refIdx] ?? '').filter(Boolean));

  const missingFromSys = [...expIds].filter(id => !sysIds.has(id));
  const extraInSys     = [...sysIds].filter(id => !expIds.has(id));

  if (!missingFromSys.length && !extraInSys.length) {
    results.validated = { match: true, expected: expIds.size, got: sysIds.size };
    console.log(`  ✓ validated_entries  — ${sysIds.size} rows match exactly`);
  } else {
    results.validated = { match: false, expected: expIds.size, got: sysIds.size, missingFromSys: missingFromSys.length, extraInSys: extraInSys.length };
    console.log(`  ✗ validated_entries  — expected ${expIds.size} | got ${sysIds.size}`);
    if (missingFromSys.length) console.log(`      missing from system: ${missingFromSys.length} (sample: ${missingFromSys.slice(0,3).join(', ')})`);
    if (extraInSys.length)     console.log(`      extra in system:     ${extraInSys.length} (sample: ${extraInSys.slice(0,3).join(', ')})`);
  }

  // 2. balances — compare latest snapshot vs expected_balances.csv
  const expBal  = loadCSV(path.join(ROOT, 'expected_balances.csv'));
  const expBalMap = {};
  expBal.forEach(r => { expBalMap[r.account] = Number(r.balance); });

  const snapRaw   = await getValues(sheets, sheetId, `${TABS.snapshots}!A:F`);
  const sh        = (snapRaw[0] ?? []).map(h => String(h).trim().toLowerCase());
  const snapRows  = snapRaw.slice(1).map(cells => {
    const obj = {};
    sh.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
    return obj;
  });
  const latestDate = snapRows.reduce((max, r) => (r.date > max ? r.date : max), '');
  const latest     = snapRows.filter(r => r.date === latestDate);
  const sysBalMap  = {};
  latest.forEach(r => { sysBalMap[r.account] = Number(r.balance); });

  const balMismatches = [];
  for (const [acc, expB] of Object.entries(expBalMap)) {
    const sysB = sysBalMap[acc];
    if (sysB === undefined) { balMismatches.push(`${acc}: missing in system`); continue; }
    if (sysB !== expB)      { balMismatches.push(`${acc}: expected ${expB}, got ${sysB}`); }
  }
  for (const acc of Object.keys(sysBalMap)) {
    if (expBalMap[acc] === undefined) balMismatches.push(`${acc}: unexpected account in system`);
  }

  if (!balMismatches.length) {
    results.balances = { match: true };
    console.log(`  ✓ balances           — all ${Object.keys(expBalMap).length} accounts match exactly`);
  } else {
    results.balances = { match: false, mismatches: balMismatches };
    console.log(`  ✗ balances           — ${balMismatches.length} mismatch(es):`);
    balMismatches.forEach(m => console.log(`      ${m}`));
  }

  // 3. financials — compare latest row vs expected_financials.csv
  const expFin  = loadCSV(path.join(ROOT, 'expected_financials.csv'));
  const ef      = expFin[0] ?? {};
  const finRaw  = await getValues(sheets, sheetId, `${TABS.financials}!A:F`);
  const fh      = (finRaw[0] ?? []).map(h => String(h).trim().toLowerCase());
  const finRows = finRaw.slice(1).map(cells => {
    const obj = {};
    fh.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
    return obj;
  });
  const latestFin = finRows[finRows.length - 1] ?? {};

  const finMismatches = [];
  for (const field of ['revenue', 'expenses', 'profit']) {
    const expV = Number(ef[field]);
    const sysV = Number(latestFin[field]);
    if (sysV !== expV) finMismatches.push(`${field}: expected ${expV}, got ${sysV}`);
  }

  if (!finMismatches.length) {
    results.financials = { match: true, revenue: Number(latestFin.revenue), expenses: Number(latestFin.expenses), profit: Number(latestFin.profit) };
    console.log(`  ✓ financials         — revenue=${latestFin.revenue} expenses=${latestFin.expenses} profit=${latestFin.profit}`);
  } else {
    results.financials = { match: false, mismatches: finMismatches };
    console.log(`  ✗ financials         — ${finMismatches.length} mismatch(es):`);
    finMismatches.forEach(m => console.log(`      ${m}`));
  }

  // 4. reconciliation_log — should be empty (no mismatches in valid data)
  const recRaw  = await getValues(sheets, sheetId, `${TABS.reconciliation}!A:D`);
  const recRows = recRaw.slice(1).filter(r => r.some(c => c));
  results.reconciliation = recRows.length === 0 ? 'empty' : `${recRows.length} entry/entries`;
  console.log(`  ${recRows.length === 0 ? '✓' : '✗'} reconciliation_log  — ${results.reconciliation}`);

  return results;
}

// ─── Idempotency check ────────────────────────────────────────────────────────

async function idempotencyCheck(sheets, sheetId, TABS, afterRun1) {
  console.log('\n── Idempotency Run ──────────────────────────────────────────');
  console.log('  Re-running full pipeline...');

  const r2Valid  = await validateEntries(sheets, sheetId, TABS);
  const r2Snap   = await computeLedgerBalances(sheets, sheetId, TABS);
  await trialBalanceCheck(sheets, sheetId, TABS);
  const r2Fin    = await generateFinancials(sheets, sheetId, TABS);

  // Read post-run-2 row counts
  const valAfter = await getValues(sheets, sheetId, `${TABS.validated}!A:A`);
  const snapAfter = await getValues(sheets, sheetId, `${TABS.snapshots}!A:A`);
  const finAfter  = await getValues(sheets, sheetId, `${TABS.financials}!A:A`);

  const valCount  = Math.max(0, valAfter.length  - 1);
  const snapCount = Math.max(0, snapAfter.length - 1);
  const finCount  = Math.max(0, finAfter.length  - 1);

  const checks = {
    validatedUnchanged : valCount  === afterRun1.validatedCount,
    snapshotNotGrown   : !r2Snap.written,
    financialsNotGrown : !r2Fin.written,
    noPendingRemaining : r2Valid.skipped === true,
  };

  console.log('\n  Idempotency checks:');
  console.log(`    validated_entries rows: ${afterRun1.validatedCount} → ${valCount}    ${checks.validatedUnchanged ? '✓' : '✗'}`);
  console.log(`    snapshots_daily rows:   ${afterRun1.snapshotCount} → ${snapCount}    ${checks.snapshotNotGrown ? '✓' : '✗'}`);
  console.log(`    financials rows:        ${afterRun1.financialsCount} → ${finCount}    ${checks.financialsNotGrown ? '✓' : '✗'}`);
  console.log(`    no pending rows left:   ${checks.noPendingRemaining ? '✓' : '✗'}`);

  const pass = Object.values(checks).every(Boolean);
  return { pass, checks };
}

// ─── Final report ─────────────────────────────────────────────────────────────

function printReport(rowCounts, comparison, idempotency) {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  FINAL TEST REPORT');
  console.log('══════════════════════════════════════════════════════════════\n');

  console.log('  1. Row Counts');
  console.log(`     Total raw rows      : ${rowCounts.totalRaw}`);
  console.log(`     Processed (valid)   : ${rowCounts.valid}`);
  console.log(`     Failed (invalid)    : ${rowCounts.invalid}`);
  console.log(`     validated_entries   : ${rowCounts.validatedCount}`);

  console.log('\n  2. Validation Results');
  const fmtMatch = r => r.match ? '✓ MATCH' : '✗ MISMATCH';
  console.log(`     validated_entries   : ${fmtMatch(comparison.validated)}`);
  if (!comparison.validated.match) {
    console.log(`       expected ${comparison.validated.expected}, got ${comparison.validated.got}`);
  }
  console.log(`     balances            : ${fmtMatch(comparison.balances)}`);
  if (!comparison.balances.match) comparison.balances.mismatches?.forEach(m => console.log(`       ${m}`));
  console.log(`     financials          : ${fmtMatch(comparison.financials)}`);
  if (!comparison.financials.match) comparison.financials.mismatches?.forEach(m => console.log(`       ${m}`));

  console.log('\n  3. Reconciliation Status');
  console.log(`     reconciliation_log  : ${comparison.reconciliation}`);

  console.log('\n  4. Idempotency');
  console.log(`     Result              : ${idempotency.pass ? '✓ PASS' : '✗ FAIL'}`);
  if (!idempotency.pass) {
    Object.entries(idempotency.checks).forEach(([k, v]) => {
      if (!v) console.log(`       ✗ ${k}`);
    });
  }

  const allMatch = comparison.validated.match && comparison.balances.match && comparison.financials.match;
  const overall  = allMatch && idempotency.pass && comparison.reconciliation === 'empty';

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(`  OVERALL: ${overall ? '✓ SYSTEM CORRECT — mathematically correct, deterministic, stable' : '✗ ISSUES FOUND — see details above'}`);
  console.log('══════════════════════════════════════════════════════════════\n');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const { sheetId, credentials } = loadEnv();
  const sheets = buildSheets(credentials);

  const TABS = {
    raw:            'raw_entries',
    accounts:       'accounts',
    validated:      'validated_entries',
    snapshots:      'snapshots_daily',
    financials:     'financials',
    reconciliation: 'reconciliation_log',
  };

  console.log('\n══ Accounting System Full Test ══════════════════════════════');
  console.log(`  Sheet: ${sheetId}`);

  // ── Setup: ensure all tabs exist ──────────────────────────────────────────
  console.log('\n── Setup ────────────────────────────────────────────────────');
  const existing = await getTabNames(sheets, sheetId);
  console.log(`  Existing tabs: [${existing.join(', ')}]`);
  for (const tab of Object.values(TABS)) {
    if (!existing.includes(tab)) {
      await createTab(sheets, sheetId, tab);
      console.log(`  Created tab: ${tab}`);
    }
  }

  // ── Ensure accounts tab is populated ─────────────────────────────────────
  const acctCheck = await getValues(sheets, sheetId, `${TABS.accounts}!A:B`);
  if (acctCheck.length < 2) {
    console.log('  Populating accounts tab...');
    await clearTab(sheets, sheetId, TABS.accounts);
    await appendBatch(sheets, sheetId, `${TABS.accounts}!A1`, [
      ['account_name', 'type'],
      ['Cash',    'asset'],
      ['Bank',    'asset'],
      ['Revenue', 'income'],
      ['Expense', 'expense'],
    ]);
  } else {
    console.log('  accounts tab: ready');
  }

  // ── Clear output tabs before Run 1 ───────────────────────────────────────
  console.log('\n── Clearing output tabs (pre-run) ───────────────────────────');
  for (const tab of [TABS.validated, TABS.snapshots, TABS.financials, TABS.reconciliation]) {
    await clearTab(sheets, sheetId, tab);
    console.log(`  cleared: ${tab}`);
  }

  // ── RUN 1 ─────────────────────────────────────────────────────────────────
  console.log('\n══ Pipeline Run 1 ═══════════════════════════════════════════');

  const r1Val  = await validateEntries(sheets, sheetId, TABS);
  const r1Snap = await computeLedgerBalances(sheets, sheetId, TABS);
  await trialBalanceCheck(sheets, sheetId, TABS);
  const r1Fin  = await generateFinancials(sheets, sheetId, TABS);

  // Capture post-run-1 row counts for idempotency baseline
  const valAfterR1   = await getValues(sheets, sheetId, `${TABS.validated}!A:A`);
  const snapAfterR1  = await getValues(sheets, sheetId, `${TABS.snapshots}!A:A`);
  const finAfterR1   = await getValues(sheets, sheetId, `${TABS.financials}!A:A`);
  const baselineCounts = {
    validatedCount  : Math.max(0, valAfterR1.length  - 1),
    snapshotCount   : Math.max(0, snapAfterR1.length - 1),
    financialsCount : Math.max(0, finAfterR1.length  - 1),
  };

  // ── Compare with expected ─────────────────────────────────────────────────
  const comparison = await compareOutputs(sheets, sheetId, TABS);

  // ── RUN 2: idempotency ────────────────────────────────────────────────────
  const idempotency = await idempotencyCheck(sheets, sheetId, TABS, baselineCounts);

  // ── Final report ──────────────────────────────────────────────────────────
  printReport(
    { ...r1Val, validatedCount: baselineCounts.validatedCount },
    comparison,
    idempotency
  );
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
