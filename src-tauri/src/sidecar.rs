//! Sidecar lifecycle: the shell spawns the agent-core Node process, performs
//! the stdout ready-line handshake, health-polls until it answers, and tears
//! it down on app exit (ARCHITECTURE.md §2).
//!
//! ROUND-51 (R51-a) — RELEASE MODE. The Windows NSIS installer bundles the
//! sidecar as Tauri resources (`bundle.resources` maps `staging/sidecar/` →
//! `<resource_dir>/sidecar/`): the pinned `node.exe` + `app/` (dist + pruned
//! node_modules, ADR-0009 — Node SEA was rejected because better-sqlite3 is a
//! native addon). When that bundle exists we spawn it; otherwise the original
//! dev-mode repo walk keeps working byte-for-byte. `ACUTE_SIDECAR_CMD`
//! overrides the whole command line in both modes.
//!
//! ROUND-53 (R53) — NON-BLOCKING START + PHASE MACHINE + DIAGNOSTICS. The
//! owner's first run of the packaged app reported "Could not reach agent-core
//! at http://127.0.0.1:55963 (TypeError: Failed to fetch)". Root cause chain:
//! the sidecar binds an EPHEMERAL port each launch, the UI used to persist
//! that port in localStorage, and `sidecar_info` was answered once — losing
//! the race against this module's blocking handshake (setup() held the app
//! hostage for up to 25s) left the webview pointed at a previous session's
//! dead port for the entire session. And when the sidecar itself failed to
//! start, the only error was an `eprintln!` that goes nowhere in a GUI
//! process. The fix, in four parts:
//!
//!   1. `start()` spawns the handshake on a BACKGROUND thread — the window
//!      paints immediately; the webview polls `sidecar_info`/`sidecar_status`
//!      until the phase lands.
//!   2. A phase machine (`Starting → Running | Failed`) with a child monitor
//!      thread that flags mid-session exits, surfaced to the UI through the
//!      new `sidecar_status` command with the REAL error string.
//!   3. `restart_sidecar` re-runs the whole lifecycle so a crashed backend
//!      recovers WITHOUT an app restart (the UI's offline banner offers it).
//!   4. Every lifecycle line is appended to `<state_dir>/acute-code/sidecar.log`
//!      (best-effort) — the packaged app finally has remotely readable
//!      diagnostics. The file rotates at 1 MB so it never grows unbounded.
//!
//! ROUND-54 (R54) — THE OWNER'S "RESTART ENGINE DIDN'T WORK" REPORT. Three
//! blind spots left the packaged app failing with no visible reason:
//!
//!   1. STDERR WAS INHERITED — a GUI-subsystem process has no stderr handle,
//!      so agent-core's own crash messages (`main.ts` prints the real startup
//!      failure to stderr, then exits) went NOWHERE. stderr is PIPED now and
//!      drained into sidecar.log (`sidecar:stderr] …`), so the actual cause
//!      (blocked native addon, missing env, port error…) is finally captured.
//!   2. ONE-SHOT HANDSHAKE — a cold first boot (Windows Defender scanning a
//!      freshly installed 216 MB tree, first SQLite migration) can outrun the
//!      ready deadline, and a single failure parked the app on the offline
//!      screen. The handshake now RETRIES (3 attempts) before declaring
//!      Failed, and a failed attempt KILLS its child (the old code dropped
//!      the Child on error, orphaning a node.exe that held the DB/port).
//!   3. THE OFFLINE SCREEN SAID "CHECK sidecar.log" — the owner had to find
//!      and open a file by hand. `sidecar_log_tail` now serves the last lines
//!      to the UI, and the Failed error itself carries the recent engine
//!      output, so the app explains its own failure on screen.
//!
//! ROUND-55 (R55) — THE OWNER'S EISDIR POST-MORTEM (0.54.0, third desktop
//! session). The engine watch + stderr drain added in R54 finally captured
//! the REAL crash the packaged app had been hitting since the first install:
//!
//! ```text
//! spawning `\\?\C:\…\sidecar\node.exe \\?\C:\…\main.js` in `\\?\C:\…\app`
//! Error: EISDIR: illegal operation on a directory, lstat 'C:'
//!     at Object.realpathSync … at resolveMainPath
//! ```
//!
//! Tauri's `resource_dir()` on Windows canonicalizes the install path and
//! hands back `\\?\`-VERBATIM (extended-length) paths. node.exe itself
//! starts fine from a verbatim program path, but its module resolver
//! (`fs.realpathSync` inside `resolveMainPath`) does not support verbatim
//! paths: handed `\\?\C:\…\main.js` as the entry script it degenerates to
//! `lstat 'C:'` → EISDIR → the process dies before the first line of user
//! code → every handshake attempt fails → "Can't reach agent-core". Dev
//! mode never saw this because `scripts/dev.mjs` passes plain POSIX paths.
//! THE FIX: `simplified_path()` strips the `\\?\` prefix (safe — verbatim
//! prefixes exist to exceed MAX_PATH and the install tree is nowhere near
//! 260 chars) before the exe path, script argument, or cwd reach the child.
//! The same round fixed the key story: the keyring crate's `{user}.{service}`
//! TargetName never matched the launcher's cmdkey targets, so the packaged
//! app's spawns found no provider keys — key reads now go through wincred.rs
//! at the canonical `ACUTE-CODE/provider/<id>` targets (see keys.rs).

