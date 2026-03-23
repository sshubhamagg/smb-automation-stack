"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleMiningReport = handleMiningReport;
const communication = __importStar(require("communication-module"));
const engine_module_1 = require("engine-module");
const flow_1 = require("./flow");
// ---------------------------------------------------------------------------
// TASK 2: Exhaustive map from structured reason → user-facing message
// Adding a new reason here causes a TypeScript error until the message is defined.
// ---------------------------------------------------------------------------
const FAILURE_MESSAGES = {
    manager_not_found: '❌ You are not authorized to submit reports.',
    invalid_format: '❌ Invalid report format. Please follow the template.',
    unauthorized_mine: '❌ Mine name does not match your assigned mines.',
};
// ---------------------------------------------------------------------------
// handleMiningReport
//
// Single entry point for an incoming mining report event.
//
// Guarantees (TASK 5):
//   - Every failure path sends a WhatsApp response before returning
//   - No early return without a response to the manager
//
// TASK 3 — defensive communication:
//   The engine's stepExecutor already wraps every communication call in
//   try/catch and uses `res ?? null` for undefined returns. No changes to
//   the engine are needed. The sendMessage() calls in this file are also
//   individually guarded with .catch() so a delivery failure cannot crash
//   the handler.
// ---------------------------------------------------------------------------
async function handleMiningReport(event) {
    // --- Pre-flow validation (buildInitialContext = steps 1-3) ---------------
    const ctxResult = (0, flow_1.buildInitialContext)(event);
    if (!ctxResult.ok) {
        // TASK 1: Always respond on validation failure
        const msg = FAILURE_MESSAGES[ctxResult.reason];
        await communication.execute({ to: event.userId, message: msg }).catch((err) => {
            console.error('Failed to send error response:', err instanceof Error ? err.message : err);
        });
        return;
    }
    // --- Execute I/O flow (steps 4-6) ----------------------------------------
    const result = await (0, engine_module_1.runFlow)(flow_1.miningReportFlow, ctxResult.context);
    // TASK 4: Debug logging
    console.log('FLOW RESULT:', JSON.stringify(result, null, 2));
    // TASK 5: Flow-level failure — still send a response so no silent failures
    if (!result.ok) {
        await communication.execute({
            to: event.userId,
            message: '❌ Failed to process your report. Please try again.',
        }).catch((err) => {
            console.error('Failed to send flow-error response:', err instanceof Error ? err.message : err);
        });
    }
}
