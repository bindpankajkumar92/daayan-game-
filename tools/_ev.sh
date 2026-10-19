#!/usr/bin/env sh
# Re-point the forward, then evaluate. The WebView's devtools socket is named after its pid, and this
# phone recreates the WebView often enough that a forward set up one command ago is usually already dead
# — every such failure looks like `fetch failed / bytesRead: 0`, which says nothing. Re-forwarding costs
# one adb round trip, so just do it every time rather than reading the error and retrying by hand.
set -e
cd "$(dirname "$0")/.."
export ADB="${ADB:-adb}"
sh tools/_fwd.sh >/dev/null
exec node tools/cdp.mjs "$@"