use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex, OnceLock, RwLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// `CREATE_NO_WINDOW` — the sidecar must never flash a console (§2.1 step 4).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// R54: cold-boot budget raised — a fresh install being scanned by Windows
/// Defender can easily outrun the old 15s; 25s keeps the fast machines fast
/// and gives the slow first boot room to land.
const READY_TIMEOUT: Duration = Duration::from_secs(25);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(500);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
/// `sidecar.log` rotates once past this size (checked once per process boot).
const LOG_ROTATE_BYTES: u64 = 1024 * 1024;
/// R54: startup auto-retries — the first attempt on a cold, freshly installed
/// (Defender-scanned) machine is exactly the one most likely to time out.
const START_ATTEMPTS: u32 = 3;
/// Pause between handshake attempts (lets AV scans finish, ports settle).
const RETRY_PAUSE: Duration = Duration::from_secs(2);
/// Recent stdout+stderr lines kept in memory so a Failed phase can carry the
/// engine's own last words without a file read.
const OUTPUT_RING_CAPACITY: usize = 24;
/// How many ring lines are embedded in the Failed error string.
const FAILED_TAIL_LINES: usize = 6;

/// The observable lifecycle of the agent-core process. The UI drives its
/// connection splash / offline banner from `sidecar_status`.
enum SidecarPhase {
    /// Handshake in flight (spawn → ready line → health poll).
    Starting,
    /// Serving; port + ephemeral bearer are valid.
    Running { port: u16, token: String },
    /// Startup failed or the process died mid-session; `error` is the reason.
    Failed { error: String },
    /// Torn down by app exit.
    Stopped,
}

impl SidecarPhase {
    fn describe(&self) -> String {
        match self {
            SidecarPhase::Starting => "sidecar is starting".into(),
            SidecarPhase::Running { port, .. } => format!("sidecar is running on port {port}"),
            SidecarPhase::Failed { error } => format!("sidecar failed: {error}"),
            SidecarPhase::Stopped => "sidecar is stopped".into(),
        }
    }
}

pub struct SidecarState {
    phase: RwLock<SidecarPhase>,
    /// The live (or exited-but-not-yet-reaped) child, when one exists.
    child: Mutex<Option<Child>>,
    /// Serializes `restart_sidecar` calls (a restart during another restart's
    /// teardown would double-spawn).
    restart_lock: Mutex<()>,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            phase: RwLock::new(SidecarPhase::Starting),
            child: Mutex::new(None),
            restart_lock: Mutex::new(()),
        }
    }
}

/// Spawns the handshake on a background thread and returns immediately.
///
/// R53: this used to run synchronously inside `setup`, which blocked the
/// builder (and froze the first paint) for the whole handshake — up to 25s
/// on a cold machine — while the webview was already loading and its one-shot
/// `sidecar_info` call lost the race. The thread owns the handshake now; the
/// webview polls until the phase lands.
pub fn start(app: &AppHandle) {
    app.manage(SidecarState::default());
    rotate_log_if_large();
    log_line("sidecar: lifecycle start (handshake on background thread)");
    let handle = app.app_handle().clone();
    thread::spawn(move || handshake_thread(handle));
}

