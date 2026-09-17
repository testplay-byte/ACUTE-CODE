//! The provider-key store (ARCHITECTURE §7 / SPEC hard rule: provider API
//! keys live in the OS secure store, never on disk) — Windows Credential
//! Manager (generic credentials, DPAPI) on Windows; the freedesktop Secret
//! Service on Linux (ADR-0031), with a disclosed owner-only key-file
//! fallback for desktops where no Secret Service is reachable (ADR-0031
//! addendum, ROUND-102).
//!
//! ROUND-55 (R55) — WHY THIS MODULE EXISTS. This replaced the `keyring`
//! crate's `Entry::new(service, user)`: on Windows, keyring 4.x derives the
//! credential's TargetName as `{user}.{service}`, so the app was reading and
//! writing `api-key.ACUTE-CODE/provider/openrouter` while the launcher seeds
//! keys with `cmdkey /generic:ACUTE-CODE/provider/openrouter` — two disjoint
//! namespaces. Every packaged-app boot logged "no provider keys found in
//! Credential Manager" even though the launcher had just stored all four
//! keys. Direct `CredReadW`/`CredWriteW` FFI gives exact TargetName control:
//! everything now uses the launcher's canonical, documented target
//! `ACUTE-CODE/provider/<providerId>` (user `api-key`), byte-identical to
//! cmdkey, and the pre-R55 keyring-form target is still READ as a legacy
//! fallback so keys saved through older app builds keep working.
//!
//! Blob encoding: cmdkey (and the Windows credential UI) store
//! generic-credential blobs as UTF-16LE — the native Windows string charset.
//! The decoder here accepts UTF-16LE and plain UTF-8/ASCII blobs (parity +
//! printable-ASCII validation), so keys seeded by cmdkey, by the Settings
//! UI, or by older keyring versions all round-trip. The two encodings are
//! unambiguous for printable-ASCII payloads: a UTF-16LE ASCII blob pairs
//! every byte with a NUL, which the UTF-8 path rejects, and an ASCII blob
//! never decodes to printable ASCII as UTF-16.
//!
//! Keys cross this boundary only through the functions below and the
//! commands in keys.rs: never REST bodies, never localStorage, never logs.
//!
//! ROUND-100 (R100-B, ADR-0031) — THE LINUX STORE. A third imp (below)
//! backs the same three functions with the freedesktop Secret Service
//! (gnome-keyring/KWallet, encrypted at rest by the desktop keyring
//! daemon) via the `keyring` crate — `Entry::new(service, user)` with
//! service = the SAME canonical target string and user = keys.rs's
//! TARGET_USER, so the Secret Service item's attributes mirror the
//! Windows credential's (TargetName, UserName) pair. There is no
//! launcher/cmdkey interop on Linux (nothing seeds keys there), so the
//! R55 exact-TargetName constraint does not port.
//!
//! ROUND-102 (R102-A, ADR-0031 addendum) — THE LINUX STORE, MADE REAL.
//! The owner's v0.99.0 field report: "I was having issues with saving the
//! API keys. The API keys were not being properly saved at all in the
//! Linux version. I tried saving them but apparently nothing was happening
//! at all." Two defects, both fixed in the Linux imp below:
//!   · EVERY keyring call now runs on its OWN thread under a 20s timeout
//!     (`bounded`) — a hung gnome-keyring D-Bus call can never freeze the
//!     app (the key commands also became async in keys.rs, so nothing
//!     blocks the main thread); a once-per-process probe memoizes an
//!     unreachable Secret Service so spawn-time injection does not pay the
//!     timeout once per provider.
//!   · A key that cannot land in the Secret Service (no daemon, locked
//!     keyring, timeout, any write error) falls back to the DISCLOSED
//!     key file `~/.acute/provider-keys.json` (owner-only 0600, atomic
//!     tmp+rename writes) instead of erroring into "nothing happened".
//!     Reads consult the file whenever the Secret Service holds nothing;
//!     deletes clear both stores; a later successful Secret Service write
//!     RETIRES the file copy (one namespace). This bends the SPEC's
//!     "never on disk" hard rule deliberately — owner directive + the
//!     AWS CLI / kubectl / gh CLI precedent (plaintext creds file, strict
//!     perms, loud disclosure; a hardcoded-key "encryption" would be
//!     theater) — see ADR-0031's addendum for the full reasoning.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;

    use windows_sys::Win32::Foundation::{GetLastError, FILETIME};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    /// Reads the generic credential at `target`. `Ok(None)` = no such entry
    /// (normal: key not stored yet). Errors carry the win32 code, never the
    /// secret.
    pub(crate) fn read(target: &str) -> Result<Option<String>, String> {
        let target_name: Vec<u16> = to_utf16(target);
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: target_name is NUL-terminated UTF-16; `credential` receives
        // CredReadW's allocation (freed on every path below).
        let found =
            unsafe { CredReadW(target_name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) };
        if found == 0 {
            let code = unsafe { GetLastError() };
            // 1168 ERROR_NOT_FOUND — "no such credential" is normal, not an error.
            if code == windows_sys::Win32::Foundation::ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(format!("CredReadW failed (win32 error {code})"));
        }
        // SAFETY: the blob is copied into an owned String before CredFree —
        // blob_to_value allocates eagerly and cannot panic.
        let value = unsafe {
            let cred = &*credential;
            let blob =
                std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize);
            super::blob_to_value(blob)
        };
        unsafe { CredFree(credential as *const c_void) };
        Ok(value)
    }

    /// Writes (or rotates) the generic credential at `target` with user
    /// `user` and a UTF-16LE blob — byte-compatible with the launcher's
    /// cmdkey writes (same type, persistence, and user name).
    pub(crate) fn write(
        target: &str,
        user: &str,
        value: &str,
    ) -> Result<super::WriteOutcome, String> {
        let blob = super::value_to_blob(value);
        let mut target_name = to_utf16(target);
        let mut user_name = to_utf16(user);
        let credential = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target_name.as_mut_ptr(),
            Comment: std::ptr::null_mut(),
            // Ignored by CredWriteW.
            LastWritten: FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: user_name.as_mut_ptr(),
        };
        // SAFETY: the struct borrows target_name/user_name/blob, all alive
        // until the call returns; CredWriteW copies what it needs.
        let written = unsafe { CredWriteW(&credential, 0) };
        if written == 0 {
            let code = unsafe { GetLastError() };
            return Err(format!("CredWriteW failed (win32 error {code})"));
        }
        Ok(super::WriteOutcome::stored_in(super::KeyStore::CredentialManager))
    }

    /// Deletes the generic credential at `target`. `Ok(false)` = nothing was
    /// there. Used to retire legacy-form entries after a canonical write.
    pub(crate) fn delete(target: &str) -> Result<bool, String> {
        let target_name = to_utf16(target);
        // SAFETY: NUL-terminated UTF-16 target.
        let deleted = unsafe { CredDeleteW(target_name.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if deleted == 0 {
            let code = unsafe { GetLastError() };
            if code == windows_sys::Win32::Foundation::ERROR_NOT_FOUND {
                return Ok(false);
            }
            return Err(format!("CredDeleteW failed (win32 error {code})"));
        }
        Ok(true)
    }

    fn to_utf16(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

/// Linux (+ the BSDs): the freedesktop Secret Service via the `keyring`
/// crate — the Linux release's key store (ADR-0031, R100) — with the
/// ROUND-102 reliability + fallback layer (ADR-0031 addendum, R102-A).
/// `Entry::new(service, user)` with service = the canonical target string
/// and user = keys.rs's TARGET_USER; the Secret Service item's
/// `service`/`username` attributes then mirror the Windows credential's
/// (TargetName, UserName) pair.
///
/// ROUND-102 (R102-A) shape, from the owner's v0.99.0 report ("the API keys
/// were not being properly saved at all … nothing was happening at all"):
///   · `bounded` runs EVERY keyring Entry operation on a dedicated thread
///     under a 20-second deadline. The pre-R102 commands were SYNC, so
///     Tauri ran them on the MAIN thread — a Secret Service D-Bus call
///     that blocked (locked keyring whose unlock prompt cannot display,
///     a half-dead daemon, a missing session bus that zbus probes slowly)
///     froze the whole window and the invoke never resolved: exactly
///     "nothing was happening at all". A hung op now costs at most one
///     detached thread (bounded, documented) and surfaces as an error.
///   · `SECRET_SERVICE_DOWN` memoizes the FIRST unreachable verdict
///     (NoStorageAccess or a timeout) for the process lifetime, so the
///     spawn-time injection loop (12+ targets, each a keyring read) pays
///     the probe ONCE instead of 20s × N on daemon-less desktops. The
///     next app start re-probes.
///   · The DISCLOSED KEY FILE fallback (ADR-0031 addendum): when the
///     Secret Service cannot take the key, it lands in
///     `~/.acute/provider-keys.json` (0600, atomic tmp+rename, one JSON
///     map keyed by the canonical target). Reads consult it whenever the
///     Secret Service holds nothing; a later successful Secret Service
///     write retires the file copy; deletes clear both. Error strings
///     carry keyring's classification, never the secret.
#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    /// The deadline for ONE keyring Entry operation (R102-A). Generous —
    /// a legitimately busy gnome-keyring answering a collection unlock
    /// round-trip should never trip it; a hang (the owner's freeze)
    /// surfaces as an error after 20s instead of forever.
    const KEYRING_IO_TIMEOUT: Duration = Duration::from_secs(20);

    /// Process-lifetime memo: the Secret Service was proven unreachable
    /// (NoStorageAccess, or an I/O timeout). Set once, never cleared —
    /// every later call goes straight to the key file; the next app start
    /// re-probes. Cheap read on every spawn-time injection target.
    static SECRET_SERVICE_DOWN: AtomicBool = AtomicBool::new(false);

    /// Serializes key-file writes (read-modify-write cycles must not
    /// interleave; two pool-slot saves racing would otherwise lose one).
    fn file_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn secret_service_down() -> bool {
        SECRET_SERVICE_DOWN.load(Ordering::Relaxed)
    }

    fn mark_secret_service_down() {
        SECRET_SERVICE_DOWN.store(true, Ordering::Relaxed);
    }

    /// Runs one keyring Entry operation on a dedicated thread under the
    /// 20s deadline. `op` owns its inputs (the thread outlives the call
    /// only when it HANGS — the detached thread is the bounded price of
    /// not freezing the app; documented above). `label` prefixes errors;
    /// keyring error Display strings never contain the secret.
    fn bounded<T, F>(label: &str, op: F) -> Result<Result<T, keyring::Error>, String>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, keyring::Error> + Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel::<Result<T, keyring::Error>>();
        let spawned = std::thread::Builder::new()
            .name("acute-keyring-io".into())
            .spawn(move || {
                // A send failure means the caller timed out and walked —
                // the result is dropped with the thread. Nothing to do.
                let _ = tx.send(op());
            });
        if let Err(e) = spawned {
            return Err(format!("{label}: could not start the keyring worker: {e}"));
        }
        match rx.recv_timeout(KEYRING_IO_TIMEOUT) {
            Ok(result) => Ok(result),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(format!(
                "{label}: the keyring did not answer within {} seconds \
                 (a hung or locked gnome-keyring/KWallet is the usual cause)",
                KEYRING_IO_TIMEOUT.as_secs()
            )),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err(format!("{label}: the keyring worker crashed before answering"))
            }
        }
    }

    // ── The disclosed key file (ADR-0031 addendum, R102-A) ──────────────────
    // One JSON map { "<canonical target>": "<value>" } at
    // ~/.acute/provider-keys.json, 0600, atomic tmp+rename writes. The map
    // is a BTreeMap on disk (sorted keys — stable diffs, no churn), the
    // values are the SAME strings the Secret Service would hold.

    fn key_file_path() -> std::path::PathBuf {
        crate::keys::dot_acute_dir().join("provider-keys.json")
    }

    fn read_key_file_map() -> Result<Option<BTreeMap<String, String>>, String> {
        let path = key_file_path();
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                return Err(format!("reading the key file {} failed: {e}", path.display()))
            }
        };
        match serde_json::from_str(&text) {
            Ok(map) => Ok(Some(map)),
            Err(e) => Err(format!(
                "parsing the key file {} failed: {e}",
                path.display()
            )),
        }
    }

    fn write_key_file_map(map: &BTreeMap<String, String>) -> Result<(), String> {
        let path = key_file_path();
        let dir = path
            .parent()
            .ok_or_else(|| "the key file has no parent directory".to_string())?;
        // ~/.acute may not exist yet on a fresh install (the note files
        // create it lazily too). Owner-traversal only (0700) — the key
        // file's secrecy is the point of this directory.
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("creating {} failed: {e}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir)
                .map(|m| m.permissions())
                .map(|p| p.mode())
                .unwrap_or(0o755);
            if mode & 0o077 != 0 {
                // Best-effort tightening — a pre-existing 0755 ~/.acute
                // (the note files' default) must not expose key material.
                let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
            }
        }
        let json = serde_json::to_string_pretty(map)
            .map_err(|e| format!("serializing the key file failed: {e}"))?;
        // Atomic replace: write the tmp with 0600 FROM BIRTH (never a
        // world-readable instant), then rename over the live file.
        let tmp = dir.join("provider-keys.json.tmp");
        #[cfg(unix)]
        let write_result = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&tmp)
                .and_then(|mut file| file.write_all(json.as_bytes()))
        };
        #[cfg(not(unix))]
        let write_result = std::fs::write(&tmp, json.as_bytes());
        write_result.map_err(|e| format!("writing {} failed: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &path)
            .map_err(|e| format!("publishing {} failed: {e}", path.display()))
    }

    /// Reads one target from the key file. `Ok(None)` = not there (or no
    /// file at all — a fresh install).
    fn key_file_read(target: &str) -> Result<Option<String>, String> {
        match read_key_file_map()? {
            Some(map) => Ok(map.get(target).cloned()),
            None => Ok(None),
        }
    }

    /// Upserts one target into the key file (creating it). Lock-serialized.
    fn key_file_write(target: &str, value: &str) -> Result<(), String> {
        let _guard = file_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut map = read_key_file_map()?.unwrap_or_default();
        map.insert(target.to_string(), value.to_string());
        write_key_file_map(&map)
    }

    /// Removes one target from the key file; `Ok(false)` = it was not
    /// there. An empty map leaves NO file behind (a keyless ~/.acute is
    /// the honest resting state). Lock-serialized.
    fn key_file_remove(target: &str) -> Result<bool, String> {
        let _guard = file_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut map = match read_key_file_map()? {
            Some(map) => map,
            None => return Ok(false),
        };
        if map.remove(target).is_none() {
            return Ok(false);
        }
        if map.is_empty() {
            let path = key_file_path();
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(format!("removing {} failed: {e}", path.display()))
                }
            }
            return Ok(true);
        }
        write_key_file_map(&map)?;
        Ok(true)
    }

    /// The disclosed note the UI shows when a key lands in the file store
    /// (never contains the secret; the path is the actionable part).
    fn key_file_note() -> String {
        format!(
            "No Secret Service keyring could store the key, so it was saved to the \
             local key file {} (owner-only, 0600). Installing or unlocking \
             gnome-keyring/KWallet and re-saving the key moves it into the \
             encrypted system store.",
            key_file_path().display()
        )
    }

    fn key_file_outcome() -> super::WriteOutcome {
        super::WriteOutcome {
            store: super::KeyStore::KeyFile,
            note: Some(key_file_note()),
        }
    }

    /// Reads the key for `target`: Secret Service first (bounded), the key
    /// file whenever the Secret Service holds nothing reachable. `Ok(None)`
    /// = neither store has it.
    ///
    /// Error classification (live-verified on a daemon-less Linux — the
    /// dbus-secret-service backend maps "cannot connect to the bus" to
    /// PlatformFailure, NOT NoStorageAccess): only `NoEntry` proves the
    /// service ANSWERED — every other failure (NoStorageAccess,
    /// PlatformFailure, timeout, worker crash) marks the service DOWN for
    /// the process and the key file answers instead. A transient failure
    /// on a healthy service therefore degrades to the file for the session
    /// (fully functional; re-probed next boot) instead of erroring on every
    /// keyless read — the safer side of the trade, documented in ADR-0031's
    /// addendum.
    pub(crate) fn read(target: &str) -> Result<Option<String>, String> {
        if secret_service_down() {
            return key_file_read(target);
        }
        let owned = target.to_string();
        let label = format!("reading the Secret Service entry for {target}");
        let outcome = bounded(&label, move || {
            keyring::Entry::new(&owned, crate::keys::TARGET_USER)
                .and_then(|entry| entry.get_password())
        })?;
        match outcome {
            Ok(value) => Ok(Some(value)),
            // NoEntry: the daemon answered — but a key saved earlier via
            // the fallback (or by a pre-keyring app build) may still live
            // in the file. One cheap file read before declaring absence.
            // The service stays UP (it proved itself).
            Err(keyring::Error::NoEntry) => key_file_read(target),
            // Every other verdict = the service is unusable for our
            // purposes: memoize, then answer from the key file.
            Err(e) => {
                mark_secret_service_down();
                eprintln!("[keys] Secret Service read failed (falling back to the key file): {e}");
                key_file_read(target)
            }
        }
    }

    /// Writes (or rotates) the key for `target`: Secret Service first
    /// (bounded); a key the Service cannot take lands in the disclosed key
    /// file instead of erroring (the owner's "nothing was happening at
    /// all"). A SUCCESSFUL Secret Service write retires any stale key-file
    /// copy — one namespace, migration on the next re-save.
    pub(crate) fn write(
        target: &str,
        user: &str,
        value: &str,
    ) -> Result<super::WriteOutcome, String> {
        if secret_service_down() {
            key_file_write(target, value)?;
            return Ok(key_file_outcome());
        }
        let owned_target = target.to_string();
        let owned_user = user.to_string();
        let owned_value = value.to_string();
        let outcome = bounded(
            "storing the key in the freedesktop Secret Service",
            move || {
                keyring::Entry::new(&owned_target, &owned_user)
                    .and_then(|entry| entry.set_password(&owned_value))
            },
        );
        match outcome {
            Ok(Ok(())) => {
                // Migration: the canonical store has the key now — retire
                // any fallback copy (best-effort; the SS write is durable).
                let _ = key_file_remove(target);
                Ok(super::WriteOutcome::stored_in(super::KeyStore::SecretService))
            }
            // NoStorageAccess, PlatformFailure (the no-daemon / locked-
            // keyring classes — live-verified: "cannot connect to the bus"
            // arrives as PlatformFailure), timeout, worker crash: the
            // service cannot take the key. Memoize the verdict, land the
            // key in the disclosed file, report WHERE it went.
            Ok(Err(e)) => {
                mark_secret_service_down();
                eprintln!("[keys] Secret Service write refused (falling back to the key file): {e}");
                key_file_write(target, value)?;
                Ok(key_file_outcome())
            }
            Err(timeout_or_crash) => {
                mark_secret_service_down();
                eprintln!("[keys] {timeout_or_crash}");
                key_file_write(target, value)?;
                Ok(key_file_outcome())
            }
        }
    }

    /// Deletes the key for `target` from BOTH stores (best-effort each:
    /// the R90-A5/R87 semantics — a locked entry never fails the flow).
    /// `Ok(false)` = neither store had it.
    pub(crate) fn delete(target: &str) -> Result<bool, String> {
        let mut deleted = false;
        if !secret_service_down() {
            let owned = target.to_string();
            let label = format!("deleting the Secret Service entry for {target}");
            let outcome = bounded(&label, move || {
                keyring::Entry::new(&owned, crate::keys::TARGET_USER)
                    .and_then(|entry| entry.delete_credential())
            });
            match outcome {
                Ok(Ok(())) => deleted = true,
                // The service answered: nothing was there.
                Ok(Err(keyring::Error::NoEntry)) => {}
                // Everything else (NoStorageAccess, PlatformFailure,
                // timeout, crash): unusable — memoize + the file still
                // gets its retirement sweep below.
                Ok(Err(e)) => {
                    mark_secret_service_down();
                    eprintln!("[keys] Secret Service delete failed (continuing with the key file): {e}");
                }
                Err(timeout_or_crash) => {
                    mark_secret_service_down();
                    eprintln!("[keys] {timeout_or_crash}");
                }
            }
        }
        if key_file_remove(target)? {
            deleted = true;
        }
        Ok(deleted)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// R102-A: the key-file trio (read/write/remove) against a REAL
        /// temp dir — the JSON map, the 0600 file perms, the empty-map
        /// cleanup, and the upsert rotation. Runs on every Linux CI box
        /// that executes cargo test (the mini-crate harness the round doc
        /// describes ran the same assertions in the sandbox).
        #[test]
        fn key_file_round_trip() {
            let home = std::env::temp_dir().join(format!(
                "acute-keyfile-test-{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&home);
            std::fs::create_dir_all(&home).unwrap();
            std::env::set_var("HOME", &home);
            // dot_acute_dir resolves HOME at CALL time, so the isolation
            // holds without process restarts.
            let target = "ACUTE-CODE/provider/openrouter";

            assert_eq!(key_file_read(target).unwrap(), None);
            key_file_write(target, "sk-or-v1-first").unwrap();
            assert_eq!(key_file_read(target).unwrap(), Some("sk-or-v1-first".into()));

            // Rotation is an upsert, never a duplicate.
            key_file_write(target, "sk-or-v1-second").unwrap();
            assert_eq!(key_file_read(target).unwrap(), Some("sk-or-v1-second".into()));

            // The file is owner-only.
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(key_file_path()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);

            // A second target shares the map; removing one keeps the other.
            key_file_write("ACUTE-CODE/provider/nvidia", "nvapi-x").unwrap();
            assert!(key_file_remove(target).unwrap());
            assert_eq!(key_file_read(target).unwrap(), None);
            assert_eq!(
                key_file_read("ACUTE-CODE/provider/nvidia").unwrap(),
                Some("nvapi-x".into())
            );

            // Removing the LAST entry removes the file itself.
            assert!(key_file_remove("ACUTE-CODE/provider/nvidia").unwrap());
            assert!(!key_file_path().exists());
            // Idempotent absence.
            assert!(!key_file_remove("ACUTE-CODE/provider/nvidia").unwrap());

            let _ = std::fs::remove_dir_all(&home);
        }

        /// R102-A: `bounded` reports a CRASHED worker as a labeled error
        /// (the Disconnected arm — the thread died before answering). The
        /// Timeout arm is the same channel math with the clock instead of
        /// the panicking thread; its 20s const is deliberately not paid
        /// in the test suite (the sandbox mini-crate harness the round
        /// doc describes verified the shape live).
        #[test]
        fn bounded_reports_a_crashed_worker() {
            let outcome = bounded("probe", move || -> Result<String, keyring::Error> {
                panic!("worker died");
            });
            assert!(outcome.is_err());
            let message = outcome.unwrap_err();
            assert!(message.contains("crashed before answering"));
        }
    }
}

/// Everything else (dev checkouts on macOS, exotic unixes): keys flow from
/// dev.mjs env injection instead — credential storage is a
/// packaged-Windows/Linux-app concern, and the stub keeps every call site
/// honest instead of silently pretending.
#[cfg(not(any(windows, all(unix, not(target_os = "macos")))))]
mod imp {
    pub(crate) fn read(_target: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub(crate) fn write(
        _target: &str,
        _user: &str,
        _value: &str,
    ) -> Result<super::WriteOutcome, String> {
        Err("credential storage is only available in the packaged Windows and Linux apps".into())
    }
    pub(crate) fn delete(_target: &str) -> Result<bool, String> {
        Ok(false)
    }
}

/// Credential blob → value string. UTF-16LE first (native encoding),
/// UTF-8/ASCII fallback. `None` for empty or non-printable payloads (never
/// a half-guessed key).
pub(crate) fn blob_to_value(blob: &[u8]) -> Option<String> {
    let printable = |c: char| c.is_ascii_graphic() || c == ' ';
    if blob.len() >= 2 && blob.len() % 2 == 0 {
        let units: Vec<u16> = blob
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        if let Ok(text) = String::from_utf16(&units) {
            if !text.is_empty() && text.chars().all(printable) {
                return Some(text);
            }
        }
    }
    String::from_utf8(blob.to_vec())
        .ok()
        .filter(|text| !text.is_empty() && text.chars().all(printable))
}

/// Value string → credential blob, UTF-16LE (native charset — interops with
/// cmdkey, PowerShell, and the Windows credential UI).
pub(crate) fn value_to_blob(value: &str) -> Vec<u8> {
    let mut blob: Vec<u8> = Vec::with_capacity(value.len() * 2);
    for unit in value.encode_utf16() {
        blob.extend_from_slice(&unit.to_le_bytes());
    }
    blob
}

pub(crate) use imp::{delete, read, write};

/// Which OS store a key write landed in (R102-A). The commands in keys.rs
/// surface this to the webview as the `store` field of the save report so
/// the Settings UI can disclose a key-file save (amber note) instead of
/// presenting it as a Secret Service success.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyStore {
    /// Windows: Credential Manager (DPAPI at rest).
    CredentialManager,
    /// Linux: the freedesktop Secret Service (gnome-keyring/KWallet).
    SecretService,
    /// Linux fallback (ADR-0031 addendum): ~/.acute/provider-keys.json.
    KeyFile,
}

impl KeyStore {
    /// The wire spelling (keys.rs's KeyStoreReport.store).
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            KeyStore::CredentialManager => "credential-manager",
            KeyStore::SecretService => "secret-service",
            KeyStore::KeyFile => "key-file",
        }
    }
}

