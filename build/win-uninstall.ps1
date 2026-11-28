# Managed by the CGS Desktop installer. Run by the uninstaller (build/installer.nsh) through nsExec; it removes what the user
# chose to remove, and the sign-in credentials always (ADR 0049 §3). The PATH entries are handled by win-path.ps1 before this
# runs. Installed beside the toolchain root, not inside the install directory, so it survives the removal of that directory.
#
# Exit codes: 0 everything asked for is gone, 1 something could not be removed (the lines tagged FAIL say what), 2 bad arguments.
#
# What is removed, and what never is:
#   always   the processes started from the install directory, the toolchain root, or the cgs package; the CGS credential file
#            and the desktop marker under the config root
#   tools    the toolchain root (the first-run downloads: Git, Python, clang, Rust, the language servers)
#   cli      the `cgs` command: bun's global package @cicori/cgs and its shim. bun itself stays, and so does anything else in
#            bun's directory, unless nothing but the CLI was ever there (the bundled bun.exe installed it, no bun of the
#            user's exists) - then the empty bun directory goes too
#   data     the config root (%USERPROFILE%\.cgs or PI_CONFIG_DIR under it: settings, sessions, history, every credential
#            the CLI stored) and the app's own data (%APPDATA% folders by the names passed in, the updater cache)
# Every target is checked to be where it should be before it is touched; a path outside the user's profile is refused.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$ToolchainRoot,
  [string]$BundledBun = '',
  [int]$RemoveTools = 0,
  [int]$RemoveCli = 0,
  [int]$RemoveData = 0,
  # Folder names under %APPDATA% that are the app's own data (Electron's userData and the package-name cache), `;` separated.
  [string]$AppDataNames = '',
  # Folder name under %LOCALAPPDATA% that electron-updater downloads into.
  [string]$UpdaterCache = ''
)
$ErrorActionPreference = 'Stop'
$LOG_FILE = Join-Path ([IO.Path]::GetTempPath()) 'cgs-desktop-uninstall.log'
$script:failed = 0

function Log([string]$Message) {
  Write-Output $Message
  try { Add-Content -LiteralPath $LOG_FILE -Value ("{0:o} {1}" -f (Get-Date), $Message) } catch { }
}

function Fail-Arguments([string]$Message) {
  Log "FAIL arguments: $Message"
  exit 2
}

