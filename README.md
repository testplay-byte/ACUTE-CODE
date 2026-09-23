<!-- last-reviewed: 2026-09-23 round-122 -->
# ACUTE-CODE

Local-first, closed-source multi-agent engineering workbench for Windows
and Linux, with a live-synced Android companion.
**Proprietary — do not publish, do not add an open-source license.**

- Master requirements: `docs/specs/SPEC.md`
- Architecture: `docs/architecture/` (Phase 1)
- Decisions: `docs/decisions/`
- Research: `docs/research/`
- Dev setup: `docs/runbooks/SETUP.md`

Stack: Tauri 2 (Rust) · React 18 + TypeScript · Node/TS agent-core sidecar · SQLite · pnpm workspaces.

## Development

pnpm workspace — the root package is the React frontend; `agent-core/` is the
Node sidecar; `shared/` holds domain types; `src-tauri/` is the Rust shell.

- `pnpm install` — install
- `pnpm verify` — lint + typecheck + test + build + e2e + license audit (mirrors CI, which also runs `pnpm docs:check` first; the local pre-push gate)
- `pnpm dev` — Vite dev server on port 5173 (UI only)
- **Desktop app:** `pnpm build`, then from `src-tauri/`: `cargo run` — debug builds load the embedded `../dist`; at launch the shell spawns `agent-core/dist/main.js`, does the stdout ready-line handshake, and injects provider keys from the OS secure store (Windows Credential Manager; the Linux Secret Service — ADR-0031). A `pnpm tauri` script exists (`package.json`), but the documented path remains build-then-cargo.

## The self-feedback ledger (round-122)

Settings → **Self-Feedback** (default OFF). While ON, after each completed
session turn a separate context-free agent reviews the whole conversation and
appends one structured entry to the machine's ONE shared ledger file —
what it was trying to do, what actually happened, every issue and glitch it
ran into (tools, browser, approvals), where reality fell short, and the
improvements it would suggest. The dedicated settings section renders each
entry as a structured card (the parsed view — outcome, placement, the six
labeled sections) with the RAW file one click away, per-entry delete beside
the whole-ledger clear, and honest size/update meta; a paired phone may view
it too. Entries are diagnostics for the app's developers — hand the file
over when something went wrong; every entry places itself (session, project,
agent, model, outcome) before it reports. Feedback NEVER enters any
conversation: the ledger file is the only persistence, and the reporter runs
detached after the turn closes. Costs one extra model call per completed
turn (metered in the usage screens with origin `feedback`).

## The Android companion (live sync + full inventory — round-114 state)

A phone pairs to the desktop (Settings → Devices; on the LAN or through the
cloud relay — `docs/guides/CLOUDFLARE-SETUP.md`) and the two ends stay LIVE
against each other: a turn started on either device streams to every open
screen (thinking, tool runs, the caret — `GET /api/v1/events/stream`, the
events-bus mirror) and flips the OTHER device to its processing state the
moment it begins (`turn.started` — the remote bubble, the resolved model,
the Thinking placeholder); appearance — theme, mode, and the four chat
prefs (density / text size / timestamps / tool activity) — plus the
session's operating mode and selected model propagate the moment they're
saved, and session/project lists refresh as things happen.

Navigation is projects-first on both platforms: the desktop's project view
lists each project's sessions row-by-row (a row opens its session); the
phone's Projects tab expands each project INLINE (its sessions, honest
status labels, quick new-session) — no navigation round-trip. The phone's
chat screen carries the PC composer's controls — operation mode, model
selection (the honest effective-model pill, not "Auto"), thinking level,
the context ring + breakdown, attach/upload, and @-file mentions from the
project — with per-tool cards (skills, streaming file writes, terminal
tails) that mirror the PC's transcript. The dashboard is color-coded
(stacked in/out usage bars, per-model hues); the phone owns its inventory
in full: Models & Providers management (custom provider creation, the key
pool, saved models with capability editing/testing/hiding/deletion) —
providers list configured-first on both ends ("Your providers" above the
add-a-provider catalog). The events wire contract:
`docs/architecture/api/IMPLEMENTED-API.md` (the R113 + R114 additions).

