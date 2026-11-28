# Managed by the CGS Desktop installer. Adds or removes the toolchain directories on the user PATH, i.e.
# HKCU\Environment\Path, without administrator rights. The installer runs this through nsExec; the exit code and output end
# up in the installer log. Design constraints (ADR 0049 §2):
#   - keep the value a REG_EXPAND_SZ; other entries are copied back byte for byte;
#   - never duplicate an entry that is already present (case-insensitive, environment variables expanded for comparison);
#   - a PATH longer than NSIS can handle is fine: the whole value is read and written here, not in the NSIS process;
#   - refuse rather than truncate (exit 2) if the result would exceed the registry's practical 32 KB limit;
#   - record exactly the entries this installer manages, so uninstall can remove them and nothing else.
# Modes: add (fresh install, user ticked the box), refresh (update: only re-record, never add), remove (uninstall).
param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'refresh', 'remove')][string]$Mode,
  [string]$Root,
  [string]$Entries,
  [string]$RecordKey
)
$ErrorActionPreference = 'Stop'
$MAX_PATH_LENGTH = 30000
$RECORD_VALUE = 'UserPathAdded'
# The installer may be silent, where nsExec's output goes nowhere. Keep a short file log beside the helper so a failed PATH
# change can be diagnosed after the fact; logging itself is best effort.
$LOG_FILE = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'cgs-desktop\cgs-path.log' } else { $null }

function Log([string]$Message) {
  $line = "{0:o} [{1}] {2}" -f (Get-Date), $Mode, $Message
  Write-Output "cgs-path: $Message"
  if ($null -ne $LOG_FILE) {
    try {
      $dir = Split-Path -Parent $LOG_FILE
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
      Add-Content -LiteralPath $LOG_FILE -Value $line
    } catch { }
  }
}

function Fail([string]$Message) {
  Log $Message
  exit 2
}

function Normalize([string]$Value) {
  $trimmed = $Value.Trim().Trim('"')
  $expanded = [Environment]::ExpandEnvironmentVariables($trimmed)
  return $expanded.TrimEnd('\').ToLowerInvariant()
}

function Get-EnvironmentKey([bool]$Writable) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $Writable)
  if ($null -eq $key) { Fail 'HKCU\Environment cannot be opened' }
  return $key
}

function Read-UserPath($Key) {
  return [string]($Key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))
}

function Broadcast-EnvironmentChange {
  try {
    if (-not ('CgsPathBroadcast' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CgsPathBroadcast {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
    }
    $result = [UIntPtr]::Zero
    [void][CgsPathBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  } catch {
    Log "WM_SETTINGCHANGE broadcast failed: $($_.Exception.Message)"
  }
}

function Write-UserPath($Key, [string]$Value) {
  if ($Value.Length -gt $MAX_PATH_LENGTH) { Fail "refusing to write a $($Value.Length)-character PATH" }
  $Key.SetValue('Path', $Value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
}

function Get-RecordedEntries {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RecordKey)
  if ($null -eq $key) { return $null }
  try {
    if (-not ($key.GetValueNames() -contains $RECORD_VALUE)) { return $null }
    return [string[]]($key.GetValue($RECORD_VALUE))
  } finally {
    $key.Close()
  }
}

function Set-RecordedEntries([string[]]$Values) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($RecordKey)
  if ($null -eq $key) { Fail "HKCU\$RecordKey cannot be created" }
  try {
    if ($Values.Count -eq 0) {
      $key.DeleteValue($RECORD_VALUE, $false)
    } else {
      $key.SetValue($RECORD_VALUE, $Values, [Microsoft.Win32.RegistryValueKind]::MultiString)
    }
  } finally {
    $key.Close()
  }
}

if ([string]::IsNullOrEmpty($Root) -or [string]::IsNullOrEmpty($Entries) -or [string]::IsNullOrEmpty($RecordKey)) {
  Fail 'Root, Entries and RecordKey are required'
}
$rootPath = $Root.TrimEnd('\')
$managed = @()
foreach ($entry in ($Entries -split ';')) {
  $clean = $entry.Trim().TrimStart('\')
  if ($clean -ne '') { $managed += ($rootPath + '\' + $clean) }
}
if ($managed.Count -eq 0) { Fail 'Entries names no directories' }

$envKey = Get-EnvironmentKey $true
try {
  $current = Read-UserPath $envKey
  $segments = @($current -split ';')
  $present = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($segment in $segments) {
    if ($segment.Trim() -ne '') { [void]$present.Add((Normalize $segment)) }
  }

  if ($Mode -eq 'remove') {
    $recorded = Get-RecordedEntries
    if ($null -eq $recorded -or $recorded.Count -eq 0) {
      Log 'no recorded PATH entries; leaving the user PATH unchanged'
      exit 0
    }
    $removeSet = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($value in $recorded) { if (-not [string]::IsNullOrWhiteSpace($value)) { [void]$removeSet.Add((Normalize $value)) } }
    $kept = @()
    $removed = 0
    foreach ($segment in $segments) {
      if ($segment.Trim() -eq '') { continue }
      if ($removeSet.Contains((Normalize $segment))) { $removed++ } else { $kept += $segment }
    }
    if ($removed -gt 0) {
      Write-UserPath $envKey ($kept -join ';')
      Broadcast-EnvironmentChange
    }
    Set-RecordedEntries @()
    Log "removed $removed recorded entries from the user PATH"
    exit 0
  }

  if ($Mode -eq 'refresh') {
    $recorded = Get-RecordedEntries
    if ($null -eq $recorded) {
      Log 'no previous PATH choice; leaving the user PATH unchanged'
      exit 0
    }
    # The user's earlier choice was to add them. Do not re-add anything they removed by hand, but keep the record accurate
    # so uninstall removes only what is actually ours and present.
    $stillThere = @()
    foreach ($value in $managed) { if ($present.Contains((Normalize $value))) { $stillThere += $value } }
    Set-RecordedEntries $stillThere
    Log "refresh recorded $($stillThere.Count) managed entries"
    exit 0
  }

  # add
  Log "start root=$rootPath path=$($current.Length) chars"
  $additions = @()
  foreach ($value in $managed) {
    if (-not $present.Contains((Normalize $value))) { $additions += $value }
  }
  $newPath = $current
  if ($additions.Count -gt 0) {
    if ($newPath -ne '' -and -not $newPath.EndsWith(';')) { $newPath += ';' }
    $newPath += ($additions -join ';')
    Write-UserPath $envKey $newPath
    Broadcast-EnvironmentChange
  }
  $final = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($segment in ($newPath -split ';')) {
    if ($segment.Trim() -ne '') { [void]$final.Add((Normalize $segment)) }
  }
  $recordedNow = @()
  foreach ($value in $managed) { if ($final.Contains((Normalize $value))) { $recordedNow += $value } }
  Set-RecordedEntries $recordedNow
  Log "added $($additions.Count) entries, recorded $($recordedNow.Count) (PATH $($current.Length) -> $($newPath.Length) chars)"
} finally {
  $envKey.Close()
}
