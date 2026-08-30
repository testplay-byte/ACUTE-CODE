//! Provider API-key storage (ARCHITECTURE §7, SPEC hard rule: secrets live
//! only in Windows Credential Manager / DPAPI). The keyring targets mirror the
//! spawn-injection reader in sidecar.rs EXACTLY — service
//! `ACUTE-CODE/provider/<providerId>`, user `api-key` — so a key saved here is
//! picked up on the next sidecar spawn as `ACUTE_PROVIDER_<ID>`.
//!
//! Keys cross this boundary only through these Tauri commands: never REST
//! bodies, never localStorage, never logs or error strings.

use tauri::AppHandle;

use crate::sidecar;

const KEYRING_SERVICE_PREFIX: &str = "ACUTE-CODE/provider/";
const KEYRING_USER: &str = "api-key";

fn entry(provider_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        &format!("{KEYRING_SERVICE_PREFIX}{provider_id}"),
        KEYRING_USER,
    )
    .map_err(|e| format!("opening credential entry: {e}"))
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

/// Stores/rotates the provider API key in Credential Manager, then best-effort
/// pushes it into the running sidecar's in-memory vault via the internal
/// handoff route (API.md §2.3) so a connection test works without a respawn.
#[tauri::command]
pub fn store_provider_key(app: AppHandle, provider_id: String, key: String) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    if key.trim().is_empty() {
        return Err("key must not be empty".into());
    }

    // Deliberately NOT logged; the error carries no key material.
    entry(&provider_id)?
        .set_password(&key)
        .map_err(|e| format!("storing credential: {e}"))?;

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
/// the keyring). Unknown provider id → validation error, same as store.
#[tauri::command]
pub fn provider_key_status(provider_id: String) -> Result<bool, String> {
    validate_provider_id(&provider_id)?;
    match entry(&provider_id)?.get_password() {
        Ok(value) => Ok(!value.is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("reading credential: {e}")),
    }
}
