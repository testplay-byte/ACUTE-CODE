#!/bin/bash
# ROUND-37 settings battery — provider detail + Add dialog evidence.
set -u
cd /home/z/PROJECT/ACUTECODE
SHOTS=/home/z/PROJECT/ACUTECODE/.dev/live-r37
LOG=$SHOTS/settings-battery.log
: > $LOG
log() { echo "$(date +%H:%M:%S) $1" | tee -a $LOG; }
ab() { timeout "${AB_T:-40}" agent-browser "$@" >/dev/null 2>&1; }

fuser -k 5178/tcp 2>/dev/null; fuser -k 5173/tcp 2>/dev/null
sleep 1

ACUTE_TOKEN=acute-dev-local ACUTE_PORT=5178 ACUTE_DB_PATH=.dev/acute-r37.db \
ACUTE_PROVIDER_OPENROUTER=$(cat /home/z/.secrets/openrouter.key) \
  node agent-core/dist/main.js > $SHOTS/sidecar.log 2>&1 &
SIDECAR_PID=$!
for i in $(seq 1 40); do grep -q "ACUTE_READY" $SHOTS/sidecar.log 2>/dev/null && break; sleep 0.5; done
grep -q "ACUTE_READY" $SHOTS/sidecar.log || { log "SIDECAR FAILED"; exit 1; }
log "sidecar ok"

PATH="/home/z/.local/bin:$PATH" nohup npx vite --port 5173 --strictPort > $SHOTS/vite.log 2>&1 &
VITE_PID=$!
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:5173 && break; sleep 0.5; done
log "vite ok"

ab open "http://localhost:5173/"
sleep 2
ab eval "localStorage.setItem('acute.setupDone','1')"
ab open "http://localhost:5173/settings?tab=api"
sleep 4
ab screenshot $SHOTS/04-providers-flat.png
log "flat list shot"

# Select the OpenRouter row (aria-current list button containing "OpenRouter")
timeout 40 agent-browser find text "OpenRouter" click 2>/dev/null
sleep 2
ab screenshot $SHOTS/04b-provider-detail.png
log "detail shot"

# Open the Add Provider dialog
timeout 40 agent-browser find text "Add provider" click 2>/dev/null
sleep 2
ab screenshot $SHOTS/05-add-dialog.png
log "dialog shot"

timeout 40 agent-browser find text "Custom provider" click 2>/dev/null
sleep 2
ab screenshot $SHOTS/06-add-custom-fields.png
log "custom fields shot"

timeout 30 agent-browser errors > $SHOTS/settings-errors.txt 2>&1
ab close
kill $SIDECAR_PID $VITE_PID 2>/dev/null
fuser -k 5178/tcp 2>/dev/null; fuser -k 5173/tcp 2>/dev/null
log "DONE"
cat $LOG
