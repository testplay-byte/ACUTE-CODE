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
//! ROUND-92 (R92-D) — the multi-key POOL, made persistent and general.
//! The owner's directive: "In Models & Providers … add more than one API
//! key for a specific provider. Those API keys will be juggled between
//! each other. If one API key fails, it will automatically try the next
//! API key in line." A pool slot N ≥ 1 for provider <id> rides the
//! GENERALIZED form of the ROUND-51 openrouter convention: credential
//! target `ACUTE-CODE/provider/<id>-slot<N>` (the launcher-seeded
//! `openrouter-slot{2,3,4}` targets are exactly this pattern), sidecar
//! env `ACUTE_PROVIDER_<ID_UPPER>_SLOT<N>` (the keyring's slotEnvVarName
//! derivation). The (id, slot) pairs ride a THIRD note file
//! (`~/.acute/provider-pool-slots.txt`, `<providerId>:<slot>` — ids and
//! slot numbers only, NEVER secrets, same standing as the other two) so
//! pool keys survive restarts for ANY provider, not just the three
//! hardcoded openrouter slots; and the Settings add-slot flow gets real
//! slot-aware commands (store/remove_provider_key_slot), retiring the R47
//! bug where the slot-less store_provider_key OVERWROTE the primary key.
//! The juggling itself (failover to the next key) is the sidecar's task —
//! this file only makes every key durable and spawn-injected.
//!
//! Keys cross this boundary only through these Tauri commands: never REST
//! bodies, never localStorage, never logs or error strings.

use tauri::AppHandle;

use crate::sidecar;