/// A successful write's receipt (R102-A): WHERE the key landed + the
/// optional disclosure note (the key-file path story). Never carries key
/// material.
pub(crate) struct WriteOutcome {
    pub(crate) store: KeyStore,
    pub(crate) note: Option<String>,
}

impl WriteOutcome {
    /// The no-disclosure success (the OS secure store took the key).
    pub(crate) fn stored_in(store: KeyStore) -> Self {
        WriteOutcome { store, note: None }
    }
}

#[cfg(test)]
mod tests {
    use super::{blob_to_value, value_to_blob};

    #[test]
    fn utf16_blob_round_trips() {
        let key = "sk-or-v1-0123456789abcdef";
        let blob = value_to_blob(key);
        assert_eq!(blob.len(), 2 * key.len());
        assert_eq!(blob_to_value(&blob).as_deref(), Some(key));
    }

    #[test]
    fn utf8_ascii_blob_is_accepted() {
        // A tool that stored the value as raw ASCII bytes still round-trips.
        assert_eq!(
            blob_to_value(b"sk-or-v1-abc").as_deref(),
            Some("sk-or-v1-abc")
        );
    }

    #[test]
    fn odd_length_ascii_blob_is_accepted() {
        // 69-char OpenRouter keys are odd-length in ASCII → cannot be
        // mistaken for UTF-16 (parity check) → UTF-8 path.
        let key = "s".repeat(69);
        assert_eq!(blob_to_value(key.as_bytes()).as_deref(), Some(key.as_str()));
    }

    #[test]
    fn even_length_ascii_blob_is_not_misread_as_utf16() {
        // "abcdef" as raw ASCII: the UTF-16 interpretation pairs the bytes
        // into non-ASCII units, fails the printable check, and the UTF-8
        // fallback recovers the original.
        assert_eq!(blob_to_value(b"abcdef").as_deref(), Some("abcdef"));
    }

    #[test]
    fn empty_blob_is_none() {
        assert_eq!(blob_to_value(&[]), None);
        assert_eq!(blob_to_value(&[0, 0]), None);
    }

    #[test]
    fn non_printable_blob_is_none() {
        // NULs/control bytes in either encoding are never a valid key.
        assert_eq!(blob_to_value(&[0x00, 0x41, 0x00, 0x42]), None); // "A\0B" UTF-8
        assert_eq!(blob_to_value(&[0x01, 0x00, 0x02, 0x00]), None); // controls UTF-16
    }

    #[test]
    fn garbage_even_blob_is_none() {
        // Lone-surrogate UTF-16 that is also invalid UTF-8 → rejected, not
        // half-guessed.
        assert_eq!(blob_to_value(&[0x00, 0xD8, 0x01, 0xD8]), None);
    }
}
