# Bring the device and the app into a state where tools/cdp.mjs can talk to it, then optionally run a
# probe. Everything here is a step that failed at least once during a measurement session and cost a
# confusing error somewhere else:
#
#   - adb is not on PATH in this shell, only inside the SDK directory.
#   - The panel switches between 90/60/48/30 Hz on its own, so a probe that measures rAF deltas
#     measures the refresh rate. `-Pin90` asks Android to hold the peak mode for the duration.
#   - A backgrounded WebView stops servicing requestAnimationFrame, so any probe that awaits a frame
#     hangs forever rather than failing. The notification shade counts as backgrounded, and so does
#     the lockscreen — which cannot be dismissed from adb, so this script has to stop and say so.
#   - The devtools socket name carries the WebView's pid, which changes whenever the app is killed,
#     and a stale `adb forward` then fails as "fetch failed / other side closed" from cdp.mjs.
#   - A freshly installed APK can still run two-build-old code, because the WebView's HTTP cache
#     lives in app data and survives a reinstall. See tools/cdp-reload.mjs; the check is at the end.
#
#   powershell -File tools/dev-device.ps1                      # just connect
#   powershell -File tools/dev-device.ps1 -Probe $env:TEMP\gq-gputime.js
#   powershell -File tools/dev-device.ps1 -Pin90 -Probe ...    # hold the panel at 90 Hz
param(
  [string]$Probe = '',
  [int]$Port = 9223,
  [switch]$Pin90,
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'
# ...except around adb itself. Windows PowerShell turns a native command's stderr into an ErrorRecord
# when it is redirected, so `2>$null` on an adb call plus Stop aborts the script on adb's *warnings* —
# "Activity not started, intent has been delivered to currently running top-most instance" killed this
# script once. Continue for the adb section, and check what came back instead.
$ErrorActionPreference = 'Continue'
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
if (-not (Test-Path $adb)) { throw "adb not found at $adb" }
$pkg = 'com.daayanshouse.app'
$root = Split-Path -Parent $PSScriptRoot

& $adb shell input keyevent KEYCODE_WAKEUP | Out-Null
& $adb shell cmd statusbar collapse | Out-Null

# Fail here rather than 40 polls later. Behind the lockscreen the WebView is `visibilityState:
# 'hidden'`, rAF stops entirely (measured: 0 frames in 4.6 s) and asset loading stalls part-way, so
# the scene-settled gate below times out with a misleading "scene never settled". Neither
# `input swipe` nor `wm dismiss-keyguard` gets past a secured lockscreen on this device.
if ((& $adb shell dumpsys window | Select-String 'isKeyguardShowing=true')) {
  throw 'device is locked - unlock the phone. Behind the keyguard the WebView is hidden, rAF is stopped and nothing can be measured.'
}

if ($Restart) { & $adb shell am force-stop $pkg | Out-Null }

# Foreground it and wait for focus rather than sleeping a guessed amount: a probe that starts against
# an unfocused window is the hang described above.
& $adb shell am start -n "$pkg/.MainActivity" | Out-Null
$focused = $false
for ($i = 0; $i -lt 20; $i++) {
  $f = & $adb shell dumpsys window | Select-String "mCurrentFocus"
  if ($f -match [regex]::Escape($pkg)) { $focused = $true; break }
  Start-Sleep -Milliseconds 700
}
if (-not $focused) { throw "app never took focus; last was: $f" }

if ($Pin90) {
  # peak-refresh-rate/min-refresh-rate are the two settings the display manager honours for the whole
  # device. Restored by the caller, or by a reboot — see the note printed below.
  & $adb shell settings put system peak_refresh_rate 90.0 | Out-Null
  & $adb shell settings put system min_refresh_rate 90.0 | Out-Null
  "pinned panel to 90 Hz (undo: adb shell settings delete system min_refresh_rate)"
}

$sock = $null
for ($i = 0; $i -lt 20; $i++) {
  $line = & $adb shell cat /proc/net/unix | Select-String 'webview_devtools_remote'
  if ($line) { $sock = ($line[0].ToString() -split '@')[1].Trim(); break }
  Start-Sleep -Milliseconds 700
}
if (-not $sock) { throw 'no webview_devtools_remote socket; is the WebView up?' }

& $adb forward --remove "tcp:$Port" | Out-Null
& $adb forward "tcp:$Port" "localabstract:$sock" | Out-Null

# Wait for the scene handle, not just for the page: models arrive over several frames and a probe that
# samples during the load measures a house that is not there yet. `window.__daayan` appears well before
# the GLBs land, so the gate is an uploaded-texture count that has stopped moving — a probe launched at
# textures=4 measures an empty room.
$env:CDP_PORT = "$Port"
Push-Location $root
try {
  $ready = $false
  $prev = -1
  for ($i = 0; $i -lt 40; $i++) {
    $j = node tools/cdp.mjs "JSON.stringify({r: !!window.__daayan, t: window.__daayan ? window.__daayan.engine.renderer.info.memory.textures : 0})"
    if ($j -match '"r":true') {
      $t = [int]([regex]::Match($j, '"t":(\d+)').Groups[1].Value)
      if ($t -ge 10 -and $t -eq $prev) { $ready = $true; "$sock  ->  tcp:$Port   textures=$t"; break }
      $prev = $t
    }
    Start-Sleep -Milliseconds 900
  }
  if (-not $ready) { throw "scene never settled; last was: $j" }

  # The last thing that can still be wrong: the page is settled, but on cached code. Compare the
  # bundle hash the live page actually loaded against the one the installed index.html names. They
  # diverge silently after a reinstall, and every symptom points at the code rather than the cache.
  $want = (Select-String -Path "$root\android\app\src\main\assets\public\index.html" -Pattern 'assets/(index-[A-Za-z0-9_-]+\.js)').Matches[0].Groups[1].Value
  $live = (node tools/cdp.mjs "[...document.scripts].map(s=>s.src.split('/').pop()).filter(n=>n.startsWith('index-'))[0]").Trim()
  if ($live -ne $want) {
    "stale WebView cache: live=$live want=$want - clearing and reloading"
    node tools/cdp-reload.mjs --expect $want
    if ($LASTEXITCODE -ne 0) { throw "could not get the page onto $want" }
  } else {
    "bundle $live matches the installed APK"
  }

  if ($Probe) { node tools/cdp.mjs --file $Probe }
} finally {
  Pop-Location
}
