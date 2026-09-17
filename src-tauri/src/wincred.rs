//! The provider-key store (ARCHITECTURE §7 / SPEC hard rule: provider API
//! keys live in the OS secure store, never on disk) — Windows Credential
//! Manager (generic credentials, DPAPI) on Windows; the freedesktop Secret
//! Service on Linux (ADR-0031, ROUND-100).
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
//! R55 exact-TargetName constraint does not port; headless machines
//! (no keyring daemon) get the honest fallback — reads return none,
//! writes error pointing at the ACUTE_PROVIDER_<ID> env vars.

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
    pub(crate) fn write(target: &str, user: &str, value: &str) -> Result<(), String> {
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
        Ok(())
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
/// crate — the Linux release's key store (ADR-0031). `Entry::new(service,
/// user)` with service = the canonical target string and user = keys.rs's
/// TARGET_USER; the Secret Service item's `service`/`username` attributes
/// then mirror the Windows credential's (TargetName, UserName) pair.
///
/// Honest headless fallback (no gnome-keyring/KWallet daemon on the session
/// bus): reads return `Ok(None)` — a store that cannot be reached holds no
/// key — and writes error pointing at the ACUTE_PROVIDER_<ID> env vars (the
/// dev path that already works, `scripts/dev.mjs`). Error strings carry
/// keyring's classification, never the secret.
#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    /// The Secret Service entry for `target`. `Entry::new` only maps the
    /// (service, user) pair to item attributes — no bus I/O — so it cannot
    /// fail for storage reasons, only for malformed inputs.
    fn entry_for(target: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(target, crate::keys::TARGET_USER)
            .map_err(|e| format!("creating the Secret Service entry for {target} failed: {e}"))
    }

    /// Reads the Secret Service item at `target`. `Ok(None)` = no such
    /// entry (normal: key not stored yet) OR no reachable keyring daemon
    /// (NoStorageAccess — the honest headless fallback, ADR-0031).
    pub(crate) fn read(target: &str) -> Result<Option<String>, String> {
        let entry = entry_for(target)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(keyring::Error::NoStorageAccess(_)) => Ok(None),
            Err(e) => Err(format!(
                "reading the Secret Service entry for {target} failed: {e}"
            )),
        }
    }

    /// Writes (or rotates) the Secret Service item at `target` with user
    /// `user`. `set_password` updates an existing matching item in place,
    /// so re-saving rotates rather than duplicating.
    pub(crate) fn write(target: &str, user: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(target, user)
            .map_err(|e| format!("creating the Secret Service entry for {target} failed: {e}"))?
            .set_password(value)
            .map_err(|e| {
                format!(
                    "storing the key in the freedesktop Secret Service failed: {e} — \
                     on headless Linux (no gnome-keyring/KWallet daemon), provide the \
                     ACUTE_PROVIDER_<ID> environment variables instead"
                )
            })
    }

    /// Deletes the Secret Service item at `target`. `Ok(false)` = nothing
    /// was there (or no daemon could be reached — nothing to retire).
    pub(crate) fn delete(target: &str) -> Result<bool, String> {
        let entry = entry_for(target)?;
        match entry.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(keyring::Error::NoStorageAccess(_)) => Ok(false),
            Err(e) => Err(format!(
                "deleting the Secret Service entry for {target} failed: {e}"
            )),
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
    pub(crate) fn write(_target: &str, _user: &str, _value: &str) -> Result<(), String> {
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