function Full([string]$Path) { return [IO.Path]::GetFullPath($Path).TrimEnd('\') }

function Under([string]$Path, [string]$Parent) {
  $p = (Full $Path).ToLowerInvariant()
  $q = (Full $Parent).ToLowerInvariant()
  return $p.StartsWith($q + '\')
}

$userProfile = $env:USERPROFILE
if ([string]::IsNullOrEmpty($userProfile) -or -not (Test-Path -LiteralPath $userProfile)) { Fail-Arguments 'USERPROFILE is not set' }
$localAppData = $env:LOCALAPPDATA
$appData = $env:APPDATA
if ([string]::IsNullOrEmpty($localAppData) -or [string]::IsNullOrEmpty($appData)) { Fail-Arguments 'APPDATA / LOCALAPPDATA are not set' }

$installDir = Full $InstallDir
$toolchainRoot = Full $ToolchainRoot
if ((Split-Path -Leaf $toolchainRoot) -ne 'toolchain' -or -not (Under $toolchainRoot $localAppData)) {
  Fail-Arguments "the toolchain root must be <LOCALAPPDATA>\...\toolchain, got $toolchainRoot"
}

# The config root: PI_CONFIG_DIR is joined under the home directory, the way the desktop and the CLI both read it.
$configName = if ([string]::IsNullOrWhiteSpace($env:PI_CONFIG_DIR)) { '.cgs' } else { $env:PI_CONFIG_DIR.Trim() }
$configRoot = Full (Join-Path $userProfile $configName)
if (-not (Under $configRoot $userProfile)) { Fail-Arguments "the config root $configRoot is outside the user profile" }

$bunRoot = if ([string]::IsNullOrWhiteSpace($env:BUN_INSTALL)) { Join-Path $userProfile '.bun' } else { $env:BUN_INSTALL.Trim() }
$bunRoot = Full $bunRoot
if (-not (Under $bunRoot $userProfile) -and -not [string]::IsNullOrWhiteSpace($env:BUN_INSTALL)) {
  Log "note: BUN_INSTALL $bunRoot is outside the user profile; the CLI is removed with bun, its directory is left alone"
}

function Remove-Tree([string]$Path, [string]$Why) {
  if (-not (Test-Path -LiteralPath $Path)) { Log "skip   $Path (not there)"; return }
  $item = Get-Item -LiteralPath $Path -Force
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        # A link is removed as a link; its target is not ours.
        cmd.exe /d /c ('rmdir "' + $Path + '"') 2>&1 | Out-Null
      } elseif ($item.PSIsContainer) {
        # rd handles read-only files and long paths (the \\?\ form) the way Remove-Item does not.
        cmd.exe /d /c ('rd /s /q "\\?\' + $Path + '"') 2>&1 | Out-Null
      } else {
        $item.Attributes = [IO.FileAttributes]::Normal
        Remove-Item -LiteralPath $Path -Force
      }
    } catch { }
    if (-not (Test-Path -LiteralPath $Path)) { Log "removed $Path ($Why)"; return }
    Start-Sleep -Milliseconds 700
  }
  $script:failed++
  Log "FAIL   could not remove $Path ($Why): still there after 5 attempts (a program may be using it)"
}

function Get-Ancestors {
  $ids = @{}
  $id = $PID
  while ($id -and -not $ids.ContainsKey($id)) {
    $ids[$id] = $true
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if (-not $p) { break }
    $id = $p.ParentProcessId
  }
  return $ids
}

# 1. Stop what holds files: the app, its sidecar and agents (they run from the install directory or the toolchain), and a bun
#    running the cgs package. Never a process of the user's own that merely lives in bun's directory.
function Stop-Ours {
  $keep = Get-Ancestors
  $prefixes = @(($installDir + '\').ToLowerInvariant(), ($toolchainRoot + '\').ToLowerInvariant())
  $cgsShim = (Join-Path $bunRoot 'bin\cgs.exe').ToLowerInvariant()
  $hits = @()
  foreach ($proc in (Get-CimInstance Win32_Process)) {
    if ($keep.ContainsKey([int]$proc.ProcessId)) { continue }
    $exe = if ($proc.ExecutablePath) { $proc.ExecutablePath.ToLowerInvariant() } else { '' }
    $command = if ($proc.CommandLine) { $proc.CommandLine } else { '' }
    $ours = $false
    foreach ($prefix in $prefixes) { if ($exe.StartsWith($prefix)) { $ours = $true } }
    if ($exe -eq $cgsShim) { $ours = $true }
    if ($command -match '[\\/]@cicori[\\/]cgs[\\/]') { $ours = $true }
    if ($ours) { $hits += $proc }
  }
  foreach ($proc in $hits) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      Log "stopped process $($proc.ProcessId) $($proc.Name)"
    } catch {
      Log "note: process $($proc.ProcessId) $($proc.Name) was already gone or could not be stopped"
    }
  }
  foreach ($proc in $hits) { try { Wait-Process -Id $proc.ProcessId -Timeout 8 -ErrorAction SilentlyContinue } catch { } }
}

# 2. Credentials: always. The file is the CGS sign-in (cgsconnect/local-channel.md); the marker only tells `cgs update` where
#    the desktop lives, which is gone.
function Remove-Credentials {
  foreach ($file in @((Join-Path $configRoot 'agent\cgs\credentials.json'), (Join-Path $configRoot 'desktop.json'))) {
    if (Test-Path -LiteralPath $file) { Remove-Tree $file 'sign-in credentials and desktop marker' } else { Log "skip   $file (not there)" }
  }
}

# 3. The CLI: bun's own removal first (it keeps its manifest in step), then whatever it left.
function Find-Bun {
  foreach ($candidate in @((Join-Path $bunRoot 'bin\bun.exe'), $BundledBun)) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Remove-Cli {
  $bun = Find-Bun
  if ($bun) {
    $out = [IO.Path]::GetTempFileName()
    $err = [IO.Path]::GetTempFileName()
    try {
      $env:BUN_INSTALL = $bunRoot
      $process = Start-Process -FilePath $bun -ArgumentList @('remove', '-g', '@cicori/cgs') -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
      $null = $process.Handle  # without the handle cached, ExitCode is empty after the process ends
      if (-not $process.WaitForExit(120000)) {
        try { $process.Kill() } catch { }
        Log 'note: bun remove -g @cicori/cgs timed out; removing the files directly'
      } else {
        Log "bun remove -g @cicori/cgs exit $($process.ExitCode)"
      }
    } catch {
      Log "note: bun could not be run ($($_.Exception.Message)); removing the files directly"
    } finally {
      Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue
    }
  } else {
    Log 'note: no bun found; removing the CLI files directly'
  }
  foreach ($name in @('cgs.exe', 'cgs.bunx', 'cgs.cmd', 'cgs.ps1', 'cgs')) {
    $shim = Join-Path $bunRoot ('bin\' + $name)
    if (Test-Path -LiteralPath $shim) { Remove-Tree $shim 'CLI shim' }
  }
  $package = Join-Path $bunRoot 'install\global\node_modules\@cicori\cgs'
  if (Test-Path -LiteralPath $package) { Remove-Tree $package 'CLI package' }
  $scope = Join-Path $bunRoot 'install\global\node_modules\@cicori'
  if ((Test-Path -LiteralPath $scope) -and -not (Get-ChildItem -LiteralPath $scope -Force | Select-Object -First 1)) { Remove-Tree $scope 'empty @cicori scope' }

  # bun's directory goes only when it is plainly ours: no bun.exe of the user's, and no other global package left.
  if ((Test-Path -LiteralPath $bunRoot) -and (Under $bunRoot $userProfile)) {
    $hasBun = Test-Path -LiteralPath (Join-Path $bunRoot 'bin\bun.exe')
    $otherPackages = $false
    $manifest = Join-Path $bunRoot 'install\global\package.json'
    if (Test-Path -LiteralPath $manifest) {
      try {
        $json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        if ($json.dependencies -and @($json.dependencies.PSObject.Properties).Count -gt 0) { $otherPackages = $true }
      } catch { $otherPackages = $true }
    }
    if (-not $hasBun -and -not $otherPackages) {
      Remove-Tree $bunRoot 'bun directory: only the CLI was ever installed there'
    } else {
      Log "kept   $bunRoot (a bun or other global packages of yours are there)"
    }
  }
}

Log "uninstall helper: tools=$RemoveTools cli=$RemoveCli data=$RemoveData installdir=$installDir"
Stop-Ours
Remove-Credentials
if ($RemoveTools -eq 1) { Remove-Tree $toolchainRoot 'first-run toolchain' } else { Log "kept   $toolchainRoot" }
if ($RemoveCli -eq 1) { Remove-Cli } else { Log 'kept   the cgs command line tool' }
if ($RemoveData -eq 1) {
  $seen = @{}
  foreach ($name in ($AppDataNames -split ';')) {
    $clean = $name.Trim()
    if ($clean -eq '' -or $clean -match '[\\/:*?"<>|]' -or $clean -eq '.' -or $clean -eq '..') { continue }
    if ($seen.ContainsKey($clean.ToLowerInvariant())) { continue }
    $seen[$clean.ToLowerInvariant()] = $true
    Remove-Tree (Join-Path $appData $clean) 'app data'
  }
  if ($UpdaterCache.Trim() -ne '' -and $UpdaterCache -notmatch '[\\/:*?"<>|]' -and $UpdaterCache -ne '.' -and $UpdaterCache -ne '..') {
    Remove-Tree (Join-Path $localAppData $UpdaterCache.Trim()) 'updater cache'
  }
  Remove-Tree $configRoot 'settings, sessions and history'
} else {
  Log "kept   $configRoot (settings, sessions and history)"
}

if ($script:failed -gt 0) { Log "done with $($script:failed) item(s) that could not be removed"; exit 1 }
Log 'done'
exit 0
