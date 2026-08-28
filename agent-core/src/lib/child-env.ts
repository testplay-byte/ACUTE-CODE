/**
 * ROUND-45 (audit P0-3): child-process environment scrubbing.
 *
 * The sidecar process holds SECRETS in its environment:
 *   - ACUTE_TOKEN (bearer auth for the loopback API)
 *   - ACUTE_PROVIDER_<ID> + ACUTE_PROVIDER_<ID>_SLOT<N> (provider API keys)
 *   - ACUTE_DB_PATH (not a secret, but app-internal)
 * Before R45, every spawned child (run_command tool, the sync terminal
 * route, the streaming terminal route) inherited ALL of them via
 * `env: { ...process.env }` — any executed script or dependency could read
 * the owner's keys, even though tool OUTPUT is keyring-scrubbed before the
 * model sees it (runtime.ts). Output scrubbing stops exfiltration through
 * the transcript; env scrubbing stops the child from USING the keys at all.
 *
 * Design: ALLOWLIST (fail-closed). A child gets the OS-essential variables
 * it needs to run (PATH, HOME, TEMP, locale, Windows system vars) plus the
 * two quiet-output flags the terminal relies on — nothing else. Anything
 * not on the list is dropped, and as a second layer the allowlist itself is
 * filtered by a secret-shape scan on the NAME (if an allowed name ever
 * looks key-like it is dropped too).
 */
import type { SpawnOptions } from "node:child_process";

/**
 * OS/toolchain variables children legitimately need. Kept deliberately
 * small: process spawning, file resolution, temp dirs, locale, and the
 * Windows system variables cmd.exe/node require (SystemRoot, ComSpec…).
 */
const ENV_ALLOWLIST: readonly string[] = [
  // process + path resolution
  "PATH",
  "PATHEXT",
  // user/home resolution
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "ALLUSERSPROFILE",
  "PUBLIC",
  // temp dirs
  "TEMP",
  "TMP",
  // identity (needed by ssh/git on some setups; values are usernames)
  "USER",
  "USERNAME",
  // shell
  "SHELL",
  "ComSpec",
  // locale + terminal
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  // Linux desktop session (folder dialogs spawn zenity/kdialog — they need
  // the display; none of these carry secrets)
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_SESSION_TYPE",
  "XDG_RUNTIME_DIR",
  "XDG_CURRENT_DESKTOP",
  // Windows OS essentials (node.exe and cmd.exe misbehave without these)
  "SystemRoot",
  "windir",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  // corepack/pnpm shims resolve through these
  "COREPACK_ROOT",
  "PNPM_HOME",
  // rust/cargo toolchains (build commands are common project operations)
  "CARGO_HOME",
  "RUSTUP_HOME",
  "CARGO_TARGET_DIR",
  "RUST_BACKTRACE",
  "RUST_LOG",
];

/** Name-shape scan (defense in depth): if an allowed variable NAME looks
 * secret-bearing it is dropped anyway. Catches future allowlist mistakes. */
const SECRET_NAME_PATTERN =
  /(ACUTE_|_KEY$|^KEY_|API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_PAT$|^GITHUB_|OPENROUTER|ANTHROPIC|_AUTH|^AUTH)/i;

/**
 * Build the environment for a child process spawned by the sidecar
 * (terminal routes, run_command tool, PTY sessions — everything).
 * Returns a fresh object; never mutates or reads back.
 */
export function buildChildEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (typeof value === "string" && value !== "") {
      env[name] = value;
    }
  }
  // Quiet-output flags the terminal UX relies on (previously hardcoded at
  // every spawn site — centralized now).
  env.FORCE_COLOR = "0";
  env.CI = "1";
  // Caller extras last (e.g. terminal-session shell vars) — but NEVER let
  // a caller re-introduce a secret-shaped name.
  for (const [name, value] of Object.entries(extra)) {
    if (!SECRET_NAME_PATTERN.test(name)) env[name] = value;
  }
  // Second layer: scan the final names once more (the allowlist itself
  // could drift; this guarantees the invariant).
  for (const name of Object.keys(env)) {
    if (SECRET_NAME_PATTERN.test(name)) delete env[name];
  }
  return env;
}

/** Convenience: SpawnOptions["env"]-shaped accessor for call sites that
 *  build options objects inline. */
export function childEnvFor(_options: SpawnOptions): Record<string, string> {
  return buildChildEnv();
}

/**
 * Test/introspection helper — did a scrub actually happen? Exposed so the
 * terminal tests can assert that a deliberately-injected secret-bearing
 * variable is NOT present in the child environment.
 */
export function childEnvContains(env: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, name);
}
