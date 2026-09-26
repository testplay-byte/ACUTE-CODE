#!/usr/bin/env bash
# scripts/release/publish-github-release.sh
#
# ROUND-103 (the release-pipeline hardening): the deterministic, resumable
# release-asset uploader. Replaces softprops/action-gh-release@v2 in the
# github-release job of .github/workflows/release.yml.
#
# WHY (the incident record, v0.100.0 tag run 35243431119): the action's
# concurrent uploader hung three times on the 135 MB amd64.AppImage — the
# first two attempts died on "Headers Timeout Error" (undici's
# headersTimeout firing when the uploads.github.com connection stalls
# mid-transfer; the action configures NO client-side upload timeout), and
# the third hung silently for 27+ minutes until manual cancellation. Worse,
# every re-run DELETED the five already-uploaded assets before re-sending
# everything, so a single flaky asset turned a 10-minute release into a
# multi-hour stall with zero forward progress and a half-emptied draft.
#
# THE CONTRACT (the three properties the action could not give us):
#   1. BOUNDED   — every network call carries an explicit timeout. Asset
#                  uploads get --max-time 420 plus the stalled-transfer
#                  detector (--speed-limit 1024 --speed-time 60: below
#                  1 KB/s for 60s = the connection is dead, abort now);
#                  the calling step/job carries timeout-minutes as the hard
#                  backstop, so a wedged upload FAILS LOUDLY in minutes
#                  instead of hanging for hours.
#   2. RETRYING  — per-asset curl retries (--retry 3 --retry-all-errors,
#                  which covers transient 5xx AND connection resets), plus
#                  one script-level re-attempt, so one bad minute on
#                  GitHub's upload tier no longer kills the run.
#   3. RESUMABLE — uploads are keyed by (name, size): an asset already on
#                  the draft with the matching byte count is SKIPPED.
#                  Re-running the job re-sends only what is missing; a
#                  size-mismatched stale asset is deleted and re-sent
#                  individually. Re-runs are cheap and never destructive.
#
# It also cleans up the multi-draft mess the action left behind: when
# several drafts exist for the tag, the oldest is reused and the rest are
# deleted; a PUBLISHED release for the tag fails loudly (the repo's re-tag
# discipline: delete the release before re-tagging).
#
# The release is left as a DRAFT on success — publishing stays a
# deliberate, verified act (the standing round discipline), performed by
# the round's close-out after CI+Release both verify green.
#
# Usage (the github-release job):
#   bash scripts/release/publish-github-release.sh
# Env contract:
#   GH_TOKEN   — token with contents:write (the job's secrets.GITHUB_TOKEN)
#   REPO       — owner/name (github.repository)
#   TAG        — the tag being released (github.ref_name, "vX.Y.Z")
#   BUILD_LINUX — optional "true"/"false" (default "true"): the R129-GHA
#                 release-target selection — "false" (scripts/release/
#                 targets.json says linux:false) means the four Linux
#                 bundle assets are NOT part of this release: they are
#                 absent from the manifest, the upload set, and the final
#                 verify list. The kit + the Windows installer are ALWAYS
#                 part of the contract (the owner's daily driver).
#   VERSION    — the repo version X.Y.Z (needs.launcher-kit.outputs.version)
#   CHANGELOG  — body source (default: CHANGELOG.md at the repo root)
# Artifact layout expected (the job's download-artifact steps):
#   ./acute-launcher-kit-v$VERSION.zip
#   ./installer/ACUTE-CODE_${VERSION}_x64-setup.exe
#   ./linux-bundles/ACUTE-CODE_${VERSION}_amd64.{deb,AppImage}
#   ./linux-bundles-arm64/ACUTE-CODE_${VERSION}_{arm64.deb,aarch64.AppImage}
# (stdlib only: bash + curl + python3 — both preinstalled on ubuntu-latest.)

set -euo pipefail