/// The background lifecycle: handshake → Running → monitor the child until it
/// exits (mid-session crash → `Failed` with the exit code).
///
/// R54: the handshake RETRIES (see START_ATTEMPTS) — a single cold-boot
/// timeout no longer parks the owner on the offline screen — and the final
/// failure string carries the engine's recent output (stderr included), so
/// the offline screen explains itself.
fn handshake_thread(app: AppHandle) {
    clear_output_ring();
    let mut last_error = String::new();
    for attempt in 1..=START_ATTEMPTS {
        match spawn_and_handshake(&app) {
            Ok(running) => {
                let port = running.port;
                {
                    let state = app.state::<SidecarState>();
                    *state.child.lock().unwrap_or_else(|p| p.into_inner()) = Some(running.child);
                    *state.phase.write().unwrap_or_else(|p| p.into_inner()) =
                        SidecarPhase::Running {
                            port,
                            token: running.token,
                        };
                }
                log_line(&format!(
                    "sidecar: listening on 127.0.0.1:{port} (attempt {attempt}/{START_ATTEMPTS})"
                ));
                monitor_child(&app);
                return;
            }
            Err(e) => {
                log_line(&format!(
                    "sidecar: startup attempt {attempt}/{START_ATTEMPTS} failed: {e}"
                ));
                last_error = e;
                if attempt < START_ATTEMPTS {
                    log_line(&format!("sidecar: retrying in {}s…", RETRY_PAUSE.as_secs()));
                    thread::sleep(RETRY_PAUSE);
                }
            }
        }
    }
    let error = enrich_failure(&last_error);
    log_line(&format!(
        "sidecar: startup failed (all {START_ATTEMPTS} attempts): {error}"
    ));
    let state = app.state::<SidecarState>();
    *state.phase.write().unwrap_or_else(|p| p.into_inner()) = SidecarPhase::Failed { error };
}

/// Append the engine's recent output to a startup-failure string (R54) — the
/// `main.ts` crash path prints its reason to stderr and exits, and without
/// this the UI would only ever see "stdout closed before the ready line".
fn enrich_failure(error: &str) -> String {
    let recent = recent_output();
    if recent.is_empty() {
        return error.to_string();
    }
    let tail = recent
        .into_iter()
        .rev()
        .take(FAILED_TAIL_LINES)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n  ");
    format!("{error}\nrecent engine output:\n  {tail}")
}

/// Watches the running child; a mid-session exit flips the phase to `Failed`
/// so the UI's watchdog can offer `restart_sidecar`. Stops quietly when the
/// phase is no longer Running (shutdown or restart took the child over).
fn monitor_child(app: &AppHandle) {
    loop {
        thread::sleep(CHILD_POLL_INTERVAL);
        let state = app.state::<SidecarState>();
        {
            let still_running = {
                let phase = state.phase.read().unwrap_or_else(|p| p.into_inner());
                matches!(&*phase, SidecarPhase::Running { .. })
            };
            if !still_running {
                return;
            }
        }
        let mut guard = state.child.lock().unwrap_or_else(|p| p.into_inner());
        let Some(child) = guard.as_mut() else { return };
        match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code();
                drop(guard);
                let mut phase = state.phase.write().unwrap_or_else(|p| p.into_inner());
                if matches!(&*phase, SidecarPhase::Running { .. }) {
                    *phase = SidecarPhase::Failed {
                        error: format!(
                            "agent-core exited unexpectedly (code {code:?}) — restart it from the app"
                        ),
                    };
                    log_line(&format!("sidecar: exited mid-session (code {code:?})"));
                }
                return;
            }
            Ok(None) => {} // still alive
            Err(_) => return,
        }
    }
}

/// Teardown per §2.4: best-effort authed `POST /internal/shutdown`, a 3s
/// grace period, then `taskkill /T /F` so no orphan node process survives.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    // Capture the endpoint BEFORE the phase flip (endpoint() reads Running).
    let running_endpoint = endpoint(app);
    // Take the child first so the monitor thread stops claiming it.
    let child = state.child.lock().unwrap_or_else(|p| p.into_inner()).take();
    *state.phase.write().unwrap_or_else(|p| p.into_inner()) = SidecarPhase::Stopped;
    let Some(mut child) = child else { return };
    if let Some((port, token)) = running_endpoint {
        let _ = http_status("POST", port, "/internal/shutdown", Some(&token), None);
    }
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while child.try_wait().ok().flatten().is_none() {
        if Instant::now() >= deadline {
            kill_tree(&mut child);
            break;
        }
        thread::sleep(POLL_INTERVAL);
    }
    let _ = child.wait();
    log_line("sidecar: shutdown complete");
}

/// `{port, token}` for the webview — the only channel through which the token
/// reaches the UI (§2.3); it never appears in URLs, storage, or logs.
#[derive(Serialize)]
pub struct SidecarInfo {
    pub port: u16,
    pub token: String,
}

