// ============================================================
// Flow: mark-attendance
//
// Responsibilities:
//   - Read student record from STUDENTS sheet (for name, batch)
//   - Write attendance row to ATTENDANCE sheet
//   - Send confirmation to teacher
//   - Send confirmation to student (PRESENT only)
//
// buildInitialContext():
//   - Generates unique attendanceId
//   - Records markedAt timestamp
//
// Steps:
//   1. read-student      — storage read (STUDENTS)
//   2. write-attendance  — storage write (ATTENDANCE)
//   3. confirm-teacher   — communication (condition: write succeeded)
//   4. confirm-student   — communication (condition: write succeeded AND intent = present)
// ============================================================

import type { Flow, ExecutionContext } from "../../../modules/engine/src/types";
import type { TuitionConfig, ParsedIntent } from "../src/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AttendanceEvent = {
  phone_number: string; // teacher's phone (sender)
};

export type AttendanceState = {
  config: TuitionConfig;
  parsed: ParsedIntent;
  attendanceId: string;
  markedAt: string;
};

type StudentRow = Record<string, string>;

// ---------------------------------------------------------------------------
// buildInitialContext — generate attendanceId + timestamp (pure)
// ---------------------------------------------------------------------------

export function buildInitialContext(
  event: AttendanceEvent,
  parsed: ParsedIntent,
  config: TuitionConfig,
): ExecutionContext {
  const attendanceId = `ATT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const markedAt = new Date().toISOString();

  return {
    event,
    state: { config, parsed, attendanceId, markedAt },
  };
}

// ---------------------------------------------------------------------------
// Helpers (pure, non-throwing)
// ---------------------------------------------------------------------------

function getState(ctx: ExecutionContext): AttendanceState {
  return ctx.state as AttendanceState;
}

function getStudentRows(ctx: ExecutionContext): StudentRow[] {
  const out = ctx.outputs?.["read-student"] as
    | { rows?: StudentRow[] }
    | undefined;
  return out?.rows ?? [];
}

function findStudent(
  rows: StudentRow[],
  phone: string,
): StudentRow | undefined {
  return rows.find((r) => (r["Phone"] ?? "").trim() === phone.trim());
}

function writeSucceeded(ctx: ExecutionContext): boolean {
  return ctx.outputs?.["write-attendance"] !== undefined;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const markAttendanceFlow: Flow = {
  id: "mark-attendance",
  steps: [
    // Step 1: Read STUDENTS sheet to look up name + batch
    {
      id: "read-student",
      type: "storage",
      input: (ctx: ExecutionContext) => ({
        provider: "sheets",
        operation: "read",
        resource: getState(ctx).config.studentsSheetId,
        options: { range: "STUDENTS" },
      }),
    },

    // Step 2: Write attendance row (student lookup failure is non-fatal — use phone fallback)
    {
      id: "write-attendance",
      type: "storage",
      input: (ctx: ExecutionContext) => {
        const s = getState(ctx);
        const rows = getStudentRows(ctx);
        const student = findStudent(rows, s.parsed.studentPhone ?? "");
        const studentId = student?.["Student ID"] ?? "";
        const name = student?.["Name"] ?? s.parsed.studentPhone ?? "";
        const batch = student?.["Batch"] ?? "";
        const status = s.parsed.intent === "present" ? "PRESENT" : "ABSENT";

        return {
          provider: "sheets",
          operation: "write",
          resource: s.config.attendanceSheetId,
          data: [
            s.attendanceId,
            studentId,
            s.parsed.studentPhone ?? "",
            name,
            batch,
            status,
            s.config.teacherPhone,
            s.markedAt,
          ],
          options: { range: "ATTENDANCE" },
        };
      },
    },

    // Step 3: Confirm to teacher
    {
      id: "confirm-teacher",
      type: "communication",
      condition: writeSucceeded,
      input: (ctx: ExecutionContext) => {
        const s = getState(ctx);
        const rows = getStudentRows(ctx);
        const student = findStudent(rows, s.parsed.studentPhone ?? "");
        const name = student?.["Name"] ?? s.parsed.studentPhone ?? "";
        const batch = student?.["Batch"] ?? "";
        const status = s.parsed.intent === "present" ? "PRESENT" : "ABSENT";
        const date = s.markedAt.slice(0, 10);

        return {
          to: s.config.teacherPhone,
          message: [
            "✅ Attendance marked",
            `Student : ${name} (${s.parsed.studentPhone ?? ""})`,
            `Status  : ${status}`,
            `Date    : ${date}`,
          ].join("\n"),
          provider: "meta",
        };
      },
    },

    // Step 4: Notify student — only when marked PRESENT
    {
      id: "confirm-student",
      type: "communication",
      condition: (ctx: ExecutionContext) =>
        writeSucceeded(ctx) && getState(ctx).parsed.intent === "present",
      input: (ctx: ExecutionContext) => {
        const s = getState(ctx);
        const rows = getStudentRows(ctx);
        const student = findStudent(rows, s.parsed.studentPhone ?? "");
        const name = student?.["Name"] ?? "";
        const greeting = name ? `Hi ${name}!` : "Hi!";

        return {
          to: s.parsed.studentPhone ?? "",
          message: `${greeting} Your attendance has been marked for today at ${s.config.centerName}. See you next time!`,
          provider: "meta",
        };
      },
    },
  ],
};
