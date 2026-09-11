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
//! ROUND-82 (R82-B) — custom-provider ids ride a note file
//! (`~/.acute/custom-providers.txt`: ids only, never secrets, the same
//! standing as the ROUND-61 vision note) so keys saved for providers the
//! owner creates in Settings are re-injected at EVERY sidecar spawn
//! instead of dying on the first restart (the pre-R82 hardcoded injection
//! list never knew them).
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
// ROUND-80 (R80, owner: "make sure it works with the nvidia api key too"):
// "nvidia" joins the spawn-time injection — the built-in NIM provider row
// (storage/providers.ts seeds it) reads ACUTE_PROVIDER_NVIDIA through the
// same keyring path every other provider uses; the key value lives in
// Credential Manager under ACUTE-CODE/provider/nvidia (the Settings flow's
// store_provider_key writes exactly that target).
// ROUND-82 (R82-B, agent-ctx/research/models-providers-fixes.md §1.4.1 —
// "custom-provider keys die on app restart"): the list is no longer ONLY
// these hardcoded builtins. A custom provider (prv_… slugs created in
// Settings) had its key written to Credential Manager and pushed into the
// RUNNING sidecar's in-memory vault (POST /internal/providers/keys), but
// the spawn-time injection never re-injected it — the key worked in the
// session where it was saved, then failed with `409 no API key for
// provider 'prv_…'` on every restart after. The cure mirrors the proven
// ROUND-61 vision-note pattern: store_provider_key notes the custom id in
// ~/.acute/custom-providers.txt (ids only, never secrets), and this list
// unions the builtins with the noted ids — the env names follow the sidecar
// keyring's own derivation, so a noted key is found at spawn exactly like
// a builtin's. The builtins stay hardcoded verbatim (the launcher's seeded
// targets) and are deliberately NOT noted — noting them would duplicate
// entries.
pub(crate) fn provider_key_env_targets() -> Vec<(String, String)> {
    // The 5 builtins verbatim (ROUND-51 pool slots + ROUND-80 nvidia).
    let mut targets: Vec<(String, String)> = vec![
        ("ACUTE_PROVIDER_OPENROUTER".to_string(), "openrouter".to_string()),
        ("ACUTE_PROVIDER_NVIDIA".to_string(), "nvidia".to_string()),
        (
            "ACUTE_PROVIDER_OPENROUTER_SLOT2".to_string(),
            "openrouter-slot2".to_string(),
        ),
        (
            "ACUTE_PROVIDER_OPENROUTER_SLOT3".to_string(),
            "openrouter-slot3".to_string(),
        ),
        (
            "ACUTE_PROVIDER_OPENROUTER_SLOT4".to_string(),
            "openrouter-slot4".to_string(),
        ),
    ];
    // ROUND-82: one entry per NOTED custom provider — the keyring-derivation
    // env name (custom_provider_env_name) + the id the credential lives
    // under. A stale or hand-edited note line whose key is absent is skipped
    // silently by the consumer loop — never a failed spawn.
    for id in custom_provider_ids() {
        targets.push((custom_provider_env_name(&id), id));
    }
    targets
}

/// ROUND-82 (R82-B): the builtin provider ids the hardcoded half of
/// provider_key_env_targets already covers. store_provider_key skips
/// NOTING these — a note line would only duplicate the injection entry.
/// Keep in sync with the array above; the derivation test pins the
/// equivalence from both sides.
const BUILTIN_PROVIDER_IDS: [&str; 5] = [
    "openrouter",
    "nvidia",
    "openrouter-slot2",
    "openrouter-slot3",
    "openrouter-slot4",
];

/// ROUND-61 (R61): the SEPARATE VISION-MODEL key — the owner's directive:
/// "for the vision we are utilizing a separate model… configure the API for
/// that model and the provider completely separately." The vision key rides
/// the SAME conventions as every other key: credential target
/// `ACUTE-CODE/provider/<providerId>-vision`, sidecar env
/// `ACUTE_PROVIDER_<ID>_VISION` (the keyring's derivation for the
/// pseudo-provider "<providerId>-vision"), the same store→handoff flow.
/// The KEY VALUE lives ONLY in the OS credential store — this file records
/// provider ID SLUGS (not secrets) so the spawn-time env injection can find
/// them without enumerating the whole credential store.
fn vision_provider_note_path() -> std::path::PathBuf {
    dirs_or_home().join(".acute").join("vision-providers.txt")
}

