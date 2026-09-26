#!/bin/bash
# R130-E double-fork daemonizer (the R129 lesson: the sandbox reaps plain background processes)
LOG="$1"; shift
nohup setsid "$@" >"$LOG" 2>&1 < /dev/null &
disown
echo "pid $!"
