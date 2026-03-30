/**
 * Mining Reporting Flow
 *
 * Accepts a WhatsApp message from a registered mine manager, parses the
 * structured text deterministically, stores the report in Google Sheets,
 * sends a confirmation to the manager, and sends a summary to the owner.
 *
 * NOTE ON STATE STEPS
 * -------------------
 * The execution engine supports step types: 'ai' | 'storage' | 'communication'.
 * There is no 'state' step type in the current engine. Pure data transformations
 * (resolve-manager, parse-message, prepare-row) are therefore implemented in
 * buildInitialContext(), which runs synchronously before runFlow() is called.
 *
 * Usage:
 *   const ctx = buildInitialContext(event);
 *   if (!ctx.ok) { handle ctx.reason; return; }
 *   const result = await runFlow(miningReportFlow, ctx.context);
 */

import fs from 'fs';
import path from 'path';
import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';

// ---------------------------------------------------------------------------
// Manager configuration — loaded from flows/config/managers.json
// ---------------------------------------------------------------------------

type ManagerConfig = {
  mines: string[];     // mines this manager is authorized to report for
  ownerPhone: string;  // phone to send summary to
  sheetId: string;     // Google Sheets document ID
};

const MANAGER_CONFIG: Record<string, ManagerConfig> = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../config/managers.json'), 'utf-8'),
) as Record<string, ManagerConfig>;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type ParsedReport = {
  mine: string;
  labor: string;
  machineA: string;
  machineB: string;
  output: string;
  material: string;
};

export type MiningReportEvent = {
  userId: string;   // E.164 phone number of the manager
  message?: string; // raw WhatsApp message body
};

export type BuildContextResult =
  | { ok: true; context: ExecutionContext }
  | { ok: false; reason: 'manager_not_found' | 'invalid_format' | 'unauthorized_mine' };

// ---------------------------------------------------------------------------
// Step 1 — Resolve manager
// Maps userId → ManagerConfig. Returns null if the phone is not registered.
// ---------------------------------------------------------------------------

function resolveManager(userId: string): ManagerConfig | null {
  return MANAGER_CONFIG[userId] ?? null;
}

// ---------------------------------------------------------------------------
// Step 2 — Parse message
// Splits the WhatsApp message text into structured fields.
//
// Expected format (each field on its own line):
//   Mine: North Mine
//   Labor: 25
//   Machine A Hours: 6
//   Machine B Hours: 4
//   Output (tons): 120
//   Material: Iron
//
// Parsing is key-insensitive. The colon after a key name is the delimiter.
// Only the first colon on a line is used as the key/value separator.
// Returns null if required fields (mine, output) are missing.
// ---------------------------------------------------------------------------

function parseMessage(raw: string): ParsedReport | null {
  const fields: Record<string, string> = {};

  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      fields[key] = value;
    }
  }

  const mine = fields['mine'] ?? '';
  const output = fields['output (tons)'] ?? '';

  // Required fields — stop here if either is absent
  if (!mine || !output) return null;

  return {
    mine,
    labor:    fields['labor']           ?? '',
    machineA: fields['machine a hours'] ?? '',
    machineB: fields['machine b hours'] ?? '',
    output,
    material: fields['material']        ?? '',
  };
}

// ---------------------------------------------------------------------------
// Step 3 — Prepare row
// Combines parsed data + manager config into a string[] for Sheets.
// Falls back to config.mine if the message didn't include a mine name.
//
// Column order: timestamp, mine, labor, machineA, machineB, output, material, managerPhone
// ---------------------------------------------------------------------------

function prepareRow(
  parsed: ParsedReport,
  config: ManagerConfig,
  userId: string,
): string[] {
  return [
    new Date().toISOString().slice(0, 10),
    parsed.mine,
    parsed.labor,
    parsed.machineA,
    parsed.machineB,
    parsed.output,
    parsed.material,
    userId,
  ];
}

// ---------------------------------------------------------------------------
// buildInitialContext — implements steps 1-3 synchronously
//
// Validates and transforms the incoming event into a populated ExecutionContext
// that the flow steps can read from ctx.state.
//
// Returns { ok: false } if:
//   - The manager phone is not registered (stop condition 1)
//   - The message is missing mine or output (stop condition 2)
// ---------------------------------------------------------------------------

export function buildInitialContext(event: MiningReportEvent): BuildContextResult {
  // Step 1: resolve manager
  const config = resolveManager(event.userId);
  if (!config) {
    return { ok: false, reason: 'manager_not_found' };
  }

  // Step 2: parse message
  const parsed = parseMessage(event.message ?? '');
  if (!parsed) {
    return { ok: false, reason: 'invalid_format' };
  }

  // Step 2b: validate mine ownership (case and whitespace insensitive)
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const matchedMine = config.mines.find(m => normalize(m) === normalize(parsed.mine));
  if (!matchedMine) {
    return { ok: false, reason: 'unauthorized_mine' };
  }

  // Use canonical casing from config
  const canonicalParsed = { ...parsed, mine: matchedMine };

  // Step 3: prepare row
  const row = prepareRow(canonicalParsed, config, event.userId);

  return {
    ok: true,
    context: {
      event,
      state: {
        config,
        parsed: canonicalParsed,
        row,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// miningReportFlow — steps 4-6 (all I/O)
// ---------------------------------------------------------------------------

export const miningReportFlow: Flow = {
  id: 'mining-report',
  steps: [

    // Step 4 — store-report
    // Writes the prepared row to Google Sheets.
    {
      id: 'store-report',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider: 'sheets',
        operation: 'write',
        resource: ctx.state?.['config']?.sheetId,
        data: ctx.state?.['row'],
        options: { range: 'Sheet1' },
      }),
    },

    // Step 5 — reply-manager
    // Sends a confirmation message to the manager who submitted the report.
    {
      id: 'reply-manager',
      type: 'communication',
      input: (ctx: ExecutionContext) => ({
        to: ctx.event?.userId,
        message:
          `✅ Report submitted for ${ctx.state?.['parsed']?.mine}\n` +
          `Output: ${ctx.state?.['parsed']?.output} tons`,
      }),
    },

  ],
};