const TARGET_PREFIX: &str = "ACUTE-CODE/provider/";
/// The pre-R55 keyring crate derived this target form from
/// `{user}.{service}`; ≤ 0.54.0 app builds wrote their keys here.
const LEGACY_TARGET_PREFIX: &str = "api-key.ACUTE-CODE/provider/";
/// The credential user name — the launcher's cmdkey convention ("api-key").
/// pub(crate) since ROUND-100 (R100-B, ADR-0031): the Linux wincred imp
/// (Secret Service via the keyring crate) also identifies entries by the
/// (service, user) pair, so its read/delete legs resolve the SAME pair the
/// write call sites here pass.
pub(crate) const TARGET_USER: &str = "api-key";

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
// ROUND-92 (R92-D): the same union now extends to NOTED POOL SLOTS —
// one entry per (providerId, slot) pair in
// ~/.acute/provider-pool-slots.txt, so a second/third API key saved for
// ANY provider (the multi-key pool the owner asked for) is re-injected at
// every spawn instead of dying on restart like custom keys once did.
// Slot 2 for openrouter is covered by the hardcoded half above; every
// other pair (nvidia slots, custom-provider slots, openrouter 5+) rides
// the note file. Dedup is by ENV NAME — a stale note line for a pair the
// hardcoded half already covers cannot duplicate an entry.
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
    // ROUND-92 (R92-D): one entry per NOTED pool slot — the env name from
    // the keyring's own slot derivation + the pseudo-id the credential
    // lives under (ACUTE-CODE/provider/<id>-slot<N>). A stale note line
    // whose key is absent is skipped silently by the consumer loop, same
    // as custom providers; the env-name dedup keeps the hardcoded half
    // authoritative for the pairs it already covers.
    for (id, slot) in noted_pool_slots() {
        let env_name = pool_slot_env_name(&id, slot);
        if !targets.iter().any(|(existing, _)| *existing == env_name) {
            targets.push((env_name, pool_slot_slug(&id, slot)));
        }
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

/// ROUND-92 (R92-D): the (providerId, slot) pairs the hardcoded half of
/// provider_key_env_targets already covers — the launcher-seeded
/// openrouter pool slots 2/3/4. store_provider_key_slot skips NOTING
/// these (a note line would only duplicate the injection entry; the
/// union's env-name dedup makes even a hand-added line harmless). Keep in
/// sync with the array above; the derivation test pins the equivalence
/// from both sides, exactly like BUILTIN_PROVIDER_IDS.
const BUILTIN_POOL_SLOTS: [(&str, u32); 3] =
    [("openrouter", 2), ("openrouter", 3), ("openrouter", 4)];

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
/// ROUND-90 (R90-A5): now CALLED — by the remove_provider_key command (the
/// delete-provider Tauri command the R82 TODO asked for).
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

// ── ROUND-92 (R92-D) — the multi-key pool's slot derivations ────────────
//
// The sidecar keyring (agent-core/src/providers/registry.ts) addresses a
// provider's key pool as slot 0 = primary (`ACUTE_PROVIDER_<ID>`) and
// slot N = `ACUTE_PROVIDER_<ID>_SLOT<N>` (slotEnvVarName). The shell's
// durable half mirrors that: slot N's key lives at the credential target
// `ACUTE-CODE/provider/<id>-slot<N>` — the exact form the ROUND-51
// launcher convention already seeds for openrouter 2/3/4, generalized to
// every provider and slot so the owner's "more than one API key per
// provider, juggled between each other" directive survives restarts.

/// The pool-slot pseudo-provider id: `<providerId>-slot<N>` — the id the
/// credential lives under and the spawn-injection list carries. openrouter
/// slot 2 → "openrouter-slot2", byte-identical to the launcher-seeded
/// convention. (A provider whose own id ends in "-slot<N>" would collide
/// with this form — a pre-existing namespace fact since ROUND-36, not one
/// this round introduces.)
fn pool_slot_slug(provider_id: &str, slot: u32) -> String {
    format!("{provider_id}-slot{slot}")
}

/// The credential target a pool slot N ≥ 1 lives at:
/// `ACUTE-CODE/provider/<id>-slot<N>` — generalizes the launcher-seeded
/// `ACUTE-CODE/provider/openrouter-slot{2,3,4}` targets.
fn pool_slot_credential_target(provider_id: &str, slot: u32) -> String {
    canonical_target(&pool_slot_slug(provider_id, slot))
}

/// The env var the spawn loop injects for a pool slot:
/// `ACUTE_PROVIDER_<ID_UPPER>_SLOT<N>` — byte-identical to the sidecar
/// keyring's slotEnvVarName (`${envVarName(providerId)}_SLOT${slot}`),
/// which is also exactly what custom_provider_env_name derives for the
/// pseudo-id "<id>-slot<N>" (every non-alphanumeric folds to '_', so the
/// two derivations agree for every id shape). The existing hardcoded
/// ACUTE_PROVIDER_OPENROUTER_SLOT2 entry proves the form; the test pins
/// the equivalence from both sides.
fn pool_slot_env_name(provider_id: &str, slot: u32) -> String {
    format!("{}_SLOT{slot}", custom_provider_env_name(provider_id))
}

/// Pool slots are 1..=31: slot 0 is the PRIMARY key (store_provider_key's
/// job — never a pool note), and the sidecar keyring scans the pool 0..32
/// (registry.ts getPool), so 31 is the highest addressable slot.
fn validate_pool_slot(slot: u32) -> Result<(), String> {
    if !(1..=31).contains(&slot) {
        return Err("pool slot must be between 1 and 31".into());
    }
    Ok(())
}

// ── ROUND-92 (R92-D) — the pool-slot NOTE file ──────────────────────────
//
// The third note file, the exact pattern of the ROUND-61 vision and
// ROUND-82 custom notes: ids + slot numbers ONLY, never secrets. Without
// it, a pool key saved in Settings died on the next restart unless it
// happened to be one of the three hardcoded openrouter slots — the same
// defect class R82-B cured for custom providers.

/// ROUND-92 (R92-D): `~/.acute/provider-pool-slots.txt` — lines of
/// `<providerId>:<slot>` (ids + slot numbers only, NEVER secrets; same
/// standing as custom-providers.txt / vision-providers.txt).
fn pool_slot_note_path() -> std::path::PathBuf {
    dirs_or_home().join(".acute").join("provider-pool-slots.txt")
}

/// Pure parser for the note file's text — one `(providerId, slot)` pair
/// per non-empty line, so the tests never touch the real ~/.acute.
/// Corrupt lines (bad id slug, missing/extra colon, unparsable or
/// out-of-range slot) are SKIPPED, never fatal: a hand-edited file must
/// not fail the spawn. Duplicates (including "openrouter:02" vs
/// "openrouter:2") collapse to the first occurrence.
fn parse_pool_slot_note_text(text: &str) -> Vec<(String, u32)> {
    let mut pairs: Vec<(String, u32)> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split(':');
        // Exactly two colon-separated fields — anything else is corrupt.
        let (Some(id), Some(slot_text), None) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue; // corrupt line — skip, never fail the spawn
        };
        if let Err(_) = validate_provider_id(id) {
            continue; // corrupt line — skip, never fail the spawn
        }
        let Ok(slot) = slot_text.parse::<u32>() else {
            continue; // corrupt line — skip, never fail the spawn
        };
        if let Err(_) = validate_pool_slot(slot) {
            continue; // corrupt line — skip, never fail the spawn
        }
        if !pairs.iter().any(|(x, s)| x == id && *s == slot) {
            pairs.push((id.to_string(), slot));
        }
    }
    pairs
}

