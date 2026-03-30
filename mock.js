/**
 * Accounting Test Data Generator (Schema-Aligned)
 * Usage: node engine.js
 */

const fs = require('fs');

const TOTAL_ROWS = 10000;   // start small, scale later
const INVALID_RATIO = 0.1;

const ACCOUNTS = {
  assets: ['Cash', 'Bank'],
  income: ['Revenue'],
  expense: ['Expense']
};

// ---------- helpers ----------

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randAmount() {
  return Math.floor(Math.random() * 1000) + 100; // ALWAYS POSITIVE
}

function randDate() {
  const start = new Date(2026, 0, 1);
  const end = new Date(2026, 2, 31);
  return new Date(start.getTime() + Math.random() * (end - start))
    .toISOString()
    .split('T')[0];
}

function generateRow(i) {
  const row_id = `txn-${String(i + 1).padStart(6, '0')}`;

  // Inject invalid data (controlled)
  if (Math.random() < INVALID_RATIO) {
    return {
      raw: [
        row_id,
        '',                 // invalid date
        '',                 // type
        -100,               // invalid amount (will fail validation)
        '',                 // missing debit
        '',                 // missing credit
        'BadEntity',
        '',                 // notes
        'pending',
        ''                  // error_reason
      ],
      valid: false
    };
  }

  const isRevenue = Math.random() < 0.5;

  const date = randDate();
  const amount = randAmount();

  if (isRevenue) {
    return {
      raw: [
        row_id,
        date,
        'income',
        amount,
        rand(ACCOUNTS.assets),   // debit
        rand(ACCOUNTS.income),   // credit
        'Client',
        '',
        'pending',
        ''
      ],
      valid: true
    };
  } else {
    return {
      raw: [
        row_id,
        date,
        'expense',
        amount,
        rand(ACCOUNTS.expense),  // debit
        rand(ACCOUNTS.assets),   // credit
        'Vendor',
        '',
        'pending',
        ''
      ],
      valid: true
    };
  }
}

// ---------- main ----------

function main() {
  const raw = [[
    'row_id',
    'date',
    'type',
    'amount',
    'debit_account',
    'credit_account',
    'entity',
    'notes',
    'status',
    'error_reason'
  ]];

  const validated = [[
    'date',
    'debit_account',
    'credit_account',
    'amount',
    'entity',
    'reference_id'
  ]];

  const balances = {};

  let revenue = 0;
  let expenses = 0;

  for (let i = 0; i < TOTAL_ROWS; i++) {
    const row = generateRow(i);
    raw.push(row.raw);

    if (!row.valid) continue;

    const [
      row_id,
      date,
      type,
      amount,
      debit,
      credit,
      entity
    ] = row.raw;

    const reference_id = `${date}-${amount}-${debit}-${credit}-${row_id}`;

    validated.push([
      date,
      debit,
      credit,
      amount,
      entity,
      reference_id
    ]);

    // Ledger computation
    balances[debit] = (balances[debit] || 0) + amount;
    balances[credit] = (balances[credit] || 0) - amount;

    // Financials
    if (credit === 'Revenue') revenue -= amount;
    if (debit === 'Expense') expenses += amount;
  }

  const balanceRows = [['account','balance']];
  for (const [account, balance] of Object.entries(balances)) {
    balanceRows.push([account, balance]);
  }

  const financialRows = [
    ['revenue','expenses','profit'],
    [revenue, expenses, revenue - expenses]
  ];

  writeCSV('raw_entries.csv', raw);
  writeCSV('expected_validated.csv', validated);
  writeCSV('expected_balances.csv', balanceRows);
  writeCSV('expected_financials.csv', financialRows);

  console.log('✅ Dataset generated (SCHEMA CORRECT)');
  console.log(`Rows: ${TOTAL_ROWS}`);
}

// ---------- writer ----------

function writeCSV(file, rows) {
  const content = rows.map(r => r.join(',')).join('\n');
  fs.writeFileSync(file, content);
}

main();