/// Loopback endpoint of the running sidecar, for shell-internal pushes such
/// as the provider-key vault handoff (API.md §2.3). None while not Running.
pub fn endpoint(app: &AppHandle) -> Option<(u16, String)> {
    let state = app.state::<SidecarState>();
    let phase = state.phase.read().ok()?;
    match &*phase {
        SidecarPhase::Running { port, token } => Some((*port, token.clone())),
        _ => None,
    }
}

#[tauri::command]
pub fn sidecar_info(state: State<SidecarState>) -> Result<SidecarInfo, String> {
    let phase = state.phase.read().unwrap_or_else(|p| p.into_inner());
    match &*phase {
        SidecarPhase::Running { port, token } => Ok(SidecarInfo {
            port: *port,
            token: token.clone(),
        }),
        other => Err(other.describe()),
    }
}

/// R53: the lifecycle view the UI polls while its connection splash is up —
/// and the diagnostics channel for the packaged app. `Failed` carries the
/// actual startup error (spawn failure, missing bundle, ready-line timeout…),
/// which before R53 only reached an invisible `eprintln!`.
#[derive(Serialize)]
#[serde(rename_all = "lowercase", tag = "phase")]
pub enum SidecarStatusView {
    Starting,
    Running { port: u16 },
    Failed { error: String },
    Stopped,
}

#[tauri::command]
pub fn sidecar_status(state: State<SidecarState>) -> SidecarStatusView {
    let phase = state.phase.read().unwrap_or_else(|p| p.into_inner());
    match &*phase {
        SidecarPhase::Starting => SidecarStatusView::Starting,
        SidecarPhase::Running { port, .. } => SidecarStatusView::Running { port: *port },
        SidecarPhase::Failed { error } => SidecarStatusView::Failed {
            error: error.clone(),
        },
        SidecarPhase::Stopped => SidecarStatusView::Stopped,
    }
}

/// R53: re-run the full lifecycle (teardown → Starting → handshake). Lets the
/// UI's offline banner recover a crashed sidecar without an app restart.
/// Returns immediately; the caller polls `sidecar_status` for the outcome.
#[tauri::command]
pub fn restart_sidecar(app: AppHandle, state: State<SidecarState>) -> Result<String, String> {
    // Serialize restarts: a second click while one is tearing down would race
    // the child hand-off and double-spawn.
    let _serial = state.restart_lock.lock().unwrap_or_else(|p| p.into_inner());
    {
        let phase = state.phase.read().unwrap_or_else(|p| p.into_inner());
        if matches!(&*phase, SidecarPhase::Starting) {
            return Ok("already starting".into());
        }
    }

    // Graceful teardown of any existing child (same shape as shutdown()).
    if let Some((port, token)) = endpoint(&app) {
        let _ = http_status("POST", port, "/internal/shutdown", Some(&token), None);
    }
    if let Some(mut child) = state.child.lock().unwrap_or_else(|p| p.into_inner()).take() {
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while child.try_wait().ok().flatten().is_none() {
            if Instant::now() >= deadline {
                kill_tree(&mut child);
                break;
            }
            thread::sleep(POLL_INTERVAL);
        }
        let _ = child.wait();
    }

    log_line("sidecar: restart requested from the UI");
    *state.phase.write().unwrap_or_else(|p| p.into_inner()) = SidecarPhase::Starting;
    let handle = app.app_handle().clone();
    thread::spawn(move || handshake_thread(handle));
    Ok("restarting".into())
}

/// R54: the offline screen's in-app diagnostics — the last lines of
/// sidecar.log, so the owner never has to hunt for %APPDATA% by hand.
#[derive(Serialize)]
pub struct SidecarLogTail {
    /// Absolute path of sidecar.log (shown so the owner can find the file).
    pub path: String,
    /// The most recent lines, oldest first (empty when no log exists yet).
    pub lines: Vec<String>,
}

#[tauri::command]
pub fn sidecar_log_tail(lines: Option<u32>) -> SidecarLogTail {
    let want = lines.unwrap_or(60).clamp(1, 200) as usize;
    let path = log_path();
    let mut tail = Vec::new();
    if let Some(p) = &path {
        if let Ok(content) = std::fs::read_to_string(p) {
            tail = content
                .lines()
                .rev()
                .take(want)
                .map(str::to_string)
                .collect::<Vec<_>>();
            tail.reverse();
        }
    }
    SidecarLogTail {
        path: path.map(|p| p.display().to_string()).unwrap_or_default(),
        lines: tail,
    }
}