/// ROUND-92 (R92-D): the noted (providerId, slot) pairs — deduped,
/// slug-validated, junk lines skipped, never a failed spawn (the same
/// hardening as custom_provider_ids / vision_provider_ids).
pub(crate) fn noted_pool_slots() -> Vec<(String, u32)> {
    let Ok(text) = std::fs::read_to_string(pool_slot_note_path()) else {
        return Vec::new();
    };
    parse_pool_slot_note_text(&text)
}

/// ROUND-92 (R92-D): idempotent append — the pool twin of
/// note_custom_provider, called by store_provider_key_slot for pairs NOT
/// already covered by the hardcoded builtin half of the injection list
/// (BUILTIN_POOL_SLOTS). Best-effort like every note write: the credential
/// itself is already durable, and the spawn loop skips absent keys
/// silently, so a failed note costs nothing but a restart re-injection.
fn note_pool_slot(provider_id: &str, slot: u32) {
    let path = pool_slot_note_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut pairs = noted_pool_slots();
    if !pairs.iter().any(|(id, s)| id == provider_id && *s == slot) {
        pairs.push((provider_id.to_string(), slot));
        let rendered = pairs
            .iter()
            .map(|(id, s)| format!("{id}:{s}"))
            .collect::<Vec<_>>()
            .join("\n");
        let _ = std::fs::write(&path, rendered);
    }
}

/// ROUND-92 (R92-D): drop ONE pair's note line when its key is removed, so
/// the spawn loop stops hunting a credential that no longer exists (the
/// miss itself is harmless — injection skips absent keys silently — but
/// the line is avoidable noise). Removing a provider's PRIMARY key never
/// cascades here, and this never touches the primary's own notes: pool
/// slots are independent keys (R92-D decision). Missing file or missing
/// pair = no-op; the rewrite happens only when the pair was actually
/// noted (keeps the file's mtime honest).
fn unnote_pool_slot(provider_id: &str, slot: u32) {
    let path = pool_slot_note_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return; // missing file — nothing to unnote
    };
    let wanted = format!("{provider_id}:{slot}");
    if !text.lines().any(|line| line.trim() == wanted) {
        return; // not in the file — no rewrite
    }
    let kept: Vec<String> = text
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty() && *line != wanted)
        .collect();
    let _ = std::fs::write(&path, kept.join("\n"));
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

/// ROUND-90 (R90-A5): delete ONE provider's stored key — the missing half of
/// the Settings delete-provider flow. The sidecar's DELETE /providers/:id
/// clears its IN-MEMORY keyring and the DB row, but never the OS store: the
/// Windows Credential Manager entries (canonical `ACUTE-CODE/provider/<id>`
/// plus the pre-R55 legacy target) and the `custom-providers.txt` note line
/// survived, so deleting + re-adding a provider showed "key stored" on the
/// OLD key after the next sidecar spawn. The webview calls this AFTER a
/// successful DELETE; failures are best-effort (the row is already gone).
/// No sidecar handoff is needed — the REST route already cleared the vault.
/// ROUND-92 (R92-D): deliberately NO cascade to pool slots — they are
/// independent keys and keep their credentials + note lines; the frontend
/// removes the slots it wants gone via remove_provider_key_slot.
#[tauri::command]
pub fn remove_provider_key(provider_id: String) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    let _ = crate::wincred::delete(&canonical_target(&provider_id));
    let _ = crate::wincred::delete(&legacy_target(&provider_id));
    // Drop the custom-provider note line so the spawn loop stops hunting a
    // credential that no longer exists (builtins are never noted — the
    // no-op filter inside keeps the file's mtime honest).
    unnote_custom_provider(&provider_id);
    Ok(())
}