GH_TOKEN="${GH_TOKEN:?::error::GH_TOKEN is required}"
REPO="${REPO:?::error::REPO (owner/name) is required}"
TAG="${TAG:?::error::TAG (vX.Y.Z) is required}"
VERSION="${VERSION:?::error::VERSION (X.Y.Z) is required}"
CHANGELOG="${CHANGELOG:-CHANGELOG.md}"

API="https://api.github.com"
UP="https://uploads.github.com"

TMPI="$(mktemp -d)"
trap 'rm -rf "${TMPI}"' EXIT

# --- the shared curl profile for JSON API calls (list/create/patch/delete) ---
api() {
  curl -sS --fail-with-body \
    --connect-timeout 20 --max-time 60 \
    --retry 4 --retry-delay 5 --retry-all-errors \
    -H "Authorization: token ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

# --- 1. the asset manifest (smallest first: the flaky giants upload last,
#        so a stall near the end has already banked the small wins) ---
# R129-GHA (the release-target selection): BUILD_LINUX=false trims the four
# Linux bundle assets from the contract (targets.json's linux:false — the
# owner's "skipping your Linux version sometimes if you don't need it").
BUILD_LINUX="${BUILD_LINUX:-true}"
declare -a FILES=(
  "acute-launcher-kit-v${VERSION}.zip"
  "installer/ACUTE-CODE_${VERSION}_x64-setup.exe"
)
if [ "${BUILD_LINUX}" = "true" ]; then
  FILES+=(
    "linux-bundles/ACUTE-CODE_${VERSION}_amd64.deb"
    "linux-bundles-arm64/ACUTE-CODE_${VERSION}_arm64.deb"
    "linux-bundles/ACUTE-CODE_${VERSION}_amd64.AppImage"
    "linux-bundles-arm64/ACUTE-CODE_${VERSION}_aarch64.AppImage"
  )
fi
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "::error::missing artifact '${f}' — the download-artifact steps must run before this script"
    exit 1
  fi
done
echo "release contract: ${#FILES[@]} assets for ${TAG} (version ${VERSION}, linux=${BUILD_LINUX})"

# --- 2. find (or create) THE draft release for this tag -----------------
# Walk the release list (drafts included, paginated), collecting every
# release keyed to this tag into matches.txt ("id|draft01|created_at",
# ASCENDING creation order — the list endpoint is newest-first).
#
# The match predicate carries the re-tag lesson from the r103 test rig:
# a draft whose git tag does not exist reports tag_name as
# "untagged-<sha>" — that is EXACTLY the state a hotfix re-tag leaves
# behind (delete tag → commit fix → re-tag → re-push), so a draft also
# matches when it is a draft, its NAME is the tag, and its tag_name is
# untagged-*. Without this, every re-tag would mint a fresh draft and
# leave the previous one as an invisible zombie.
page=1
: > "${TMPI}/matches.txt"
while :; do
  if ! api "${API}/repos/${REPO}/releases?per_page=100&page=${page}" > "${TMPI}/page.json"; then
    echo "::error::failed to list releases (page ${page})"
    exit 1
  fi
  n=$(python3 - "${TAG}" "${TMPI}/page.json" "${TMPI}/matches.txt" <<'PY'
import json, sys
tag, pagefile, matchfile = sys.argv[1], sys.argv[2], sys.argv[3]
releases = json.load(open(pagefile))
matches = []
for r in releases:
    name = r.get("tag_name") or ""
    is_draft = bool(r.get("draft"))
    if name == tag or (is_draft and (r.get("name") or "") == tag and name.startswith("untagged-")):
        matches.append((r.get("created_at") or "", r["id"], 1 if is_draft else 0))
matches.sort()  # ascending creation order → the first line is the OLDEST
with open(matchfile, "a", encoding="utf-8") as fh:
    for created, rid, draft in matches:
        fh.write("%s|%d|%s\n" % (rid, draft, created))
print(len(releases))
PY
)
  [ "${n}" -lt 100 ] && break
  page=$((page + 1))
done

RELEASE_ID=""
if [ -s "${TMPI}/matches.txt" ]; then
  while IFS='|' read -r id draft created; do
    [ -z "${id:-}" ] && continue
    if [ "${draft}" = "0" ]; then
      echo "::error::a PUBLISHED release (${id}) already exists for ${TAG} — the re-tag discipline requires deleting it before re-tagging; refusing to touch it"
      exit 1
    fi
    if [ -z "${RELEASE_ID}" ]; then
      RELEASE_ID="${id}"   # first line = the oldest (matches are sorted ascending)
      echo "reusing draft release ${id} (created ${created}) for ${TAG}"
    else
      echo "deleting duplicate draft ${id} (created ${created}) for ${TAG}"
      if ! api -X DELETE "${API}/repos/${REPO}/releases/${id}" > /dev/null; then
        echo "::warning::failed to delete duplicate draft ${id} — continuing (the final verify step only counts assets on the kept draft)"
      fi
    fi
  done < "${TMPI}/matches.txt"
fi

# The release notes JSON (name + body from the tagged commit's CHANGELOG),
# WRITTEN TO A FILE — never passed as a curl -d ARGUMENT: the real
# CHANGELOG is ~200 KB and a single argv string is capped at 128 KB by the
# kernel (MAX_ARG_STRLEN — "Argument list too long", the bug the first
# real dispatch caught that the tiny-fixture rig could not).
# GitHub's release-body ceiling is 125,000 characters: a larger body is
# silently truncated mid-sentence SERVER-SIDE (the v0.99.0 release body is
# exactly that truncation signature at 124,996 chars). The script truncates
# deliberately at a paragraph boundary with a pointer note instead.
notes_file() { # $1 = "create"|"refresh"; writes ${TMPI}/release-notes.json
  python3 - "$1" "${TAG}" "${CHANGELOG}" "${TMPI}/release-notes.json" <<'PY'
import json, sys
mode, tag, path, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    with open(path, "r", encoding="utf-8") as fh:
        notes = fh.read()
except OSError:
    notes = ""
LIMIT = 124000  # GitHub truncates at 125,000 chars; leave margin for the note
if len(notes) > LIMIT:
    cut = notes.rfind("\n\n", 0, LIMIT)
    if cut == -1:
        cut = LIMIT
    notes = notes[:cut] + "\n\n---\n\n(Older entries live in `CHANGELOG.md` in the repository.)\n"
if mode == "create":
    payload = {"tag_name": tag, "name": tag, "body": notes, "draft": True}
else:
    # tag_name is included so a re-tagged reused draft (tag_name=untagged-…)
    # is re-pointed at the freshly pushed tag in the same call.
    payload = {"tag_name": tag, "name": tag, "body": notes}
with open(out, "w", encoding="utf-8") as fh:
    json.dump(payload, fh)
PY
}

if [ -z "${RELEASE_ID}" ]; then
  echo "no draft for ${TAG} — creating one"
  notes_file create
  RELEASE_ID=$(api -X POST "${API}/repos/${REPO}/releases" \
    -H "Content-Type: application/json" \
    -d "@${TMPI}/release-notes.json" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])') || {
      echo "::error::draft release creation failed"
      exit 1
    }
  echo "created draft release ${RELEASE_ID} for ${TAG}"
