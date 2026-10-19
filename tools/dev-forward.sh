#!/usr/bin/env sh
# Point tcp:9222 at whatever pid the app's WebView currently has.
#
# The devtools socket is named after the WebView's process id, so it changes every time the WebView is
# recreated — a relaunch, a background kill, a crash — and the old forward then fails with a bare
# `bytesRead: 0` socket error that says nothing about why. Re-run this instead of reading the pid by hand.
set -e
ADB="${ADB:-$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe}"
SOCK=$("$ADB" shell cat /proc/net/unix 2>/dev/null | grep -o 'webview_devtools_remote_[0-9]*' | sort -u | tail -1)
if [ -z "$SOCK" ]; then
  echo "no webview_devtools_remote socket — is the app running and in the foreground?" >&2
  "$ADB" shell am start -W -n com.daayanshouse.app/.MainActivity >/dev/null 2>&1 || true
  sleep 3
  SOCK=$("$ADB" shell cat /proc/net/unix 2>/dev/null | grep -o 'webview_devtools_remote_[0-9]*' | sort -u | tail -1)
  [ -n "$SOCK" ] || exit 1
fi
"$ADB" forward --remove tcp:9222 >/dev/null 2>&1 || true
"$ADB" forward tcp:9222 "localabstract:$SOCK" >/dev/null
echo "$SOCK"
