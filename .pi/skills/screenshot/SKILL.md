---
name: screenshot
description: Capture screenshots of windows or the full screen for visual validation. Use when you need to see what's on screen to verify UI changes, debug visual issues, check rendering, or validate that a fix worked. Triggers include requests to "take a screenshot", "show me what it looks like", "verify visually", or any time you need to inspect rendered output.
---

# Screenshot

Capture and inspect screenshots to validate visual output.

## Setup

Requires: `scrot`, `imagemagick` (`convert`), `xdotool`

```bash
sudo apt-get install -y scrot imagemagick xdotool
```

## Capture

### Full screen

```bash
./scripts/screenshot.sh /tmp/pi-screen.png
```

### Specific window by WM_CLASS

```bash
# Find the class first
xdotool search --name "Albedo" getwindowclassname 2>/dev/null || xprop WM_CLASS 2>/dev/null

# Then capture that window
./scripts/screenshot.sh /tmp/pi-screen.png "AlbedoAI-dev"
```

## Workflow

1. **Capture** the screenshot using the script above
2. **Read** the resulting PNG file — pi supports reading images natively:

```
read /tmp/pi-screen.png
```

3. **Analyze** the image visually to verify the fix or diagnose the issue
4. **Iterate** — make changes, rebuild, recapture, re-read

## Tips

- Use `sleep 2` before capturing to let animations/settling complete
- After `make dev`, wait for the app to fully boot before capturing
- For transient issues (like ghosting), capture immediately after the triggering action
- You can capture multiple times to compare before/after