else
  # Reused draft → refresh name+body from THIS commit's CHANGELOG so a
  # re-tag never leaves the previous attempt's notes behind.
  notes_file refresh
  api -X PATCH "${API}/repos/${REPO}/releases/${RELEASE_ID}" \
    -H "Content-Type: application/json" \
    -d "@${TMPI}/release-notes.json" > /dev/null
  echo "refreshed the draft's name/body from ${CHANGELOG}"
fi

# --- 3. live asset lookup on the draft (name → "id size state") -------------
# Re-fetched before EACH asset decision so skip/delete sees live state.
# State matters: a row in a non-"uploaded" state is a STUCK upload — it
# must be deleted, never trusted (a size-match on a stuck row would skip
# an asset nobody can download).
asset_lookup() { # $1 = asset name; prints "id size state" (or nothing)
  api "${API}/repos/${REPO}/releases/${RELEASE_ID}" > "${TMPI}/release.json"
  python3 - "$1" "${TMPI}/release.json" <<'PY'
import json, sys
want, path = sys.argv[1], sys.argv[2]
for a in json.load(open(path)).get("assets", []):
    if a.get("name") == want:
        print("%s %s %s" % (a["id"], a.get("size") or 0, a.get("state") or "?"))
        break
PY
}

# --- 4. upload one asset: SKIP same-size-uploaded, DELETE stale/stuck,
#        POST with the bounded curl profile, RIDE OUT the 500 window -----
#
# THE 500 WINDOW (learned live on the v0.100.0 dispatch, runs 35258020425
# attempts 1–2): uploads.github.com intermittently answers HTTP 500 to a
# FULLY-SENT large upload — nine times in a row for ONE asset at a time
# (~40–70 s of transfer, then 500), while other assets succeed, and the
# window heals after ~5–10 minutes (arm64.deb 500ed 18:27–18:32, uploaded
# fine at 18:35; amd64.AppImage then took its turn). Two defenses:
#   - THE 500-COMMIT RACE: a failed upload may STILL have been committed
#     server-side — after every failed attempt, re-check the draft; if the
#     asset is there, state=uploaded, byte-exact, it COUNTS as done.
#   - THE BACKOFF LADDER: 30/60/120 s between script-level attempts (4
#     attempts), riding out the window instead of hammering it — curl's
#     own rapid retries only burn the poisoned window.
upload_asset() { # $1 = file path
  local file="$1" name size existing id esize estate attempt rc
  name="$(basename "${file}")"
  size="$(stat -c%s "${file}")"
  existing="$(asset_lookup "${name}" || true)"
  if [ -n "${existing}" ]; then
    read -r id esize estate <<<"${existing}"
    if [ "${estate}" = "uploaded" ] && [ "${esize}" = "${size}" ]; then
      echo "SKIP    ${name} — already on the draft at ${size} B (resumable contract)"
      return 0
    fi
    echo "STALE   ${name} — draft has ${esize} B (${estate}), disk has ${size} B → delete + re-upload"
    if ! api -X DELETE "${API}/repos/${REPO}/releases/assets/${id}" > /dev/null; then
      echo "::error::failed to delete stale asset ${name} (${id})"
      return 1
    fi
  fi
  echo "UPLOAD  ${name} (${size} B)"
  local backoff=(30 60 120)
  for attempt in 1 2 3 4; do
    rc=0
    # "Expect:" is emptied deliberately: no 100-continue round-trip for
    # large bodies — one fewer server handshake on the slow upload path.
    curl -sS --fail-with-body \
      -X POST \
      -H "Authorization: token ${GH_TOKEN}" \
      -H "Content-Type: application/octet-stream" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "Expect:" \
      --connect-timeout 30 \
      --max-time 420 \
      --speed-limit 1024 --speed-time 60 \
      --retry 2 --retry-delay 15 --retry-all-errors \
      --data-binary @"${file}" \
      -o "${TMPI}/upload-response.json" \
      "${UP}/repos/${REPO}/releases/${RELEASE_ID}/assets?name=${name}" || rc=$?
    if [ "${rc}" -eq 0 ] && python3 - "${TMPI}/upload-response.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    ok = d.get("state") == "uploaded" and d.get("size", 0) > 0
except Exception:
    ok = False
sys.exit(0 if ok else 1)
PY
    then
      echo "OK      ${name} — upload confirmed by the API response"
      return 0
    fi
    # Surface the failure body (up to 300 B) — the 500 body carries the
    # diagnostic the raw curl line does not.
    if [ -s "${TMPI}/upload-response.json" ]; then
      echo "::warning::attempt ${attempt} for ${name} failed (curl rc=${rc}) — response body: $(head -c 300 "${TMPI}/upload-response.json" | tr '\n' ' ')"
    else
      echo "::warning::attempt ${attempt} for ${name} failed (curl rc=${rc}, empty response)"
    fi
    # THE 500-COMMIT RACE: the upload may have landed despite the error —
    # poll the draft for up to 45 s before burning another attempt.
    local landed=""
    for poll in 1 2 3; do
      existing="$(asset_lookup "${name}" || true)"
      if [ -n "${existing}" ]; then
        read -r id esize estate <<<"${existing}"
        if [ "${estate}" = "uploaded" ] && [ "${esize}" = "${size}" ]; then
          landed="${id}"
          break
        fi
      fi
      sleep 15
    done
    if [ -n "${landed}" ]; then
      echo "OK      ${name} — committed server-side DESPITE the error response (the 500-commit race); verified on the draft at ${size} B"
      return 0
    fi
    if [ "${attempt}" -eq 4 ]; then
      echo "::error::upload of ${name} failed after all retries (4 attempts + landed-checks + the 30/60/120s backoff ladder)"
      return 1
    fi
    echo "        backing off ${backoff[$((attempt - 1))]}s before attempt $((attempt + 1)) (the 500 window heals in ~5–10 min)"
    sleep "${backoff[$((attempt - 1))]}"
  done
}

