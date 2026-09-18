#!/usr/bin/env bash
# scripts/release/upload-apk-asset.sh
#
# ROUND-106 (R106-S5): the Android APK's attach-to-release leg — the
# bounded/retrying/idempotent uploader for the debug APK, mirroring
# publish-github-release.sh's asset discipline (same curl profile, same
# name+size skip contract, same 500-window backoff ladder) but for ONE
# asset arriving from a DIFFERENT workflow run (mobile.yml) than the draft
# publisher (release.yml).
#
# THE RACE it must survive: mobile.yml's tag dispatch and release.yml's
# tag dispatch run in PARALLEL; the draft release only exists once
# release.yml's github-release job has created it (which needs all the
# desktop build jobs first — typically 20–30 min). So this script POLLS
# for the draft (60s interval, 35-min cap — bounded, fails loudly) before
# uploading. The APK asset never conflicts with the publisher's own assets
# (distinct name), and the skip contract makes re-runs cheap.
#
# Usage (mobile.yml's attach job):
#   bash scripts/release/upload-apk-asset.sh
# Env contract:
#   GH_TOKEN   — token with contents:write (the job's secrets.GITHUB_TOKEN)
#   REPO       — owner/name (github.repository)
#   TAG        — the tag being released (github.ref_name, "vX.Y.Z")
#   APK        — the APK file path (default: the downloaded artifact path)
# (stdlib only: bash + curl + python3 — both preinstalled on ubuntu-latest.)

set -euo pipefail

GH_TOKEN="${GH_TOKEN:?::error::GH_TOKEN is required}"
REPO="${REPO:?::error::REPO (owner/name) is required}"
TAG="${TAG:?::error::TAG (vX.Y.Z) is required}"
APK="${APK:-ACUTE-CODE_ANDROID_DEBUG.apk}"

if [ ! -f "${APK}" ]; then
  echo "::error::APK file not found: ${APK}"
  exit 1
fi

API="https://api.github.com"
UP="https://uploads.github.com"

# --- the shared curl profile (the publisher's exact discipline) ---
api() {
  curl -sS --fail-with-body \
    --connect-timeout 20 --max-time 60 \
    --retry 4 --retry-delay 5 --retry-all-errors \
    -H "Authorization: token ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "$@"
}

# --- 1. poll for the draft release (the parallel-workflow race) ---
# 35 minutes covers release.yml's slowest observed full chain (~30 min for
# the four desktop jobs + the publisher's own run) with margin; each poll
# is a bounded API call, and a miss prints where to look.
#
# R107 hotfix (the v0.102.0 attach failure, reproduced locally): the
# original block piped the API response INTO `python3 -` while ALSO
# redirecting a heredoc onto the same stdin — the heredoc wins, python
# reads its program from it, and json.load(sys.stdin) then reads EOF (the
# pipe's data never arrives); worse, the `|| true` parked on the
# heredoc-operator line made bash's parser die with "command substitution:
# syntax error near unexpected token `||'" before a single poll ran. The
# fix is the file's own asset_lookup pattern: api → temp file, python
# reads the FILE as an argument, the sniffer is a plain function (heredoc
# inside a function body parses cleanly — no multi-line substitution).
draft_id() { # $1 = tag; prints the draft release id (or nothing)
  python3 - "$1" /tmp/apk-releases.json <<'PY'
import json, sys
tag, path = sys.argv[1], sys.argv[2]
try:
    releases = json.load(open(path))
except Exception:
    releases = []
for rel in releases:
    if rel.get("tag_name") == tag and rel.get("draft") is True:
        print(rel["id"])
        break
PY
}

echo "waiting for the ${TAG} draft release to exist (release.yml runs in parallel)…"
RELEASE_ID=""
for attempt in $(seq 1 35); do
  if api "${API}/repos/${REPO}/releases" > /tmp/apk-releases.json 2>/dev/null; then
    RELEASE_ID="$(draft_id "${TAG}")"
  fi
  if [ -n "${RELEASE_ID}" ]; then
    echo "found draft release ${RELEASE_ID} for ${TAG} (attempt ${attempt})"
    break
  fi
  sleep 60
done
if [ -z "${RELEASE_ID}" ]; then
  echo "::error::no draft release for ${TAG} after 35 minutes — check the Release workflow's github-release job"
  exit 1
fi

# --- 2. the live asset lookup (name → "id size state") ---
asset_lookup() { # $1 = asset name; prints "id size state" (or nothing)
  api "${API}/repos/${REPO}/releases/${RELEASE_ID}" > /tmp/apk-release.json
  python3 - "$1" /tmp/apk-release.json <<'PY'
import json, sys
want, path = sys.argv[1], sys.argv[2]
for a in json.load(open(path)).get("assets", []):
    if a.get("name") == want:
        print("%s %s %s" % (a["id"], a.get("size") or 0, a.get("state") or "?"))
        break
PY
}

# --- 3. upload: SKIP same-size-uploaded, DELETE stale/stuck, POST with the
#        bounded profile + the 500-window backoff ladder (the publisher's
#        exact contract, learned live on the v0.100.0 dispatch) ---
name="$(basename "${APK}")"
size="$(stat -c%s "${APK}")"
label="application/vnd.android.package-archive"

attempt=1
while [ "${attempt}" -le 4 ]; do
  existing="$(asset_lookup "${name}" || true)"
  if [ -n "${existing}" ]; then
    read -r id esize estate <<<"${existing}"
    if [ "${estate}" = "uploaded" ] && [ "${esize}" = "${size}" ]; then
      echo "SKIP    ${name} — already on the draft at ${size} B (resumable contract)"
      exit 0
    fi
    echo "DELETE  ${name} — state=${estate} size=${esize} (stale/stuck; re-sending)"
    api -X DELETE "${API}/repos/${REPO}/releases/assets/${id}" > /dev/null || \
      echo "::warning::failed to delete the stale asset row — continuing (the upload will replace it)"
  fi

  echo "UPLOAD  ${name} (${size} B, attempt ${attempt})"
  if curl -sS --fail-with-body \
    --connect-timeout 20 --max-time 420 \
    --speed-limit 1024 --speed-time 60 \
    --retry 3 --retry-all-errors \
    -H "Authorization: token ${GH_TOKEN}" \
    -H "Content-Type: ${label}" \
    --data-binary "@${APK}" \
    "${UP}/repos/${REPO}/releases/${RELEASE_ID}/assets?name=${name}"; then
    echo "UPLOADED ${name}"
    exit 0
  fi

  # The 500-commit race: a failed upload may still have landed server-side.
  existing="$(asset_lookup "${name}" || true)"
  if [ -n "${existing}" ]; then
    read -r id esize estate <<<"${existing}"
    if [ "${estate}" = "uploaded" ] && [ "${esize}" = "${size}" ]; then
      echo "SKIP    ${name} — the failed attempt actually committed (${size} B)"
      exit 0
    fi
  fi

  backoff=$((attempt * 30))
  echo "retry in ${backoff}s (riding out the uploads.github.com 500 window)"
  sleep "${backoff}"
  attempt=$((attempt + 1))
done

echo "::error::failed to upload ${name} after 4 attempts"
exit 1
