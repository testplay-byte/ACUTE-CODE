//! Provider API-key storage (ARCHITECTURE §7, SPEC hard rule: secrets live
//! only in Windows Credential Manager / DPAPI).
//!
//! ROUND-55 (R55) — ONE namespace, shared with the launcher. Targets are the
//! launcher's canonical, cmdkey-seeded `ACUTE-CODE/provider/<providerId>`
//! (user `api-key`) — read at every sidecar spawn AND written by the Settings
//! UI, so the owner's keys seeded from credentials.txt and keys rotated
//! in-app finally meet in the same credential entries. The pre-R55 keyring
//! form (`api-key.ACUTE-CODE/provider/<id>`, written by app builds ≤ 0.54.0
//! through the keyring crate's `{user}.{service}` TargetName) is still READ
//! as a fallback and retired on the next write — no key is ever lost.
//!
//! Keys cross this boundary only through these Tauri commands: never REST
//! bodies, never localStorage, never logs or error strings.

use tauri::AppHandle;

use crate::sidecar;

const TARGET_PREFIX: &str = "ACUTE-CODE/provider/";
/// The pre-R55 keyring crate derived this target form from
/// `{user}.{service}`; ≤ 0.54.0 app builds wrote their keys here.
const LEGACY_TARGET_PREFIX: &str = "api-key.ACUTE-CODE/provider/";
const TARGET_USER: &str = "api-key";

fn canonical_target(provider_id: &str) -> String {
    format!("{TARGET_PREFIX}{provider_id}")
}

fn legacy_target(provider_id: &str) -> String {
    format!("{LEGACY_TARGET_PREFIX}{provider_id}")
}

/// Credential targets whose values become ACUTE_PROVIDER_<ID> env vars in
/// the sidecar spawn (ARCHITECTURE §7). ROUND-51 (R51-a): the sub-agent POOL
/// slots 2/3/4 ride along — the launcher's `desktop` flow pushes
/// credentials.txt's OPENROUTER_SUB1..3_KEY values into Credential Manager
/// under exactly these `ACUTE-CODE/provider/openrouter-slot{2,3,4}` targets,
/// so the pool keys survive restarts of the PACKAGED app instead of living
/// only in the spawn env of a dev-mode launch. Slot ids pass
/// validate_provider_id (lowercase + digits + '-'), so the Settings UI's
/// key-pool slot rows read the very same entries.
pub(crate) fn provider_key_env_targets() -> [(&'static str, &'static str); 4] {
    [
        ("ACUTE_PROVIDER_OPENROUTER", "openrouter"),
        ("ACUTE_PROVIDER_OPENROUTER_SLOT2", "openrouter-slot2"),
        ("ACUTE_PROVIDER_OPENROUTER_SLOT3", "openrouter-slot3"),
        ("ACUTE_PROVIDER_OPENROUTER_SLOT4", "openrouter-slot4"),
    ]
}

/// Provider ids are slugs everywhere in the system (API.md §8.2); enforce that
/// here so the credential target can't be gamed with odd characters.
fn validate_provider_id(provider_id: &str) -> Result<(), String> {
    if provider_id.is_empty() {
        return Err("providerId must not be empty".into());
    }
    if !provider_id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err("providerId may only contain lowercase letters, digits, '-' and '_'".into());
    }
    Ok(())
}

/// Reads the provider's key: canonical target first, then the legacy
/// keyring-form target (≤ 0.54.0 writes). `Ok(None)` = no key stored.
pub(crate) fn read_provider_key(provider_id: &str) -> Result<Option<String>, String> {
    let canonical = crate::wincred::read(&canonical_target(provider_id))?;
    if canonical.is_some() {
        return Ok(canonical);
    }
    Ok(crate::wincred::read(&legacy_target(provider_id))?)
}

/// Reads the key for spawn-time env injection. Failures are logged (without
/// key material) and treated as absent — a broken credential store must not
/// take the engine down with it.
pub(crate) fn read_provider_key_lossy(provider_id: &str) -> Option<String> {
    match read_provider_key(provider_id) {
        Ok(key) => key.filter(|k| !k.is_empty()),
        Err(e) => {
            crate::sidecar::log_line(&format!(
                "sidecar: reading key for {provider_id} failed: {e}"
            ));
            None
        }
    }
}

/// Stores/rotates the provider API key at the canonical target, then
/// best-effort retires the legacy-form entry (one namespace from now on) and
/// pushes the key into the running sidecar's in-memory vault via the
/// internal handoff route (API.md §2.3) so a connection test works without a
/// respawn.
#[tauri::command]
pub fn store_provider_key(app: AppHandle, provider_id: String, key: String) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    if key.trim().is_empty() {
        return Err("key must not be empty".into());
    }

    // Deliberately NOT logged; the error carries no key material.
    crate::wincred::write(&canonical_target(&provider_id), TARGET_USER, &key)
        .map_err(|e| format!("storing credential: {e}"))?;
    // Best-effort retirement of the pre-R55 form — the canonical write is
    // already durable, so a failure here changes nothing for the user.
    let _ = crate::wincred::delete(&legacy_target(&provider_id));

    if let Some((port, token)) = sidecar::endpoint(&app) {
        let body = serde_json::json!({
            "providerId": provider_id,
            "keyName": "main",
            "value": key,
            "action": "set",
        })
        .to_string();
        if let Err(e) = sidecar::http_status(
            "POST",
            port,
            "/internal/providers/keys",
            Some(&token),
            Some(&body),
        ) {
            // Route may not exist yet (sidecar workstream in flight); the
            // credential is safely stored either way.
            eprintln!("[keys] sidecar vault handoff skipped: {e}");
        }
    }
    Ok(())
}

/// True when a non-empty credential exists for the provider (no value leaves
/// the credential store). Unknown provider id → validation error, same as
/// store.
#[tauri::command]
pub fn provider_key_status(provider_id: String) -> Result<bool, String> {
    validate_provider_id(&provider_id)?;
    let key = read_provider_key(&provider_id)?;
    Ok(key.as_deref().map(|k| !k.is_empty()).unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::{canonical_target, legacy_target, validate_provider_id};

    /// The R55 contract: reads/writes target the launcher's cmdkey form,
    /// with the pre-R55 keyring form as the legacy fallback. These two
    /// strings are pinned because they must stay byte-identical to
    /// launcher/acute_launcher.py `_desktop_seed_keys` (canonical) and to
    /// what keyring 4.x `Entry::new(service, "api-key")` derived (legacy).
    #[test]
    fn targets_pin_both_namespaces() {
        assert_eq!(
            canonical_target("openrouter"),
            "ACUTE-CODE/provider/openrouter"
        );
        assert_eq!(
            canonical_target("openrouter-slot2"),
            "ACUTE-CODE/provider/openrouter-slot2"
        );
        assert_eq!(
            legacy_target("openrouter"),
            "api-key.ACUTE-CODE/provider/openrouter"
        );
    }

    #[test]
    fn provider_ids_are_validated() {
        assert!(validate_provider_id("openrouter").is_ok());
        assert!(validate_provider_id("openrouter-slot2").is_ok());
        assert!(validate_provider_id("").is_err());
        assert!(validate_provider_id("OpenRouter").is_err());
        assert!(validate_provider_id("open router").is_err());
    }
}