#[tauri::command]
pub fn ping_sidecar(state: State<SidecarState>) -> Result<String, String> {
    let port = {
        let phase = state.phase.read().unwrap_or_else(|p| p.into_inner());
        match &*phase {
            SidecarPhase::Running { port, .. } => *port,
            other => return Err(other.describe()),
        }
    };
    match http_status("GET", port, "/health", None, None) {
        Ok(200) => Ok("ok".into()),
        Ok(code) => Err(format!("health check returned HTTP {code}")),
        Err(e) => Err(format!("health check failed: {e}")),
    }
}

fn spawn_and_handshake(app: &AppHandle) -> Result<RunningSidecar, String> {
    let token = mint_token()?;
    let db_path = default_db_path()?;

    let (mut command, cwd) = resolve_sidecar_command(app)?;
    log_line(&format!(
        "sidecar: spawning `{} {}` in `{}`",
        command.get_program().to_string_lossy(),
        command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" "),
        cwd.display(),
    ));
    command
        .env("ACUTE_TOKEN", &token)
        .env("ACUTE_DB_PATH", &db_path)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // R54: stderr is PIPED and drained into sidecar.log — the packaged
        // app is a GUI-subsystem process with NO stderr handle, so the old
        // `Stdio::inherit()` sent agent-core's own crash messages (the real
        // startup failure reason!) nowhere at all.
        .stderr(Stdio::piped());
    // ARCHITECTURE §7: provider keys flow Credential Manager (DPAPI) -> child env,
    // never through the sidecar's REST surface or any file on disk.
    // R55: the read lives in keys.rs — canonical `ACUTE-CODE/provider/<id>`
    // targets (the launcher's cmdkey form) with the pre-R55 keyring form as
    // a legacy fallback, replacing the keyring crate whose `{user}.{service}`
    // TargetName never matched what the launcher stored.
    let mut injected_keys = Vec::new();
    // ROUND-82 (R82-B): the injection list is now DYNAMIC — the hardcoded
    // builtins plus every NOTED custom provider (keys.rs reads
    // ~/.acute/custom-providers.txt, ids only, never secrets) — so a key
    // saved for a provider created in Settings survives app restarts
    // instead of dying with `409 no API key` on the next spawn. The list is
    // owned String pairs now; the loop shape mirrors the vision loop below.
    for (env_name, provider_id) in crate::keys::provider_key_env_targets() {
        if let Some(key) = crate::keys::read_provider_key_lossy(&provider_id) {
            // Length only — same convention as the launcher's own output; the
            // VALUE never appears anywhere. This line is what makes "keys not
            // loaded" debuggable from sidecar.log on the owner's machine.
            injected_keys.push(format!("{provider_id} (len {})", key.len()));
            command.env(env_name, key);
        }
    }
    // ROUND-61 (R61): the SEPARATE vision-model keys — ACUTE_PROVIDER_<ID>_VISION
    // from the noted vision providers (ids only in the note file; values in
    // the credential store).
    for (env_name, provider_id) in crate::keys::vision_env_targets() {
        if let Some(key) = crate::keys::read_provider_key_lossy(&provider_id) {
            injected_keys.push(format!("{provider_id} (len {})", key.len()));
            command.env(env_name, key);
        }
    }
    if injected_keys.is_empty() {
        log_line("sidecar: no provider keys found in Credential Manager");
    } else {
        log_line(&format!(
            "sidecar: injected provider keys: {}",
            injected_keys.join(", ")
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let program = command.get_program().to_string_lossy().into_owned();
    let mut child = command
        .spawn()
        .map_err(|e| format!("spawning `{program}` in `{}`: {e}", cwd.display()))?;

    // R54: drain stderr for the child's whole lifetime — the crash reason
    // (`sidecar failed to start: …`) lands in sidecar.log AND the in-memory
    // ring that enriches the Failed phase. Without this the packaged app's
    // only diagnostic was "stdout closed before the ready line".
    drain_stderr(&mut child);

    // R54: a failed handshake KILLS its child. The old code dropped the Child
    // on error, which on Windows leaves the node process RUNNING (orphan) —
    // it kept the SQLite database and made every later restart attempt race
    // a zombie (the owner's "restart engine didn't work" report).
    let handshake =
        read_ready_line(&mut child).and_then(|port| health_poll(&mut child, port).map(|_| port));
    match handshake {
        Ok(port) => Ok(RunningSidecar { port, token, child }),
        Err(e) => {
            log_line(&format!(
                "sidecar: handshake failed, killing the child: {e}"
            ));
            kill_tree(&mut child);
            let _ = child.wait();
            Err(e)
        }
    }
}

/// R54: reads child stderr line-by-line for its lifetime; every line goes to
/// sidecar.log (`sidecar:stderr] …`) and the in-memory output ring.
fn drain_stderr(child: &mut Child) {
    let Some(stderr) = child.stderr.take() else {
        return;
    };
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            log_line(&format!("sidecar:stderr] {line}"));
            remember_output(&line);
        }
    });
}