for f in "${FILES[@]}"; do
  upload_asset "${f}"
done

# --- 5. final verification: every expected asset present AND byte-exact ---
echo "— final verification (bytes on the draft == bytes on disk) —"
api "${API}/repos/${REPO}/releases/${RELEASE_ID}" > "${TMPI}/final.json"
python3 - "${VERSION}" "${TMPI}/final.json" "${BUILD_LINUX}" <<'PY'
import json, sys, os
version, path, build_linux = sys.argv[1], sys.argv[2], sys.argv[3]
rel = json.load(open(path))
expected = [
    f"acute-launcher-kit-v{version}.zip",
    f"installer/ACUTE-CODE_{version}_x64-setup.exe",
]
if build_linux == "true":
    expected += [
        f"linux-bundles/ACUTE-CODE_{version}_amd64.deb",
        f"linux-bundles-arm64/ACUTE-CODE_{version}_arm64.deb",
        f"linux-bundles/ACUTE-CODE_{version}_amd64.AppImage",
        f"linux-bundles-arm64/ACUTE-CODE_{version}_aarch64.AppImage",
    ]
on_release = {a["name"]: a.get("size") or 0 for a in rel.get("assets", [])}
bad = []
for path_ in expected:
    name = os.path.basename(path_)
    disk = os.path.getsize(path_) if os.path.exists(path_) else -1
    got = on_release.get(name)
    if got is None:
        bad.append(f"{name}: MISSING from the draft")
    elif got != disk:
        bad.append(f"{name}: size mismatch (draft {got} B vs disk {disk} B)")
    else:
        print(f"  VERIFIED {name} — {got} B")
extra = set(on_release) - {os.path.basename(p) for p in expected}
if extra:
    bad.append(f"unexpected assets on the draft: {sorted(extra)}")
if not rel.get("draft"):
    bad.append("the release is NOT a draft — refusing to continue (publishing is a deliberate act)")
if bad:
    for b in bad:
        print(f"::error::{b}")
    sys.exit(1)
print(f"  {len(expected)}/{len(expected)} assets byte-verified on draft {rel['id']} for {rel['tag_name']}")
PY

echo "github-release: DRAFT ${TAG} complete — ${#FILES[@]} assets verified. Publishing stays manual (the round discipline)."
