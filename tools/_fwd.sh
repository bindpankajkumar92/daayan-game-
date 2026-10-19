#!/usr/bin/env sh
# Point tcp:9222 at *Daayan's* WebView, by pid, and relaunch the app if it is gone.
#
# tools/dev-forward.sh takes `tail -1` of every webview_devtools_remote socket on the device, which is
# right only while Daayan is the one WebView app running. It is not: this phone brings other apps to the
# foreground on its own, and each one that embeds a WebView publishes its own socket — so `tail -1` can
# hand back a stranger's page, and the probe then reports `window.__daayan` as undefined as though the
# game were broken. The socket is named after the app's process id, so ask for that pid by package.
set -e
ADB="${ADB:-adb}"
PKG=com.daayanshouse.app
PID=$("$ADB" shell pidof "$PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}')
if [ -z "$PID" ]; then
  "$ADB" shell am start -W -n "$PKG/.MainActivity" >/dev/null 2>&1 || true
  sleep 5
  PID=$("$ADB" shell pidof "$PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}')
fi
[ -n "$PID" ] || { echo "$PKG is not running and would not start" >&2; exit 1; }
# The app can also be alive but backgrounded, which leaves the socket up and screencap useless.
TOP=$("$ADB" shell dumpsys activity activities 2>/dev/null | grep -o "topResumedActivity=[^}]*" | head -1)
case "$TOP" in
  *"$PKG"*) ;;
  *) "$ADB" shell am start -W -n "$PKG/.MainActivity" >/dev/null 2>&1 || true; sleep 3 ;;
esac
SOCK=$("$ADB" shell cat /proc/net/unix 2>/dev/null | grep -o "webview_devtools_remote_$PID\$" | head -1)
if [ -z "$SOCK" ]; then
  echo "no webview_devtools_remote_$PID — WebView not up yet for pid $PID" >&2
  exit 1
fi
"$ADB" forward --remove tcp:9222 >/dev/null 2>&1 || true
"$ADB" forward tcp:9222 "localabstract:$SOCK" >/dev/null
echo "$SOCK"