/// The home dir without extra crates (the tauri path resolver is async; the
/// synchronous env-based form is stable on Windows and Unix).
fn dirs_or_home() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        // USERPROFILE is always set on Windows sessions.
        std::path::PathBuf::from(
            std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Public".into()),
        )
    }
    #[cfg(not(windows))]
    {
        std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
    }
}

/// Provider ids with a stored vision key (deduped, slug-validated).
pub(crate) fn vision_provider_ids() -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(vision_provider_note_path()) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = Vec::new();
    for line in text.lines() {
        let id = line.trim();
        if id.is_empty() {
            continue;
        }
        if let Err(_) = validate_provider_id(id) {
            continue; // corrupt line — skip, never fail the spawn
        }
        if !ids.iter().any(|x| x == id) {
            ids.push(id.to_string());
        }
    }
    ids
}

fn note_vision_provider(provider_id: &str) {
    let path = vision_provider_note_path();
    // create_dir_all takes AsRef<Path> — path.parent() is Option<&Path>, so
    // the Some case is unwrapped explicitly (the None case — a rootless
    // relative path — simply skips the mkdir; the write below surfaces it).
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut ids = vision_provider_ids();
    if !ids.iter().any(|x| x == provider_id) {
        ids.push(provider_id.to_string());
        let _ = std::fs::write(&path, ids.join("\n"));
    }
}

/// The vision keyring pseudo-provider id for a real provider id.
fn vision_slug(provider_id: &str) -> String {
    format!("{provider_id}-vision")
}

/// The env var name for a vision pseudo-provider (the keyring derivation:
/// ACUTE_PROVIDER_<ID_UPPER> with non-alphanumerics folded to underscores).
/// Takes the SLUG ("<providerId>-vision") so the result is
/// ACUTE_PROVIDER_<ID>_VISION — NEVER the provider's primary env var.
fn vision_env_name(slug: &str) -> String {
    let upper: String = slug
        .to_uppercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("ACUTE_PROVIDER_{upper}")
}

/// ROUND-61: store the SEPARATE vision-model key. Same shape as
/// store_provider_key: credential write → note the id for spawn-time env
/// injection → push into the RUNNING sidecar's in-memory vault via the
/// internal handoff route (providerId "<id>-vision") so a connection test
/// works without a respawn. The value never appears in any log.
#[tauri::command]
pub fn store_vision_key(app: AppHandle, provider_id: String, key: String) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    if key.trim().is_empty() {
        return Err("key must not be empty".into());
    }
    let slug = vision_slug(&provider_id);
    crate::wincred::write(&canonical_target(&slug), TARGET_USER, &key)
        .map_err(|e| format!("storing vision credential: {e}"))?;

    note_vision_provider(&provider_id);

    if let Some((port, token)) = sidecar::endpoint(&app) {
        let body = serde_json::json!({
            "providerId": slug,
            "keyName": "vision",
            "value": key,
            "action": "set",
        })
        .to_string();
        if let Err(e) = sidecar::http_status(
            "POST",
            port,
            "/internal/providers/keys",
            Some(token.as_str()),
            Some(body.as_str()),
        ) {
            // The durable credential is written; the in-memory push is a
            // convenience for immediate testing. Log WITHOUT the value.
            crate::sidecar::log_line(&format!(
                "sidecar: pushing vision key for {provider_id} failed: {e}"
            ));
        }
    }
    Ok(())
}

/// ROUND-61: does the vision key exist for this provider (Settings badge)?
#[tauri::command]
pub fn vision_key_status(provider_id: String) -> Result<bool, String> {
    validate_provider_id(&provider_id)?;
    let slug = vision_slug(&provider_id);
    Ok(read_provider_key_lossy(&slug).is_some())
}

/// ROUND-61: the spawn-time env pairs for every noted vision provider
/// ((env name, credential provider id)). Fused into the sidecar spawn loop
/// alongside provider_key_env_targets (dynamic since ROUND-82: builtins
/// plus noted custom-provider ids).
pub(crate) fn vision_env_targets() -> Vec<(String, String)> {
    vision_provider_ids()
        .into_iter()
        .map(|id| {
            let slug = vision_slug(&id);
            (vision_env_name(&slug), slug)
        })
        .collect()
}