## Linux release (round-100; ARM64 since round-101)

Four installers ship on every tagged release (built by the `linux-bundles`
+ `linux-bundles-arm64` jobs in `.github/workflows/release.yml`) — x64
(`amd64`, the default for typical desktops) and ARM64 (`arm64`):

- **`ACUTE-CODE_<version>_amd64.deb`** — Debian/Ubuntu x86_64: `sudo apt
  install ./ACUTE-CODE_<version>_amd64.deb` (the package pulls its
  dependencies, incl. WebKitGTK, from apt).
- **`ACUTE-CODE_<version>_amd64.AppImage`** — any x86_64 distro: `chmod +x`
  and run; no installation, no root.
- **`ACUTE-CODE_<version>_arm64.deb`** — Debian/Ubuntu aarch64: same flow,
  `sudo apt install ./ACUTE-CODE_<version>_arm64.deb`.
- **`ACUTE-CODE_<version>_aarch64.AppImage`** — any aarch64 distro: `chmod
  +x` and run; no installation, no root. (The two formats name the arch
  differently — `arm64` is dpkg's name, `aarch64` the kernel/Rust name —
  matching each ecosystem's convention.)

**Which arch?** `amd64` is the right download for typical Intel/AMD
desktops and laptops. `arm64` (round-101) is for aarch64 machines —
Raspberry Pi 5-class boards running a desktop environment, aarch64 Linux
laptops, and Snapdragon X / DevKit machines running an arm64 distro.
Requirements are identical on both arches (the WebKitGTK runtime and the
Secret Service keyring below), and the same feature matrix applies — the
ARM64 bundles are built natively on an arm64 runner with the same boot
gate, not cross-compiled.

**Requirements:** a WebKitGTK 4.1 runtime (`libwebkit2gtk-4.1-0` — present
on every current Debian/Ubuntu/Fedora desktop) and, for provider API keys,
a Secret Service keyring (gnome-keyring on GNOME/Ubuntu, KWallet on KDE) —
the app stores keys there, encrypted at rest by the keyring daemon
(ADR-0031). On a machine WITHOUT a keyring daemon (headless, some WSL
setups), key reads return none and key saves error honestly — provide the
`ACUTE_PROVIDER_<ID>` environment variables instead (the dev path that
always worked).

**The honest feature matrix:**

| Feature | Linux status |
|---|---|
| Embedded browser panel | **Yes** — the same 15 actions on the WebKitGTK engine (genuinely not Edge/Chromium there) |
| Agent, chat, projects, SQLite storage | **Yes** — the sidecar is platform-neutral Node |
| Provider-key storage | **Yes** — Secret Service (gnome-keyring/KWallet), ADR-0031 |
| Computer-use desktop automation | **Windows-only** (PowerShell/win32 backends) |
| One-click in-app updater | All three shipped shapes: Windows (the VISIBLE overlay install — the window stays open on an animated splash for the whole install and restarts into the new version), Linux AppImage (the atomic in-place replace with a pid-wait relaunch), and Linux .deb (the visible `pkexec dpkg -i` leg). Checks and downloads run ANONYMOUSLY first — the repository is public, no GitHub token is required (an optional saved token only raises the rate limit and is removable in-app; round-123) |

### Troubleshooting (WebKitGTK graphics)

Blank or flickering windows, resize crashes, or `AcceleratedSurfaceDMABuf`
errors are the known WebKitGTK/NVIDIA/Wayland class — the official
workaround ladder (try in order, one at a time, and keep only the one that
fixes it) is documented at
https://v2.tauri.app/develop/debug/linux-graphics/:

```bash
__NV_DISABLE_EXPLICIT_SYNC=1 ACUTE-CODE        # first (NVIDIA + Wayland)
WEBKIT_DISABLE_DMABUF_RENDERER=1 ACUTE-CODE    # second (blank/flicker)
WEBKIT_DISABLE_COMPOSITING_MODE=1 ACUTE-CODE   # last resort (software path)
```

(For the AppImage substitute its path for `ACUTE-CODE`; for a permanent
global fix export the variable in `~/.profile`. The app ships nothing
unconditional — these are user-side escape hatches.)
