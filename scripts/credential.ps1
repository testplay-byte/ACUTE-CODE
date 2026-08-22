# Windows Credential Manager helper for ACUTE-CODE dev testing (no secrets inside).
# Usage:
#   powershell -File scripts/credential.ps1 Read  "ACUTE-CODE/provider/openrouter"
#   powershell -File scripts/credential.ps1 Write "ACUTE-CODE/provider/openrouter" "api-key" "<value>"
# Read prints the secret to stdout — capture it into a variable; do not let it into logs.
# Write target/user convention matches the Rust shell's keyring lookups (sidecar.rs).
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$User = "api-key",
  [string]$Value
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CredMan {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, EntryPoint="CredReadW")]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credPtr);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, EntryPoint="CredWriteW")]
  public static extern bool CredWrite(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
}
"@

if ($Action -eq "Read") {
  $ptr = [IntPtr]::Zero
  if (-not [CredMan]::CredRead($Target, 1, 0, [ref]$ptr)) {
    Write-Error "credential not found: $Target"; exit 1
  }
  $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredMan+CREDENTIAL])
  [CredMan]::CredFree($ptr)
  $bytes = New-Object byte[] $cred.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
  # cmdkey writes UTF-16LE blobs; hand-written entries may be UTF-8 — detect by null density.
  $nulls = ($bytes | Where-Object { $_ -eq 0 }).Count
  if ($nulls -gt $bytes.Length / 4) { [Text.Encoding]::Unicode.GetString($bytes) }
  else { [Text.Encoding]::UTF8.GetString($bytes) }
}
elseif ($Action -eq "Write") {
  if (-not $Value) { Write-Error "Value required for Write"; exit 1 }
  $blob = [Text.Encoding]::Unicode.GetBytes($Value)
  $hGlobal = [Runtime.InteropServices.Marshal]::AllocHGlobal($blob.Length)
  [Runtime.InteropServices.Marshal]::Copy($blob, 0, $hGlobal, $blob.Length)
  $cred = New-Object CredMan+CREDENTIAL
  $cred.Flags = 0; $cred.Type = 1; $cred.TargetName = $Target; $cred.UserName = $User
  $cred.CredentialBlobSize = $blob.Length; $cred.CredentialBlob = $hGlobal; $cred.Persist = 2
  $ok = [CredMan]::CredWrite([ref]$cred, 0)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($hGlobal)
  if ($ok) { Write-Output "stored: $Target" } else { Write-Error "CredWrite failed"; exit 1 }
}
else { Write-Error "Action must be Read or Write"; exit 1 }