// ── ROUND-82 (R82-B) — custom-provider keys survive app restarts ────────
//
// The defect (agent-ctx/research/models-providers-fixes.md §1.4.1): the
// spawn-time injection list was the hardcoded 5-entry builtin array, so a
// custom provider (prv_… slugs the owner creates in Settings) worked in the
// session where its key was saved — store_provider_key wrote the credential
// AND pushed it into the RUNNING sidecar's in-memory vault — and then died
// with `409 no API key for provider 'prv_…'` on every restart after. The
// cure mirrors the proven ROUND-61 vision pattern (same file, above)
// exactly: a note file records provider ID SLUGS — never secrets, same
// standing as vision-providers.txt — so the spawn loop can find them
// without enumerating the whole credential store.

/// ROUND-82 (R82-B): `~/.acute/custom-providers.txt` — ids only, never
/// secrets (same standing as the vision note file).
fn custom_provider_note_path() -> std::path::PathBuf {
    dirs_or_home().join(".acute").join("custom-providers.txt")
}

/// ROUND-82 (R82-B): provider ids with a stored custom-provider key
/// (deduped, slug-validated; junk/corrupt lines skipped, same hardening as
/// vision_provider_ids — a hand-edited file never fails the spawn).
pub(crate) fn custom_provider_ids() -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(custom_provider_note_path()) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = Vec::new();
    for line in text.lines() {
        let id = line.trim();
        if id.is_empty() {
            continue;
        }
        if let Err(_) = validate_provider_id(id) {
            continue; // corrupt line — skip, never fail the spawn
        }
        if !ids.iter().any(|x| x == id) {
            ids.push(id.to_string());
        }
    }
    ids
}

/// ROUND-82 (R82-B): idempotent append — the custom twin of
/// note_vision_provider, called by store_provider_key for NON-builtin ids
/// only (BUILTIN_PROVIDER_IDS are already covered by the hardcoded half of
/// the injection list; noting them would duplicate entries).
fn note_custom_provider(provider_id: &str) {
    let path = custom_provider_note_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut ids = custom_provider_ids();
    if !ids.iter().any(|x| x == provider_id) {
        ids.push(provider_id.to_string());
        let _ = std::fs::write(&path, ids.join("\n"));
    }
}

/// ROUND-82 (R82-B): drop a provider's note line when its key is REMOVED or
/// the provider deleted, so the spawn loop stops hunting a credential that
/// no longer exists. The miss itself is harmless — injection skips absent
/// keys silently — but custom providers get deleted by users (unlike vision
/// pseudo-providers), and a stale line is avoidable noise. Missing or
/// unreadable file = no-op; the rewrite happens only when the id was
/// actually noted (keeps the file's mtime honest).
// TODO(R82-follow-up): no call site exists yet — the Rust shell has no
// key-removal or provider-delete Tauri command (store_provider_key rejects
// empty keys, and deleting a provider flows through the sidecar's REST
// route, DELETE /providers/:id in agent-core, which never touches Credential
// Manager or this note file). Wire unnote_custom_provider into the
// remove-key / delete-provider Tauri command when one lands; until then a
// stale line only costs one skipped lookup at spawn.
#[allow(dead_code)]
fn unnote_custom_provider(provider_id: &str) {
    let path = custom_provider_note_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return; // missing file — nothing to unnote
    };
    let noted = text.lines().any(|line| line.trim() == provider_id);
    if !noted {
        return; // not in the file — no rewrite
    }
    let kept: Vec<String> = text
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|id| !id.is_empty() && id != provider_id)
        .collect();
    let _ = std::fs::write(&path, kept.join("\n"));
}