// ── R54: the recent-output ring (stdout + stderr) ────────────────────────────

fn output_ring() -> &'static Mutex<VecDeque<String>> {
    static RING: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(OUTPUT_RING_CAPACITY)))
}

fn remember_output(line: &str) {
    let mut ring = output_ring().lock().unwrap_or_else(|p| p.into_inner());
    if ring.len() >= OUTPUT_RING_CAPACITY {
        ring.pop_front();
    }
    ring.push_back(line.to_string());
}

fn recent_output() -> Vec<String> {
    output_ring()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .cloned()
        .collect()
}

fn clear_output_ring() {
    output_ring()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clear();
}

struct RunningSidecar {
    port: u16,
    token: String,
    child: Child,
}

/// Walks up from the current dir until `agent-core/dist/main.js` is visible,
/// so the spawn works whether the app was launched from the repo root or
/// `src-tauri/`.
fn resolve_repo_root() -> PathBuf {
    let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    while !dir
        .join("agent-core")
        .join("dist")
        .join("main.js")
        .is_file()
    {
        if !dir.pop() {
            return std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        }
    }
    dir
}

/// ROUND-51 (R51-a): resolves the sidecar command line + working directory.
/// Priority:
///   1. `ACUTE_SIDECAR_CMD` overrides the full command line (dev escape
///      hatch, kept first so it wins in every mode — unchanged behavior).
///   2. RELEASE: the bundled sidecar in the Tauri resource dir — the NSIS
///      installer ships `<resource_dir>/sidecar/node.exe` + `sidecar/app/`
///      (ADR-0009). Detected by `sidecar/app/dist/main.js` existing, per the
///      CI staging contract (scripts/release/stage-sidecar.mjs).
///   3. DEV (unchanged): `node agent-core/dist/main.js` with the repo-walk
///      cwd. A dev checkout has no bundled sidecar, so this stays the path
///      every existing dev flow takes.
///
/// The bundled `node.exe` runtime is checked FIRST, then a bare `node`, so a
/// future non-Windows bundle (which would name it `node`) also activates.
fn resolve_sidecar_command(app: &AppHandle) -> Result<(Command, PathBuf), String> {
    if let Some(command) = override_command() {
        // The override keeps the dev cwd (repo walk) — it exists for dev-time
        // experiments against a repo checkout.
        return Ok((command, resolve_repo_root()));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        // R55: strip the `\\?\` verbatim prefix FIRST — every derived path
        // (pinned node.exe, main.js, cwd) must be a plain Win32 path or
        // node's module resolver dies with `EISDIR: lstat 'C:'` before the
        // first line of user code (see the module doc, ROUND-55).
        let resource_dir = simplified_path(&resource_dir);
        let sidecar_dir = resource_dir.join("sidecar");
        let app_dir = sidecar_dir.join("app");
        let main_js = app_dir.join("dist").join("main.js");
        if main_js.is_file() {
            let node_exe = ["node.exe", "node"]
                .iter()
                .map(|name| sidecar_dir.join(name))
                .find(|path| path.is_file())
                .ok_or_else(|| {
                    format!(
                        "bundled sidecar entry {} exists but the pinned Node runtime \
                         (sidecar/node.exe) is missing — broken install",
                        main_js.display()
                    )
                })?;
            let mut command = Command::new(&node_exe);
            // Absolute main.js — resolution does not depend on the cwd, but
            // main.js's default log file lands at <cwd>/.dev/acute.log and the
            // migrations resolve via import.meta.url inside dist/ regardless.
            // The install dir is user-writable (currentUser NSIS →
            // $LOCALAPPDATA\ACUTE-CODE), so both are safe.
            command.arg(&main_js);
            return Ok((command, app_dir));
        }
    }

    // Dev mode: relative arg + repo-walk cwd, byte-identical to pre-R51.
    let mut command = Command::new("node");
    command.arg("agent-core/dist/main.js");
    Ok((command, resolve_repo_root()))
}

