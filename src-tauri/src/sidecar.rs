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

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, RwLock},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// `CREATE_NO_WINDOW` — the sidecar must never flash a console (§2.1 step 4).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const READY_TIMEOUT: Duration = Duration::from_secs(15);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

pub struct SidecarState(RwLock<Option<RunningSidecar>>);

impl Default for SidecarState {
    fn default() -> Self {
        Self(RwLock::new(None))
    }
}

struct RunningSidecar {
    port: u16,
    token: String,
    child: Child,
}

/// Spawns the sidecar, completes the handshake, and stores the result as
/// managed state. Failures are logged and leave the app running without a
/// sidecar (the UI falls back to demo data).
pub fn start(app: &AppHandle) {
    app.manage(SidecarState::default());
    match spawn_and_handshake(app) {
        Ok(running) => {
            eprintln!("[sidecar] listening on 127.0.0.1:{}", running.port);
            *app.state::<SidecarState>().0.write().unwrap() = Some(running);
        }
        Err(e) => eprintln!("[sidecar] startup failed: {e}"),
    }
}

/// Teardown per §2.4: best-effort authed `POST /internal/shutdown`, a 3s
/// grace period, then `taskkill /T /F` so no orphan node process survives.
pub fn shutdown(app: &AppHandle) {
    let Some(mut sidecar) = app.state::<SidecarState>().0.write().unwrap().take() else {
        return;
    };
    let _ = http_status("POST", sidecar.port, "/internal/shutdown", Some(&sidecar.token), None);
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while sidecar.child.try_wait().ok().flatten().is_none() {
        if Instant::now() >= deadline {
            kill_tree(&mut sidecar.child);
            break;
        }
        thread::sleep(POLL_INTERVAL);
    }
    let _ = sidecar.child.wait();
}

/// `{port, token}` for the webview — the only channel through which the token
/// reaches the UI (§2.3); it never appears in URLs, storage, or logs.
#[derive(Serialize)]
pub struct SidecarInfo {
    pub port: u16,
    pub token: String,
}

/// Loopback endpoint of the running sidecar, for shell-internal pushes such
/// as the provider-key vault handoff (API.md §2.3). None while down.
pub fn endpoint(app: &AppHandle) -> Option<(u16, String)> {
    let state = app.state::<SidecarState>();
    let guard = state.0.read().ok()?;
    guard.as_ref().map(|s| (s.port, s.token.clone()))
}

#[tauri::command]
pub fn sidecar_info(state: State<SidecarState>) -> Result<SidecarInfo, String> {
    state
        .0
        .read()
        .unwrap()
        .as_ref()
        .map(|s| SidecarInfo {
            port: s.port,
            token: s.token.clone(),
        })
        .ok_or_else(|| "sidecar not running".into())
}

#[tauri::command]
pub fn ping_sidecar(state: State<SidecarState>) -> Result<String, String> {
    let guard = state.0.read().unwrap();
    let sidecar = guard.as_ref().ok_or("sidecar not running")?;
    match http_status("GET", sidecar.port, "/health", None, None) {
        Ok(200) => Ok("ok".into()),
        Ok(code) => Err(format!("health check returned HTTP {code}")),
        Err(e) => Err(format!("health check failed: {e}")),
    }
}

fn spawn_and_handshake(app: &AppHandle) -> Result<RunningSidecar, String> {
    let token = mint_token()?;
    let db_path = default_db_path()?;

    let (mut command, cwd) = resolve_sidecar_command(app)?;
    command
        .env("ACUTE_TOKEN", &token)
        .env("ACUTE_DB_PATH", &db_path)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // Stderr stays inherited so dev sees sidecar errors in their terminal.
        .stderr(Stdio::inherit());
    // ARCHITECTURE §7: provider keys flow Credential Manager (DPAPI) -> child env,
    // never through the sidecar's REST surface or any file on disk.
    for (env_name, provider_id) in provider_key_targets() {
        if let Some(key) = read_provider_key(&provider_id) {
            command.env(env_name, key);
        }
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

    let port = read_ready_line(&mut child)?;
    health_poll(&mut child, port)?;
    Ok(RunningSidecar { port, token, child })
}

/// Walks up from the current dir until `agent-core/dist/main.js` is visible,
/// so the spawn works whether the app was launched from the repo root or
/// `src-tauri/`.
fn resolve_repo_root() -> PathBuf {
    let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    while !dir.join("agent-core").join("dist").join("main.js").is_file() {
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

/// Credential Manager targets whose values become ACUTE_PROVIDER_<ID> env
/// vars. ROUND-51 (R51-a): the sub-agent POOL slots 2/3/4 ride along — the
/// launcher's `desktop` flow pushes credentials.txt's OPENROUTER_SUB1..3_KEY
/// values into Credential Manager under exactly these `ACUTE-CODE/provider/
/// openrouter-slot{2,3,4}` targets (same scheme keys.rs writes), so the pool
/// keys survive restarts of the PACKAGED app instead of living only in the
/// spawn env of a dev-mode launch. Slot ids pass validate_provider_id
/// (lowercase + digits + '-'), so the Settings UI's key-pool slot rows read
/// the very same entries.
fn provider_key_targets() -> [(&'static str, &'static str); 4] {
    [
        ("ACUTE_PROVIDER_OPENROUTER", "openrouter"),
        ("ACUTE_PROVIDER_OPENROUTER_SLOT2", "openrouter-slot2"),
        ("ACUTE_PROVIDER_OPENROUTER_SLOT3", "openrouter-slot3"),
        ("ACUTE_PROVIDER_OPENROUTER_SLOT4", "openrouter-slot4"),
    ]
}

fn read_provider_key(provider_id: &str) -> Option<String> {
    let entry = keyring::Entry::new(&format!("ACUTE-CODE/provider/{provider_id}"), "api-key")
        .ok()?;
    match entry.get_password() {
        Ok(key) if !key.is_empty() => Some(key),
        // No credential stored yet (owner hasn't entered a key) is normal, not an error.
        Ok(_) => None,
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            eprintln!("[sidecar] reading key for {provider_id} failed: {e}");
            None
        }
    }
}

fn default_db_path() -> Result<PathBuf, String> {
    let appdata =
        std::env::var("APPDATA").map_err(|_| "APPDATA is not set".to_string())?;
    let dir = Path::new(&appdata).join("acute-code");
    std::fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    Ok(dir.join("acute.db"))
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
            eprintln!("[sidecar:stdout] {line}");
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
            Ok(code) => eprintln!("[sidecar] /health returned HTTP {code}, retrying"),
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
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "malformed status line"))
}
