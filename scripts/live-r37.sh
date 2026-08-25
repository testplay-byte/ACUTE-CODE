#!/bin/bash
# ROUND-37 live battery v3 — every agent-browser call wrapped in `timeout`.
set -u
cd /home/z/PROJECT/ACUTECODE
mkdir -p .dev/live-r37
SHOTS=/home/z/PROJECT/ACUTECODE/.dev/live-r37
LOG=$SHOTS/battery.log
: > $LOG
log() { echo "$(date +%H:%M:%S) $1" | tee -a $LOG; }
ab() { timeout "${AB_T:-60}" agent-browser "$@" >/dev/null 2>&1; }

# Kill by PORT (pattern pkills can match the harness's own processes).
fuser -k 5178/tcp 2>/dev/null; fuser -k 5173/tcp 2>/dev/null
sleep 1
rm -f .dev/acute-r37.db .dev/acute-r37.db-shm .dev/acute-r37.db-wal .dev/ACUTEST2/approval-evidence.txt
rm -f $SHOTS/*.png

# pre-warm the browser daemon (cold start can take 30s+)
timeout 90 agent-browser open "about:blank" >/dev/null 2>&1
log "browser daemon warm"

ACUTE_TOKEN=acute-dev-local ACUTE_PORT=5178 ACUTE_DB_PATH=.dev/acute-r37.db \
ACUTE_PROVIDER_OPENROUTER=$(cat /home/z/.secrets/openrouter.key) \
  node agent-core/dist/main.js > $SHOTS/sidecar.log 2>&1 &
SIDECAR_PID=$!
for i in $(seq 1 40); do grep -q "ACUTE_READY" $SHOTS/sidecar.log 2>/dev/null && break; sleep 0.5; done
if grep -q "ACUTE_READY" $SHOTS/sidecar.log; then
  log "sidecar ok"
else
  log "SIDECAR BOOT FAILED — log:"
  cat $SHOTS/sidecar.log | tee -a $LOG
  kill $SIDECAR_PID 2>/dev/null
  exit 1
fi

TOKEN="acute-dev-local"
PROJECT_ID=$(curl -s -X POST http://127.0.0.1:5178/api/v1/projects -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"ACUTEST2","rootPath":"/home/z/PROJECT/ACUTECODE/.dev/ACUTEST2"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
curl -s -X POST http://127.0.0.1:5178/api/v1/agents -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"Acute","systemPrompt":"You are a concise coding agent. Use tools when asked.","providerId":"openrouter","model":"stealth/ox-alpha","temperature":0.2,"maxTurns":8,"allowedTools":["list_dir","read_file","run_command","write_file"]}' > /dev/null
log "seed ok: $PROJECT_ID"

PATH="/home/z/.local/bin:$PATH" nohup npx vite --port 5173 --strictPort > $SHOTS/vite.log 2>&1 &
VITE_PID=$!
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:5173 && break; sleep 0.5; done
log "vite ok"

ab set viewport 1600 900
# First-run gate: mark setup done (fresh browser profile) before routing.
ab open "http://localhost:5173/"
sleep 2
ab eval "localStorage.setItem('acute.setupDone','1')"
ab open "http://localhost:5173/project/$PROJECT_ID/chat"
sleep 4
ab screenshot $SHOTS/00-empty-state.png
log "empty shot ok"

ab fill "textarea" "Which files are in the COW folder? Use the list_dir tool."
ab press Enter "textarea"
log "question sent"

AB_T=220 ab wait --text "Worked for"
if [ $? -eq 0 ]; then log "TURN COMPLETED"; else log "TURN TIMEOUT"; fi
sleep 2
ab screenshot $SHOTS/01-turn-complete.png
log "shot 01"

ab find text "Worked for" click
sleep 1
ab screenshot $SHOTS/02-working-expanded.png
ab find text "Thought for" click
sleep 1
ab screenshot $SHOTS/03-thought-expanded.png
log "shots 02-03"

ab open "http://localhost:5173/settings?tab=api"
sleep 3
ab screenshot $SHOTS/04-providers-flat.png
ab find text "Add provider" click
sleep 1
ab screenshot $SHOTS/05-add-dialog.png
ab find text "Custom provider" click
sleep 1
ab screenshot $SHOTS/06-add-custom-fields.png
log "settings shots"

ab open "http://localhost:5173/project/$PROJECT_ID/chat"
sleep 3
ab fill "textarea" "Run this exact command with the run_command tool: printf live-proof > approval-evidence.txt"
ab press Enter "textarea"
log "approval command sent"

AB_T=170 ab wait --text "Permission needed"
if [ $? -eq 0 ]; then
  log "PERMISSION CARD APPEARED"
  ab screenshot $SHOTS/07-approval-card.png
  ab find text "Allow once" click
  log "Allow once clicked"
  AB_T=220 ab wait --text "Worked for"
  if [ $? -eq 0 ]; then log "APPROVAL TURN COMPLETED"; else log "approval turn timeout"; fi
  sleep 2
  ab screenshot $SHOTS/08-after-approval.png
  if [ -f .dev/ACUTEST2/approval-evidence.txt ]; then
    log "APPROVAL FLOW PROVEN: file = $(cat .dev/ACUTEST2/approval-evidence.txt)"
  else
    log "file NOT on disk"
  fi
else
  log "permission card timeout"
fi

timeout 30 agent-browser errors > $SHOTS/errors.txt 2>&1
ab close
kill $SIDECAR_PID $VITE_PID 2>/dev/null
pkill -f "agent-core/dist/main.js" 2>/dev/null
pkill -f "vite" 2>/dev/null
log "DONE"
cat $LOG