/// `ACUTE_SIDECAR_CMD` overrides the full command line (program + args).
fn override_command() -> Option<Command> {
    let cmdline = std::env::var("ACUTE_SIDECAR_CMD").ok()?;
    let mut parts = cmdline.split_whitespace();
    let program = parts.next()?;
    let mut command = Command::new(program);
    command.args(parts);
    Some(command)
}

/// 256-bit random token (§2.1 step 3), hex-encoded, held in memory only.
fn mint_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("minting token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// R55: strips Windows verbatim/extended-length path prefixes so child
/// processes receive normal Win32 paths. `std::fs::canonicalize` (and
/// Tauri's `resource_dir()`, which canonicalizes the install path) on
/// Windows returns `\\?\C:\…` verbatim paths; node.exe accepts one as the
/// PROGRAM path but its module resolver (`fs.realpathSync` inside
/// `resolveMainPath`) chokes on a verbatim SCRIPT path — the owner's
/// 0.54.0 crash `EISDIR: illegal operation on a directory, lstat 'C:'`,
/// dead before the first line of user code, i.e. "Can't reach
/// agent-core". Verbatim prefixes exist to exceed MAX_PATH (260 chars);
/// the install tree is nowhere near that, so stripping is always safe
/// here. `\\?\UNC\server\share` maps to `\\server\share`.
fn simplified_path(path: &Path) -> PathBuf {
    let text = path.as_os_str().to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    path.to_path_buf()
}

/// Per-user state dir holding the DB + sidecar.log. Windows: `%APPDATA%\acute-code`
/// (the pre-R53 behavior). Other platforms (dev runs): XDG data dir.
fn state_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let appdata = std::env::var("APPDATA").map_err(|_| "APPDATA is not set".to_string())?;
        Ok(Path::new(&appdata).join("acute-code"))
    }
    #[cfg(not(windows))]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .ok()
            .filter(|v| !v.is_empty())
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|home| format!("{home}/.local/share"))
            })
            .ok_or_else(|| "neither XDG_DATA_HOME nor HOME is set".to_string())?;
        Ok(Path::new(&base).join("acute-code"))
    }
}

fn default_db_path() -> Result<PathBuf, String> {
    let dir = state_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    Ok(dir.join("acute.db"))
}

/// R53: the packaged app's diagnostics channel — every lifecycle line is
/// appended here (best-effort; failures are silently ignored so logging can
/// never break the sidecar). Also `eprintln!`d for dev-mode consoles.
pub(crate) fn log_line(message: &str) {
    let line = format!("[{}] {message}", timestamp());
    eprintln!("{line}");
    let Some(path) = log_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn log_path() -> Option<PathBuf> {
    state_dir().ok().map(|dir| dir.join("sidecar.log"))
}

/// Once-per-boot rotation: a log past 1 MB is truncated so years of sessions
/// cannot grow it unbounded (the few KB of a session boot make this generous).
fn rotate_log_if_large() {
    let Some(path) = log_path() else { return };
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > LOG_ROTATE_BYTES {
            let _ = std::fs::write(&path, "");
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .and_then(|mut f| writeln!(f, "[{}] sidecar: log rotated (>1 MB)", timestamp()));
        }
    }
}

/// Human-readable UTC timestamp without pulling a datetime crate into the
/// shell — Howard Hinnant's civil-from-days algorithm over the epoch seconds.
fn timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = (secs / 86_400) as i64;
    let (year, month, day) = civil_from_days(days);
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{year:04}-{month:02}-{day:02} {h:02}:{m:02}:{s:02}.{millis:03}Z")
}

/// Days since 1970-01-01 → (year, month, day). The standard civil-calendar
/// conversion (Hinnant, "chrono-Compatible Low-Level Date Algorithms" §8).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Waits for the `ACUTE_READY {"port":…}` stdout line (§2.1 step 5). The
/// reader thread keeps draining stdout for the child's lifetime so the pipe
/// never fills and blocks the sidecar.
fn read_ready_line(child: &mut Child) -> Result<u16, String> {
    let stdout = child.stdout.take().ok_or("child stdout was not piped")?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut ready = false;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if !ready {
                if let Some(rest) = line.strip_prefix("ACUTE_READY") {
                    match parse_ready_port(rest) {
                        Ok(port) => {
                            let _ = tx.send(Ok(port));
                            ready = true;
                            continue;
                        }
                        Err(e) => {
                            let _ = tx.send(Err(e));
                            break;
                        }
                    }
                }
            }
            // R53: post-ready stdout lines go to sidecar.log too — agent-core's
            // own error output is the other half of packaged-app diagnostics.
            // R54: they also feed the in-memory ring that enriches failures.
            log_line(&format!("sidecar:stdout] {line}"));
            remember_output(&line);
        }
        if !ready {
            let _ = tx.send(Err("stdout closed before the ready line".into()));
        }
    });
    match rx.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(port)) => Ok(port),
        Ok(Err(e)) => Err(format!("ready handshake: {e}")),
        Err(mpsc::RecvTimeoutError::Timeout) => Err("timed out waiting for ACUTE_READY".into()),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("sidecar stdout closed before the ready line".into())
        }
    }
}