/// ROUND-82 (R82-B): the env var name for a custom provider — the TypeScript
/// keyring's derivation replicated EXACTLY (agent-core/src/providers/
/// registry.ts ProviderKeyring.envVarName:
/// `ACUTE_PROVIDER_${id.toUpperCase().replace(/[^A-Za-z0-9]/g, "_")}`) so
/// the sidecar's keyring.get(providerId) finds the very name the spawn loop
/// injected: prv_my-gateway → ACUTE_PROVIDER_PRV_MY_GATEWAY.
/// (vision_env_name above is the same math applied to the "<id>-vision"
/// slugs; custom ids are plain provider ids, so no slug form.)
fn custom_provider_env_name(provider_id: &str) -> String {
    let upper: String = provider_id
        .to_uppercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("ACUTE_PROVIDER_{upper}")
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
    // ROUND-82 (R82-B): note the id so the NEXT spawn re-injects this key —
    // pre-R82 the injection list was hardcoded and a custom provider's key
    // died on the first restart after saving (`409 no API key for
    // provider 'prv_…'`). Builtins are skipped: the hardcoded half of
    // provider_key_env_targets already covers them, and a note line would
    // duplicate the entry. Best-effort like the retirement above — the
    // credential itself is already durable.
    if !BUILTIN_PROVIDER_IDS.contains(&provider_id.as_str()) {
        note_custom_provider(&provider_id);
    }

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

/// ROUND-87 (R87, the application-wide reset): delete EVERY provider
/// credential this app owns from the OS store. Enumerates the full target
/// set — the five builtins (openrouter + nvidia + the three pool slots),
/// every noted custom provider, every noted vision pseudo-provider — in both
/// namespaces (the canonical `ACUTE-CODE/provider/<id>` targets AND the
/// pre-R55 `api-key.…` legacy forms), then clears both note files so the
/// NEXT spawn's injection list is empty too.
///
/// The webview calls this BEFORE POST /system/reset: the sidecar's purge
/// removes the note FILES themselves, so reading them here first is the only
/// chance to know which custom targets to erase. Returns the number of
/// credential entries actually deleted (misses are fine — a dev machine has
/// none). Never logged, never echoes values.
#[tauri::command]
pub fn purge_provider_keys() -> Result<u32, String> {
    let mut ids: Vec<String> = BUILTIN_PROVIDER_IDS
        .iter()
        .map(|id| id.to_string())
        .collect();
    ids.extend(custom_provider_ids());
    // Vision pseudo-providers ride the `<id>-vision` slug targets.
    ids.extend(vision_provider_ids().into_iter().map(|id| vision_slug(&id)));

    let mut deleted: u32 = 0;
    for id in &ids {
        for target in [canonical_target(id), legacy_target(id)] {
            match crate::wincred::delete(&target) {
                Ok(true) => deleted += 1,
                Ok(false) => {}
                Err(_) => {
                    // Best-effort — a locked store entry never fails the
                    // reset; the credential stays and the owner can clear
                    // it by hand from the Windows credential UI.
                }
            }
        }
    }
    // Clear both note files (ids only, never secrets). Missing files are a
    // no-op; the sidecar's file purge would remove them anyway.
    for path in [custom_provider_note_path(), vision_provider_note_path()] {
        let _ = std::fs::remove_file(&path);
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_target, custom_provider_env_name, legacy_target, validate_provider_id,
        BUILTIN_PROVIDER_IDS,
    };

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

    /// ROUND-82 (R82-B): the custom-provider env-name derivation must be
    /// byte-identical to the TypeScript keyring's ProviderKeyring.envVarName
    /// (`ACUTE_PROVIDER_${id.toUpperCase().replace(/[^A-Za-z0-9]/g, "_")}` —
    /// agent-core/src/providers/registry.ts) — that is what makes the
    /// sidecar's keyring.get("prv_…") find the value the spawn loop
    /// injected. The five builtin rows pin the derivation to the exact env
    /// names the pre-R82 hardcoded array used, so the dynamic list can
    /// never drift from it, and BUILTIN_PROVIDER_IDS (store_provider_key's
    /// don't-note skip list) can never drift from the array.
    #[test]
    fn custom_env_names_match_the_typescript_keyring() {
        assert_eq!(
            custom_provider_env_name("prv_my-gateway"),
            "ACUTE_PROVIDER_PRV_MY_GATEWAY"
        );
        for (id, env_name) in [
            ("openrouter", "ACUTE_PROVIDER_OPENROUTER"),
            ("nvidia", "ACUTE_PROVIDER_NVIDIA"),
            ("openrouter-slot2", "ACUTE_PROVIDER_OPENROUTER_SLOT2"),
            ("openrouter-slot3", "ACUTE_PROVIDER_OPENROUTER_SLOT3"),
            ("openrouter-slot4", "ACUTE_PROVIDER_OPENROUTER_SLOT4"),
        ] {
            assert_eq!(custom_provider_env_name(id), env_name);
            assert!(BUILTIN_PROVIDER_IDS.contains(&id));
        }
    }
}