/// ROUND-92 (R92-D): store ONE POOL-SLOT key — the multi-key pool's shell
/// half (the owner's directive: several API keys per provider, juggled with
/// automatic failover — the juggling itself is the sidecar's round). This
/// is the slot-aware store the R47 bug never had: the Settings add-slot
/// flow used to invoke the slot-less store_provider_key, which OVERWROTE
/// the primary key. The credential lands at
/// `ACUTE-CODE/provider/<id>-slot<N>` (generalizing the openrouter-slot2/3/4
/// convention), the pair is noted in ~/.acute/provider-pool-slots.txt so
/// the NEXT spawn re-injects it, and the running sidecar gets the same hot
/// handoff store_provider_key performs — now carrying the slot. Slot 0 is
/// not a pool slot: the primary key stays store_provider_key's job.
#[tauri::command]
pub fn store_provider_key_slot(
    app: AppHandle,
    provider_id: String,
    slot: u32,
    key: String,
) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    validate_pool_slot(slot)?;
    if key.trim().is_empty() {
        return Err("key must not be empty".into());
    }

    // Deliberately NOT logged; the error carries no key material.
    crate::wincred::write(
        &pool_slot_credential_target(&provider_id, slot),
        TARGET_USER,
        &key,
    )
    .map_err(|e| format!("storing pool-slot credential: {e}"))?;
    // Best-effort retirement of the pre-R55 form, same as the primary.
    let _ = crate::wincred::delete(&legacy_target(&pool_slot_slug(&provider_id, slot)));
    // Note the pair so the NEXT spawn re-injects this key — except the
    // three launcher-seeded openrouter slots the hardcoded half of the
    // injection list already covers (a note line would only duplicate
    // the entry; BUILTIN_POOL_SLOTS mirrors the BUILTIN_PROVIDER_IDS skip
    // pattern in store_provider_key). Best-effort like the retirement
    // above — the credential itself is already durable.
    if !BUILTIN_POOL_SLOTS.contains(&(provider_id.as_str(), slot)) {
        note_pool_slot(&provider_id, slot);
    }

    // The same hot handoff store_provider_key performs, now carrying the
    // slot as a separate JSON field. Today's route (agent-core server.ts)
    // validates providerId/value/action and IGNORES unknown fields —
    // verified against the source — so the payload is accepted as-is and
    // the value lands in the provider's PRIMARY env var until the R92-D
    // wave-2 route learns `slot` and routes it into
    // keyring.setSlot(providerId, slot, value) instead. The durable
    // credential is slot-scoped either way, and the next spawn injects
    // the correct ACUTE_PROVIDER_<ID>_SLOT<N> from it. The key VALUE
    // never appears in any log.
    if let Some((port, token)) = sidecar::endpoint(&app) {
        let body = serde_json::json!({
            "providerId": provider_id,
            "slot": slot,
            "keyName": "pool",
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

/// ROUND-92 (R92-D): remove ONE pool-slot key — its credential (canonical
/// + legacy targets) and its note line. Mirrors remove_provider_key's
/// best-effort shape; no sidecar handoff (the caller's REST route clears
/// the sidecar's in-memory pool slot it knows about, and a respawn reads
/// only what still exists in Credential Manager anyway).
#[tauri::command]
pub fn remove_provider_key_slot(provider_id: String, slot: u32) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    validate_pool_slot(slot)?;
    let slug = pool_slot_slug(&provider_id, slot);
    let _ = crate::wincred::delete(&canonical_target(&slug));
    let _ = crate::wincred::delete(&legacy_target(&slug));
    // Drop the pair's note line so the spawn loop stops hunting a
    // credential that no longer exists (launcher-seeded pairs are never
    // noted — the no-op filter inside keeps the file's mtime honest).
    unnote_pool_slot(&provider_id, slot);
    Ok(())
}

/// ROUND-87 (R87, the application-wide reset): delete EVERY provider
/// credential this app owns from the OS store. Enumerates the full target
/// set — the five builtins (openrouter + nvidia + the three pool slots),
/// every noted custom provider, every noted vision pseudo-provider, every
/// NOTED pool slot (ROUND-92) — in both namespaces (the canonical
/// `ACUTE-CODE/provider/<id>` targets AND the pre-R55 `api-key.…` legacy
/// forms), then clears all three note files so the NEXT spawn's injection
/// list is empty too.
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
    // ROUND-92 (R92-D): the noted pool slots' pseudo-id targets —
    // `ACUTE-CODE/provider/<id>-slot<N>` (the launcher-seeded
    // openrouter-slot{2,3,4} are already among the builtins above; the
    // note file carries every pair no fixed list knows — nvidia slots,
    // custom-provider slots, openrouter 5+).
    ids.extend(
        noted_pool_slots()
            .into_iter()
            .map(|(id, slot)| pool_slot_slug(&id, slot)),
    );

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
    // Clear all three note files (ids only, never secrets). Missing files
    // are a no-op; the sidecar's file purge would remove them anyway.
    // ROUND-92 (R92-D): provider-pool-slots.txt joins the list — a stale
    // pool note would re-arm nothing (its credential is gone) but the
    // reset's contract is an EMPTY injection list.
    for path in [
        custom_provider_note_path(),
        vision_provider_note_path(),
        pool_slot_note_path(),
    ] {
        let _ = std::fs::remove_file(&path);
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_target, custom_provider_env_name, legacy_target, parse_pool_slot_note_text,
        pool_slot_credential_target, pool_slot_env_name, pool_slot_slug, validate_pool_slot,
        validate_provider_id, BUILTIN_POOL_SLOTS, BUILTIN_PROVIDER_IDS,
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

    /// ROUND-92 (R92-D): the pool-slot derivations must be byte-identical
    /// to what already ships — the launcher-seeded openrouter-slot2
    /// credential target and the hardcoded ACUTE_PROVIDER_OPENROUTER_SLOT2
    /// injection entry — because the generalized slots ride the very same
    /// convention. The two env derivations (slot-suffix form and pseudo-id
    /// form) must agree for every id shape: non-alphanumerics fold to '_'
    /// either way. BUILTIN_POOL_SLOTS rows pin the skip list to the
    /// hardcoded half of provider_key_env_targets, exactly like
    /// BUILTIN_PROVIDER_IDS above.
    #[test]
    fn pool_slot_derivations_match_the_shipped_convention() {
        assert_eq!(pool_slot_slug("openrouter", 2), "openrouter-slot2");
        assert_eq!(
            pool_slot_credential_target("openrouter", 2),
            "ACUTE-CODE/provider/openrouter-slot2"
        );
        for (id, slot, env_name) in [
            ("openrouter", 2u32, "ACUTE_PROVIDER_OPENROUTER_SLOT2"),
            ("openrouter", 5, "ACUTE_PROVIDER_OPENROUTER_SLOT5"),
            ("nvidia", 3, "ACUTE_PROVIDER_NVIDIA_SLOT3"),
            ("prv_my-gateway", 7, "ACUTE_PROVIDER_PRV_MY_GATEWAY_SLOT7"),
        ] {
            assert_eq!(pool_slot_env_name(id, slot), env_name);
            // The slot-suffix form is the same math as deriving the env
            // name of the pseudo-id "<id>-slot<N>" (registry.ts
            // slotEnvVarName vs envVarName on the slug).
            assert_eq!(
                pool_slot_env_name(id, slot),
                custom_provider_env_name(&pool_slot_slug(id, slot))
            );
        }
        for (id, slot) in BUILTIN_POOL_SLOTS {
            assert_eq!(
                pool_slot_env_name(id, slot),
                custom_provider_env_name(&pool_slot_slug(id, slot))
            );
            // The pseudo-id of every hardcoded builtin pool pair IS one of
            // the builtin provider ids — the two skip lists describe the
            // same hardcoded half.
            assert!(BUILTIN_PROVIDER_IDS.contains(&pool_slot_slug(id, slot).as_str()));
        }
    }

    /// ROUND-92 (R92-D): pool slots are 1..=31 — slot 0 is the primary
    /// (store_provider_key's job), and the sidecar keyring scans the pool
    /// 0..32 (registry.ts getPool), so 31 is the highest addressable slot.
    #[test]
    fn pool_slots_are_validated() {
        assert!(validate_pool_slot(1).is_ok());
        assert!(validate_pool_slot(31).is_ok());
        assert!(validate_pool_slot(0).is_err());
        assert!(validate_pool_slot(32).is_err());
        assert!(validate_pool_slot(u32::MAX).is_err());
    }

    /// ROUND-92 (R92-D): the note-file parser — dedup, corrupt-line skip,
    /// range enforcement. Pure (text in, pairs out) so the test never
    /// touches the real ~/.acute. Every line between the good ones is a
    /// distinct corruption class the spawn must survive.
    #[test]
    fn pool_slot_note_text_parses_and_hardens() {
        let text = "\
openrouter:2
openrouter:2

bogus line: no wait
prv_my-gateway:5
nvidia:0
openrouter:99
openrouter:three
:7
prv_ok-slot3
PRV_UPPER:2
openrouter:02
openrouter:
:2
two:colons:3
prv_my-gateway:5
";
        let pairs = parse_pool_slot_note_text(text);
        assert_eq!(
            pairs,
            vec![
                ("openrouter".to_string(), 2u32),
                ("prv_my-gateway".to_string(), 5),
            ]
        );
        // Empty and missing files parse to nothing — never an error.
        assert!(parse_pool_slot_note_text("").is_empty());
        assert!(parse_pool_slot_note_text("\n \n\t\n").is_empty());
        // The canonical render of the accepted pairs round-trips.
        let rendered = pairs
            .iter()
            .map(|(id, s)| format!("{id}:{s}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(rendered, "openrouter:2\nprv_my-gateway:5");
        assert_eq!(parse_pool_slot_note_text(&rendered), pairs);
    }
}