fn parse_ready_port(payload: &str) -> Result<u16, String> {
    #[derive(serde::Deserialize)]
    struct ReadyLine {
        port: u16,
    }
    serde_json::from_str::<ReadyLine>(payload.trim())
        .map(|line| line.port)
        .map_err(|e| format!("malformed ready line `{payload}`: {e}"))
}

/// Polls `GET /health` every 100ms until 200, at most 10s; aborts if the
/// child exits first (§2.1 step 7).
fn health_poll(child: &mut Child, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().ok().flatten() {
            return Err(format!(
                "sidecar exited during startup (code {:?})",
                status.code()
            ));
        }
        match http_status("GET", port, "/health", None, None) {
            Ok(200) => return Ok(()),
            Ok(code) => log_line(&format!("sidecar: /health returned HTTP {code}, retrying")),
            Err(_) => {} // not listening yet — keep polling
        }
        if Instant::now() + POLL_INTERVAL >= deadline {
            return Err("health check deadline exceeded".into());
        }
        thread::sleep(POLL_INTERVAL);
    }
}

/// Kill the whole process tree: `taskkill /T /F` on Windows, plain kill
/// elsewhere.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let pid = child.id();
        let killed = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if killed.is_err() {
            let _ = child.kill();
        }
    }
    #[cfg(not(windows))]
    let _ = child.kill();
}

/// Minimal loopback HTTP/1.1 request — we only ever need the status code for
/// a fixed-shape request to 127.0.0.1, so a raw TcpStream avoids pulling in
/// an HTTP client crate. `Connection: close` means "read to EOF/first buffer"
/// is the whole response lifecycle we care about. `body` carries a UTF-8
/// payload (e.g. JSON for the internal vault handoff).
pub(crate) fn http_status(
    method: &str,
    port: u16,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> std::io::Result<u16> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;

    let auth = token
        .map(|t| format!("Authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    let (content_type, content) = match body {
        Some(b) => ("Content-Type: application/json\r\n", b),
        None => ("", ""),
    };
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}{content_type}Content-Length: {}\r\nConnection: close\r\n\r\n{content}",
        content.len(),
    );
    stream.write_all(request.as_bytes())?;

    let mut buf = [0u8; 128];
    let n = stream.read(&mut buf)?;
    std::str::from_utf8(&buf[..n])
        .ok()
        .and_then(|head| head.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "malformed status line")
        })
}

#[cfg(test)]
mod tests {
    use super::simplified_path;
    use std::path::Path;

    /// The owner's exact 0.54.0 failure shape: Tauri's resource_dir handed
    /// back a verbatim path and node's module resolver died on it. The fix
    /// must turn every verbatim form into a plain Win32 path.
    #[test]
    fn verbatim_drive_paths_are_simplified() {
        assert_eq!(
            simplified_path(Path::new(
                r"\\?\C:\Users\khurr\AppData\Local\ACUTE-CODE\sidecar\app\dist\main.js"
            )),
            Path::new(r"C:\Users\khurr\AppData\Local\ACUTE-CODE\sidecar\app\dist\main.js")
        );
    }

    #[test]
    fn verbatim_unc_paths_become_normal_unc() {
        assert_eq!(
            simplified_path(Path::new(r"\\?\UNC\server\share\app")),
            Path::new(r"\\server\share\app")
        );
    }

    #[test]
    fn plain_paths_pass_through_untouched() {
        let plain = r"C:\Users\khurr\AppData\Local\ACUTE-CODE";
        assert_eq!(simplified_path(Path::new(plain)), Path::new(plain));
        let posix = "/home/z/PROJECT/ACUTE-CODE";
        assert_eq!(simplified_path(Path::new(posix)), Path::new(posix));
        assert_eq!(
            simplified_path(Path::new("relative/path")),
            Path::new("relative/path")
        );
    }
}
