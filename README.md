<!-- last-reviewed: 2026-09-19 round-108 -->
# ACUTE-CODE

Local-first, closed-source multi-agent engineering workbench for Windows
and Linux.
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
| One-click in-app updater | **Windows-only** for now — on Linux the AppImage is the auto-update candidate (in-place replace); deb installs should check for updates and open the releases page until tauri-plugin-updater is wired (round-101 follow-up) |

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
