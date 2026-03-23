#!/bin/bash
export LEDGER_MODE=ai
export LEDGER_AI_PROVIDER=local
export LOCAL_AI_MODEL=mistral
export LOCAL_AI_URL=http://localhost:11434

LOG=/tmp/ledger-e2e-ai.log
rm -f "$LOG"

echo "Starting E2E test with AI mode (Mistral)..." | tee "$LOG"
echo "Log: $LOG"

npx ts-node test-e2e.ts 2>&1 | tee -a "$LOG"

EXIT=${PIPESTATUS[0]}
echo ""
echo "Exit code: $EXIT" | tee -a "$LOG"
exit $EXIT
