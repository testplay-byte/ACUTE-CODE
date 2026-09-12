; ---------------------------------------------------------------------------
; ROUND-94 (R94-B) -- the NSIS PREINSTALL hook: kill what the installer's
; own "app is running" prompt cannot.
;
; THE OWNER'S REPORT (v0.91.0): the installer showed "ACUTE-CODE is running.
; Click OK to kill it", killed the main exe -- and then hit repeated
; "Error opening file for writing" on node.exe and friends. The node SIDECAR
; child had outlived its parent (the installer kills only the app's own
; binary by name -- see the template's CheckIfAppIsRunning /
; nsis_tauri_utils::KillProcess) and kept the install directory's files
; locked, so the File instructions failed one by one.
;
; Tauri 2 wires this file in via bundle.windows.nsis.installerHooks
; (tauri.conf.json). The NSIS_HOOK_PREINSTALL macro is inserted inside the
; install section AFTER SetOutPath $INSTDIR and BEFORE the first File
; instruction + the running-app prompt -- i.e. it is the last code that runs
; while the old files still hold the directory. The Rust shell got the
; matching fix this same round (src/sidecar.rs `sidecar_job`: the
; kill-on-close Job Object leash); this hook is the safety net for orphans
; left by OLDER builds (pre-Job-Object) and any future escape.
;
; What it kills, in order:
;   1. ACUTE-CODE.exe itself -- forced. The installer would kill it anyway
;      right after (CheckIfAppIsRunning runs AFTER this hook), but killing
;      it here means the prompt never appears and the app is guaranteed
;      gone before any file is replaced. FAILURE IS THE NORMAL CASE (the
;      app may simply not be running -- taskkill exits 128); the plugin's
;      result is popped off the stack and ignored.
;   2. node.exe processes whose EXECUTABLE lives under $INSTDIR -- NEVER
;      all node.exe globally (the owner runs other node applications).
;      PowerShell filters Get-Process node by the executable path prefix.
;
; NSIS quoting cheat-sheet for the PowerShell one-liner below (NSIS 3
; manual 4.1 "Strings"; nsExec's own docs recommend exactly this
; 'single-quoted command string with inner double quotes' shape):
;   * the whole command line is ONE single-quoted NSIS string ('...')
;   * NSIS expands $INSTDIR at runtime inside it
;   * $$ collapses to a literal $ -- that is how PowerShell's automatic
;     $_ survives the NSIS pass (written as $$_ in the source below)
;   * a bare backslash is NOT an escape character in NSIS, so \" stays
;     \", which the Windows command-line parser (CommandLineToArgvW
;     rules) reads as a literal quote INSIDE the quoted -Command
;     argument -- powershell.exe receives the script text with the
;     -like pattern properly quoted, spaces in $INSTDIR included
;   * the two pipes sit inside that quoted argument, so they reach
;     PowerShell as script text, never as shell pipes
; ---------------------------------------------------------------------------

!include "LogicLib.nsh" ; self-guarded; the installer template already pulls it via MUI2

!macro NSIS_HOOK_PREINSTALL
  ; 1. The app itself. taskkill /F /IM = force, by image name. The exit
  ;    code ("error" / 128 when nothing matched) is expected and ignored.
  nsExec::ExecToLog 'taskkill /F /IM ACUTE-CODE.exe'
  Pop $0

  ; 2. The sidecar node.exe under $INSTDIR -- scoped kill, never global.
  ;    The ${If} guard is belt-and-suspenders against a pathological empty
  ;    $INSTDIR: an empty prefix would turn the -like pattern into "*"
  ;    (match EVERY node.exe on the machine), and this hook must never
  ;    become that. ($INSTDIR is always set by the time the install
  ;    section runs -- .onInit computed it and SetOutPath just used it.)
  ${If} $INSTDIR != ""
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and ($$_.Path -like \"$INSTDIR*\") } | Stop-Process -Force"'
    Pop $0
  ${EndIf}
!macroend
