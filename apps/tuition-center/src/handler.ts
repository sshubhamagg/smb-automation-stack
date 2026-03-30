import { execute as storageExecute } from 'storage-module';
import * as communication from 'communication-module';
import { run as intelligenceRun } from 'intelligence-module';
import { runFlow } from 'engine-module';
import type { Modules } from 'engine-module';

import {
  buildInitialContext as buildRouterCtx,
  intentRouterFlow,
  resolveRouting,
} from '../../../flows/tuition-center/intent-router/flow';
import {
  buildInitialContext as buildMarkAttendanceCtx,
  markAttendanceFlow,
} from '../../../flows/tuition-center/mark-attendance/flow';
import {
  buildInitialContext as buildRecordPaymentCtx,
  recordPaymentFlow,
} from '../../../flows/tuition-center/record-payment/flow';
import {
  buildInitialContext as buildQueryAttendanceCtx,
  queryAttendanceFlow,
} from '../../../flows/tuition-center/query-attendance/flow';
import {
  buildInitialContext as buildQueryFeesCtx,
  queryFeesFlow,
} from '../../../flows/tuition-center/query-fees/flow';
import {
  buildInitialContext as buildInitFeesCtx,
  initFeesFlow,
} from '../../../flows/tuition-center/init-fees/flow';
import {
  buildInitialContext as buildFeeRemindersCtx,
  feeRemindersFlow,
  classifyFees,
} from '../../../flows/tuition-center/fee-reminders/flow';

import type { TuitionConfig, IncomingMessage } from '../../../flows/tuition-center/src/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig(): TuitionConfig {
  const studentsSheetId  = process.env['TUITION_STUDENTS_SHEET_ID'];
  const attendanceSheetId = process.env['TUITION_ATTENDANCE_SHEET_ID'];
  const feesSheetId      = process.env['TUITION_FEES_SHEET_ID'];
  const remindersSheetId = process.env['TUITION_REMINDERS_SHEET_ID'];
  const teacherPhone     = process.env['TUITION_TEACHER_PHONE'];
  const centerName       = process.env['TUITION_CENTER_NAME'];

  if (
    !studentsSheetId || !attendanceSheetId || !feesSheetId ||
    !remindersSheetId || !teacherPhone || !centerName
  ) {
    throw new Error(
      'Missing required env vars: TUITION_STUDENTS_SHEET_ID, TUITION_ATTENDANCE_SHEET_ID, ' +
      'TUITION_FEES_SHEET_ID, TUITION_REMINDERS_SHEET_ID, TUITION_TEACHER_PHONE, TUITION_CENTER_NAME',
    );
  }

  return {
    studentsSheetId,
    attendanceSheetId,
    feesSheetId,
    remindersSheetId,
    teacherPhone,
    centerName,
    mode:       (process.env['TUITION_MODE']        ?? 'structured') as 'structured' | 'ai',
    aiProvider: (process.env['TUITION_AI_PROVIDER'] ?? 'anthropic')  as 'openai' | 'anthropic' | 'local' | 'nvidia',
  };
}

// ---------------------------------------------------------------------------
// Modules wiring
// ---------------------------------------------------------------------------

