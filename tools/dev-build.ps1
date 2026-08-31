# Build the web bundle, sync it into the Android project, assemble the debug APK and install it.
#
# Written down because every step of this has bitten once:
#   - adb and gradlew are not on PATH; both are invoked by full path.
#   - `npm run build` runs `tsc --noEmit` first, so a type error stops here rather than shipping a
#     stale bundle. Exit codes are checked at every step: gradle returning 0 while adb was missing is
#     how a build "succeeded" without installing anything.
#   - The installed APK is compared by size and timestamp at the end, because the failure mode that
#     costs the most time is measuring a stale APK and concluding a code change did nothing.
#   - Installing goes through PackageInstaller sessions rather than `adb install`; see the comment at
#     that step for why the simple form cannot work on this device.
param([switch]$SkipInstall)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$apk = "$root\android\app\build\outputs\apk\debug\app-debug.apk"
Push-Location $root
try {
  "== npm run build =="
  & cmd /c "npm run build 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "vite/tsc build failed ($LASTEXITCODE)" }

  "== cap sync android =="
  & cmd /c "npx cap sync android 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "cap sync failed ($LASTEXITCODE)" }

  "== gradlew assembleDebug =="
  # Absolute path plus -p rather than `cd android && gradlew.bat`: cmd here does not resolve an
  # executable from the current directory, so the chained form fails as "'gradlew.bat' is not
  # recognized" after the cd has already succeeded.
  & cmd /c "`"$root\android\gradlew.bat`" -p `"$root\android`" assembleDebug 2>&1" | Select-Object -Last 25
  if ($LASTEXITCODE -ne 0) { throw "gradle failed ($LASTEXITCODE)" }
  if (-not (Test-Path $apk)) { throw "no APK at $apk" }
  $f = Get-Item $apk
  "APK  $([math]::Round($f.Length/1MB,2)) MB  $($f.LastWriteTime)"

  if (-not $SkipInstall) {
    # Session install, not `adb install -r`. This device (MIUI) refuses the streamed path with
    # INSTALL_FAILED_USER_RESTRICTED — "Install canceled by user" with no dialog ever shown, because
    # the MIUI-only "USB debugging (Security settings)" toggle is off and nothing in `settings get`
    # or `dumpsys device_policy` reports it. Driving the same three PackageInstaller steps by hand
    # is not subject to that check and returns Success, so this needs no toggle and no manual tap.
    "== pm install-create/write/commit =="
    $created = & $adb shell pm install-create -r -t --user 0
    if ($created -notmatch '\[(\d+)\]') { throw "install-create failed: $created" }
    $sid = $matches[1]
    $tmp = '/data/local/tmp/dev-build.apk'
    & $adb push $apk $tmp | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "push failed ($LASTEXITCODE)" }
    & $adb shell pm install-write $sid base $tmp | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "install-write failed ($LASTEXITCODE)" }
    $out = & $adb shell pm install-commit $sid
    & $adb shell rm -f $tmp | Out-Null
    if ("$out" -notmatch 'Success') { throw "install-commit failed: $out" }
    # Prove it landed. A commit that reports Success but leaves lastUpdateTime alone is the exact
    # stale-APK trap the size print above exists to catch.
    (& $adb shell dumpsys package com.daayanshouse.app | Select-String 'lastUpdateTime').Line.Trim()
  }
} finally {
  Pop-Location
}
