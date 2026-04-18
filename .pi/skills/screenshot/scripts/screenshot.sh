#!/usr/bin/env bash
# screenshot.sh — Capture and validate a screenshot of a specific window or the full screen.
#
# Usage:
#   ./screenshot.sh <output_path> [window_class]
#
# Arguments:
#   output_path   — Where to save the PNG (required)
#   window_class  — (optional) WM_CLASS of the window to capture. If omitted, captures full screen.
#
# If xdotool finds a matching window, it is focused and captured.
# Otherwise, falls back to full-screen capture.
#
# The script outputs the file path on success and validates the image is non-trivial.

set -euo pipefail

OUTPUT="${1:?Usage: screenshot.sh <output_path> [window_class]}"
WINDOW_CLASS="${2:-}"
TMPRAW="/tmp/pi-screenshot-raw.png"

# Create output directory
mkdir -p "$(dirname "$OUTPUT")"

if [ -n "$WINDOW_CLASS" ]; then
    # Find window by class
    WINID=$(xdotool search --class "$WINDOW_CLASS" 2>/dev/null | head -1 || true)
    if [ -n "$WINID" ]; then
        # Focus and raise the window
        xdotool windowactivate "$WINID" 2>/dev/null || true
        xdotool windowraise "$WINID" 2>/dev/null || true
        sleep 0.3
        # Get window geometry
        eval "$(xdotool getwindowgeometry --shell "$WINID")"
        # Capture full screen then crop to window
        scrot -z "$TMPRAW"
        # Crop: X,Y WxH
        convert "$TMPRAW" -crop "${WIDTH}x${HEIGHT}+${X}+${Y}" "$OUTPUT"
        rm -f "$TMPRAW"
    else
        # Fallback to full screen
        scrot -z "$OUTPUT"
    fi
else
    # Full screen capture
    scrot -z "$OUTPUT"
fi

# Validate: file exists, is PNG, has reasonable size
if [ ! -f "$OUTPUT" ]; then
    echo "ERROR: Screenshot file not created: $OUTPUT" >&2
    exit 1
fi

FILESIZE=$(stat -f%z "$OUTPUT" 2>/dev/null || stat -c%s "$OUTPUT" 2>/dev/null || echo 0)
if [ "$FILESIZE" -lt 1000 ]; then
    echo "ERROR: Screenshot is suspiciously small (${FILESIZE} bytes)" >&2
    exit 1
fi

# Verify it's a valid PNG
if ! file "$OUTPUT" | grep -qi "PNG\|image"; then
    echo "ERROR: Output is not a valid image: $(file "$OUTPUT")" >&2
    exit 1
fi

echo "$OUTPUT"