const modules: Modules = {
  storage:       (input: unknown) => storageExecute(input as Parameters<typeof storageExecute>[0]),
  communication: (input: unknown) => communication.execute(input as { to: string; message: string }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intelligence:  (input: unknown) => intelligenceRun(input as any),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function send(to: string, message: string): Promise<void> {
  await communication.execute({ to, message }).catch((err: unknown) => {
    console.error('[tuition] send failed:', err instanceof Error ? err.message : err);
  });
}

function formatMonthLabel(month: string): string {
  const [year, mon] = month.split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const idx = parseInt(mon ?? '1') - 1;
  return `${names[idx] ?? mon} ${year}`;
}

// ---------------------------------------------------------------------------
// handleTeacherMessage — inbound WhatsApp dispatch
// ---------------------------------------------------------------------------

export async function handleTeacherMessage(msg: IncomingMessage): Promise<void> {
  const phone = msg.phone_number;
  const text  = msg.text_body?.trim() ?? '';

  let config: TuitionConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('[tuition] Config error:', err instanceof Error ? err.message : err);
    await send(phone, 'Service misconfigured. Please contact support.');
    return;
  }

  // ── Step 1: Intent router ──────────────────────────────────────────────────
  const routerCtx    = buildRouterCtx({ message: text, user: phone }, config);
  const routerResult = await runFlow(intentRouterFlow, routerCtx, modules);

  if (!routerResult.ok) {
    console.error('[tuition] router failed:', routerResult.error);
    await send(phone, 'Could not process your request. Please try again.');
    return;
  }

  // ── Step 2: Resolve routing ────────────────────────────────────────────────
  const routing = resolveRouting(routerResult.context);

  if (!routing) {
    if (config.mode === 'ai') {
      await send(phone, 'Could not extract intent. Try: present +<phone>, paid +<phone> <amount>');
    }
    return;
  }

  const { nextFlow, parsed } = routing;
  console.log(`[tuition] → ${nextFlow} (${phone})`);

  // ── Step 3: Dispatch to sub-flow ───────────────────────────────────────────

  if (nextFlow === 'mark-attendance') {
    const ctx    = buildMarkAttendanceCtx({ phone_number: phone }, parsed, config);
    const result = await runFlow(markAttendanceFlow, ctx, modules);
    if (!result.ok) {
      console.error('[tuition/mark-attendance] failed:', result.error);
      await send(phone, 'Failed to mark attendance. Please try again.');
    }
    return;
  }

  if (nextFlow === 'record-payment') {
    const ctx    = buildRecordPaymentCtx({ phone_number: phone }, parsed, config);
    const result = await runFlow(recordPaymentFlow, ctx, modules);
    if (!result.ok) {
      console.error('[tuition/record-payment] failed:', result.error);
      await send(phone, 'Failed to record payment. Please try again.');
    }
    return;
  }

  if (nextFlow === 'query-attendance') {
    const ctx    = buildQueryAttendanceCtx({ phone_number: phone }, parsed, config);
    const result = await runFlow(queryAttendanceFlow, ctx, modules);
    if (!result.ok) {
      console.error('[tuition/query-attendance] failed:', result.error);
      await send(phone, 'Failed to fetch attendance. Please try again.');
    }
    return;
  }

  if (nextFlow === 'query-fees') {
    const ctx    = buildQueryFeesCtx({ phone_number: phone }, parsed, config);
    const result = await runFlow(queryFeesFlow, ctx, modules);
    if (!result.ok) {
      console.error('[tuition/query-fees] failed:', result.error);
      await send(phone, 'Failed to fetch fees. Please try again.');
    }
    return;
  }

  console.error('[tuition] Unhandled nextFlow:', nextFlow);
}

// ---------------------------------------------------------------------------
// handleFeeInit — 1st-of-month cron (reads students, writes fee rows per student)
// ---------------------------------------------------------------------------

export async function handleFeeInit(): Promise<void> {
  let config: TuitionConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('[tuition] handleFeeInit config error:', err instanceof Error ? err.message : err);
    return;
  }

  const triggeredAt = new Date().toISOString();
  const ctx         = buildInitFeesCtx({ triggeredAt }, config);
  const result      = await runFlow(initFeesFlow, ctx, modules);

  if (!result.ok) {
    console.error('[tuition] init-fees flow failed:', result.error);
    return;
  }

  const { month, dueDate } = ctx.state as { month: string; dueDate: string };
  const studentsOut = result.context.outputs?.['read-students'] as
    | { rows?: Record<string, string>[] }
    | undefined;
  const students = studentsOut?.rows ?? [];

  console.log(`[tuition] fee-init: ${students.length} students found for ${month}`);

  let written = 0;
  for (const student of students) {
    if ((student['Status'] ?? '').trim() !== 'ACTIVE') continue;

    const studentId = student['Student ID'] ?? '';
    const feeId     = `FEE-${month}-${studentId}`;

    const feeRow = [
      feeId,
      studentId,
      student['Phone']       ?? '',
      student['Name']        ?? '',
      month,
      student['Monthly Fee'] ?? '0',
      '0',
      'UNPAID',
      dueDate,
      '',
    ];

    const writeResult = await storageExecute({
      provider:  'sheets',
      operation: 'write',
      resource:  config.feesSheetId,
      data:      feeRow,
      options:   { range: 'FEES' },
    });

    if (!writeResult.ok) {
      console.error(`[tuition] fee-init write failed for ${studentId}:`, writeResult.error);
    } else {
      written++;
    }
  }

  console.log(`[tuition] fee-init: ${written} fee rows written for ${month}`);
}

// ---------------------------------------------------------------------------
// handleFeeReminders — daily cron (sends per-student reminder messages)
// ---------------------------------------------------------------------------

export async function handleFeeReminders(): Promise<void> {
  let config: TuitionConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('[tuition] handleFeeReminders config error:', err instanceof Error ? err.message : err);
    return;
  }

  const triggeredAt = new Date().toISOString();
  const ctx         = buildFeeRemindersCtx({ triggeredAt }, config);
  const result      = await runFlow(feeRemindersFlow, ctx, modules);

  if (!result.ok) {
    console.error('[tuition] fee-reminders flow failed:', result.error);
    return;
  }

  const { runDate, month } = ctx.state as { runDate: string; month: string };
  const feesOut = result.context.outputs?.['read-fees'] as
    | { rows?: Record<string, string>[] }
    | undefined;
  const rows = feesOut?.rows ?? [];

  const { overdue, dueSoon } = classifyFees(rows, runDate, month);
  const monthLabel = formatMonthLabel(month);

  // Send individual overdue reminders to each student
  for (const row of overdue) {
    const studentPhone = row['Student Phone'] ?? '';
    const name         = row['Name']          ?? '';
    const amountDue    = row['Amount Due']    ?? '0';
    if (!studentPhone) continue;

    await send(
      studentPhone,
      `⚠️ Fee Reminder — ${config.centerName}\nHi ${name}, your fee of ₹${amountDue} for ${monthLabel} is overdue.\nPlease pay at the earliest. Contact teacher for details.`,
    );
  }

  // Send individual due-soon reminders to each student
  for (const row of dueSoon) {
    const studentPhone = row['Student Phone'] ?? '';
    const name         = row['Name']          ?? '';
    const amountDue    = row['Amount Due']    ?? '0';
    const dueDate      = row['Due Date']      ?? '';
    if (!studentPhone) continue;

    await send(
      studentPhone,
      `📅 Fee Due Soon — ${config.centerName}\nHi ${name}, your fee of ₹${amountDue} for ${monthLabel} is due on ${dueDate}.`,
    );
  }

  if (overdue.length > 0 || dueSoon.length > 0) {
    console.log(
      `[tuition] fee-reminders: ${overdue.length} overdue, ${dueSoon.length} due-soon sent at ${runDate}`,
    );
  } else {
    console.log(`[tuition] fee-reminders: all fees on track for ${month}`);
  }
}
