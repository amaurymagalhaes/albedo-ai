# Phase 5: Go Daemon — Implementation Plan

## Overview

This document is the engineering implementation plan for **Phase 5: Daemon** of the Albedo AI project. It covers every file in the `daemon/` module, how each subsystem works, how they wire together, and the criteria for calling the phase complete.

---

## Objective

Deliver a production-ready Go binary (`albedo-daemon`) that:

1. **Streams system awareness** — active window title and PID, clipboard content, CPU/RAM/Disk/Network metrics, and top processes — to the Bun orchestrator over a Unix socket gRPC connection.
2. **Executes AI-driven tools** safely — file reads/writes, shell commands, app control, keyboard/mouse automation, browser control, and system notifications — through a typed tool registry exposed over gRPC.
3. **Enforces a security sandbox** — path allowlists for filesystem access, a command blocklist for catastrophic operations, and a dangerous-command set that requires explicit confirmation from the user before execution.
4. **Exposes all capabilities** through the `albedo.daemon.Daemon` gRPC service defined in `proto/daemon.proto`, listening on the Unix socket `/tmp/albedo-daemon.sock`.

At the end of this phase the Bun orchestrator can call `StreamAwareness` to get a 5-second tick of system context injected into the LLM context window, and can call `ExecuteTool` to let the AI act on the user's system.

---

## Prerequisites

### Phase 0 Must Be Complete

- `proto/daemon.proto` committed and valid.
- Go protobuf stubs generated and committed to `daemon/proto/`:
  ```
  daemon/proto/daemon.pb.go
  daemon/proto/daemon_grpc.pb.go
  ```
  Generated via:
  ```bash
  protoc \
    --go_out=daemon/proto --go_opt=paths=source_relative \
    --go-grpc_out=daemon/proto --go-grpc_opt=paths=source_relative \
    proto/daemon.proto
  ```
- `daemon/go.mod` exists with module path `albedo-ai/daemon`.

### System Dependencies

| Dependency | Platform | Purpose | Install |
|---|---|---|---|
| `xdotool` | Linux (X11) | Active window title + PID | `apt install xdotool` |
| `xclip` or `xsel` | Linux (X11) | Clipboard read | `apt install xclip` |
| `xdg-open` | Linux | Open applications | Usually pre-installed |
| `libx11-dev`, `libxtst-dev`, `libxinerama-dev` | Linux | CGO deps for robotgo | `apt install libx11-dev libxtst-dev libxinerama-dev libxrandr-dev libxcursor-dev` |
| `libpng-dev` | Linux | CGO deps for screenshot | `apt install libpng-dev` |
| `protoc` ≥ 3.21 | All | Proto compilation | `apt install protobuf-compiler` |
| `protoc-gen-go`, `protoc-gen-go-grpc` | All | Go gRPC stubs | `go install google.golang.org/protobuf/cmd/protoc-gen-go@latest && go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest` |
| Go ≥ 1.22 | All | Build toolchain | https://go.dev/dl/ |

### macOS Additional Dependencies

```bash
brew install xdotool   # Not applicable; use Accessibility API instead
# No xdotool on macOS — window tracking uses AppleScript / CGWindowListCopyWindowInfo
```

### Windows Additional Dependencies

- PowerShell 5+ (pre-installed on Windows 10+) for window tracking fallback.
- No `xdotool`; window tracking uses `GetForegroundWindow` via syscall.

---

## Step-by-Step Tasks

### Task 1 — Initialise the Go Module

**File:** `daemon/go.mod`

```bash
cd daemon
go mod init albedo-ai/daemon
```

Verify the module declaration is `module albedo-ai/daemon` and set `go 1.22`.

---

### Task 2 — Add All Go Dependencies

**File:** `daemon/go.mod`, `daemon/go.sum`

```bash
cd daemon
go get google.golang.org/grpc@v1.64.0
go get google.golang.org/protobuf@v1.34.1
go get github.com/go-vgo/robotgo@v0.110.3
go get github.com/kbinani/screenshot@v0.0.0-20230812210009-b87d31814237
go get github.com/shirou/gopsutil/v3@v3.24.4
go get github.com/go-rod/rod@v0.116.0
go get golang.design/x/clipboard@v0.7.0
go get github.com/gen2brain/beeep@v0.0.0-20240516210008-9c006672e7f4
go mod tidy
```

Commit `go.mod` and `go.sum`.

---

### Task 3 — Create the Module Directory Skeleton

```bash
mkdir -p daemon/awareness
mkdir -p daemon/actions
mkdir -p daemon/security
mkdir -p daemon/cmd/albedo-daemon
```

All source files below are created within these directories.

---

### Task 4 — Implement `daemon/awareness/window.go`

See the [Window Awareness module](#windowgo--active-window-tracking) section for the full implementation spec.

---

### Task 5 — Implement `daemon/awareness/screen.go`

See the [Screen Capture module](#screnego--screen-capture) section.

---

### Task 6 — Implement `daemon/awareness/clipboard.go`

See the [Clipboard module](#clipboardgo--clipboard-monitoring) section.

---

### Task 7 — Implement `daemon/awareness/metrics.go`

See the [Metrics module](#metricsgo--system-metrics) section.

---

### Task 8 — Implement `daemon/awareness/collector.go`

See the [Collector module](#collectorgo--awareness-aggregator) section.

---

### Task 9 — Implement `daemon/actions/registry.go`

See the [Tool Registry](#registrygo--tool-registry) section.

---

### Task 10 — Implement `daemon/actions/filesystem.go`

Implements `read_file`, `write_file`, `list_dir`, `find_files` handlers.

---

### Task 11 — Implement `daemon/actions/shell.go`

Implements `run_command` handler with timeout, combined stdout/stderr capture, and context cancellation.

---

### Task 12 — Implement `daemon/actions/automation.go`

Implements `type_text`, `key_press`, `mouse_move`, `mouse_click` handlers using robotgo.

---

### Task 13 — Implement `daemon/actions/browser.go`

Implements `browser_navigate`, `browser_click`, `browser_get_text` using go-rod.

---

### Task 14 — Implement `daemon/actions/appctl.go`

Implements `open_app`, `close_app`, `focus_window` handlers.

---

### Task 15 — Implement `daemon/actions/notifications.go`

Implements `notify` handler using beeep.

---

### Task 16 — Implement `daemon/security/sandbox.go`

See the [Security Sandbox](#sandboxgo--security-sandbox) section.

---

### Task 17 — Implement `daemon/cmd/albedo-daemon/main.go`

See the [gRPC Server](#cmdalbedo-daemonmaingo--grpc-server) section.

---

### Task 18 — Write Unit Tests

Create test files:
- `daemon/awareness/window_test.go`
- `daemon/awareness/metrics_test.go`
- `daemon/awareness/collector_test.go`
- `daemon/actions/registry_test.go`
- `daemon/actions/filesystem_test.go`
- `daemon/security/sandbox_test.go`

---

### Task 19 — Build and Verify

```bash
cd daemon
go build ./...
go test ./...
go build -o bin/albedo-daemon ./cmd/albedo-daemon
```

---

### Task 20 — Integration Smoke Test

```bash
./bin/albedo-daemon &
sleep 1
# Use grpcurl or a small Go test client to call GetAwareness
grpcurl -plaintext -unix /tmp/albedo-daemon.sock albedo.daemon.Daemon/GetAwareness
```

---

## Module Breakdown

### `awareness/window.go` — Active Window Tracking

**Responsibility:** Return the title, application name, executable path, and PID of the currently focused window.

**Implementation per platform:**

| Platform | Mechanism | External tool |
|---|---|---|
| Linux (X11) | `xdotool getactivewindow` → window ID, then `getwindowname`, `getwindowpid` | `xdotool` |
| Linux (Wayland) | `ydotool` or `swaymsg -t get_tree` JSON parse | `ydotool` / `swaymsg` |
| macOS | `osascript` AppleScript: `tell application "System Events" to get name of first process whose frontmost is true` | None (built-in) |
| Windows | `GetForegroundWindow` + `GetWindowText` + `GetWindowThreadProcessId` via `syscall` + `QueryFullProcessImageName` | None (syscall) |

**Key exported type:**

```go
// daemon/awareness/window.go
package awareness

type ActiveWindow struct {
    Title   string
    AppName string
    AppPath string
    PID     uint32
}

func GetActiveWindow() (*ActiveWindow, error)
```

**Linux detail:** Run two `xdotool` calls — `getactivewindow getwindowname` for the title, `getactivewindow getwindowpid` for the PID, then resolve the executable path from `/proc/<pid>/exe`.

**macOS detail:** Use `osascript -e 'tell application "System Events" to get {name, unix id} of first process whose frontmost is true'`. Parse the returned comma-separated string. Resolve the app path using `mdfind "kMDItemCFBundleIdentifier == '<app>'"` or read `/proc`-equivalent from `proc_pidpath` via CGO.

**Windows detail:** Use `golang.org/x/sys/windows` to call `GetForegroundWindow`, `GetWindowTextW`, then `QueryFullProcessImageNameW`. No external tool required.

**Error handling:** Return a non-nil `*ActiveWindow` with empty string fields if the call fails (e.g., no X server) rather than propagating the error to the gRPC layer, so awareness snapshots are never blocked by a single failing subsystem.

---

### `awareness/screen.go` — Screen Capture

**Responsibility:** Capture one or more display outputs as JPEG or PNG bytes. Optionally crop to the active window bounds.

**Key functions:**

```go
// daemon/awareness/screen.go
package awareness

// CaptureScreenJPEG captures display 0 and JPEG-encodes it at the given quality (1–100).
func CaptureScreenJPEG(quality int) (data []byte, width, height int, err error)

// CaptureScreenPNG captures display 0 as PNG.
func CaptureScreenPNG() (data []byte, width, height int, err error)

// CaptureActiveWindowJPEG captures only the bounding rectangle of the active window.
func CaptureActiveWindowJPEG(quality int) (data []byte, width, height int, err error)
```

**Implementation:** Uses `github.com/kbinani/screenshot`. `screenshot.NumActiveDisplays()` returns the monitor count; `screenshot.GetDisplayBounds(0)` returns the primary display rectangle; `screenshot.CaptureRect(bounds)` returns an `*image.RGBA`.

For `CaptureActiveWindowJPEG`, first call `GetActiveWindow()`, then use `xdotool getwindowgeometry --shell <wid>` (Linux) to get X, Y, W, H and pass that rectangle to `screenshot.CaptureRect`.

**JPEG encoding:** Use `image/jpeg` from stdlib with `jpeg.Options{Quality: quality}` writing into a `bytes.Buffer`.

**PNG encoding:** Use `image/png` from stdlib.

**Build constraints:** `kbinani/screenshot` uses CGO on Linux (requires libx11). Add a `//go:build !noscrn` build tag to allow skipping screen capture in headless CI environments.

---

### `awareness/clipboard.go` — Clipboard Monitoring

**Responsibility:** Return the current plain-text clipboard content. Detect changes between polls to avoid sending duplicate data.

**Key exported function:**

```go
// daemon/awareness/clipboard.go
package awareness

type ClipboardMonitor struct {
    last string
    mu   sync.Mutex
}

func NewClipboardMonitor() *ClipboardMonitor
func (c *ClipboardMonitor) Read() (string, bool, error) // (content, changed, err)
```

**Implementation:** Uses `golang.design/x/clipboard` which wraps platform-specific clipboard APIs:
- Linux: Xlib selection (requires X11). Falls back gracefully on Wayland.
- macOS: `NSPasteboard`.
- Windows: `OpenClipboard` / `GetClipboardData`.

`Read()` calls `clipboard.Read(clipboard.FmtText)`, compares against `c.last`, and returns `(content, changed, nil)`. If the clipboard contains non-text data (image, files), return `("", false, nil)` rather than an error.

**Polling note:** The collector drives clipboard polling on its own ticker (default 2 seconds), not a goroutine inside this module. This module is stateless beyond the last-seen value cache.

**Privacy note:** Clipboard content is opt-in via `AwarenessConfig.include_clipboard`. When false, the collector passes an empty string in the snapshot.

---

### `awareness/metrics.go` — System Metrics

**Responsibility:** Collect CPU, RAM, disk, and network I/O stats plus the top 5 processes by CPU usage.

**Key exported function:**

```go
// daemon/awareness/metrics.go
package awareness

import "github.com/shirou/gopsutil/v3/..."

type SystemMetrics struct {
    CPUPercent    float32
    RAMPercent    float32
    DiskPercent   float32
    NetMbpsIn     float32
    NetMbpsOut    float32
    TopProcesses  []ProcessInfo
}

type ProcessInfo struct {
    Name       string
    PID        uint32
    CPUPercent float32
    RAMMB      float32
}

func CollectMetrics() (*SystemMetrics, error)
```

**gopsutil usage:**

```go
// CPU — one-second blocking sample
pcts, _ := cpu.Percent(time.Second, false)
cpuPct := float32(pcts[0])

// RAM
vm, _ := mem.VirtualMemory()
ramPct := float32(vm.UsedPercent)

// Disk (root partition)
du, _ := disk.Usage("/")
diskPct := float32(du.UsedPercent)

// Network — delta between two samples 1s apart
n1, _ := net.IOCounters(false)
time.Sleep(time.Second)
n2, _ := net.IOCounters(false)
bytesIn  := float32(n2[0].BytesRecv - n1[0].BytesRecv) / 1e6 * 8  // Mbps
bytesOut := float32(n2[0].BytesSent - n1[0].BytesSent) / 1e6 * 8

// Top processes
procs, _ := process.Processes()
// sort by CPUPercent descending, take top 5
```

**Performance note:** The `cpu.Percent` call with a 1-second interval means `CollectMetrics()` blocks for approximately 1 second. The collector runs metrics collection in its own goroutine and caches the result. It does not block the main awareness snapshot assembly.

---

### `awareness/collector.go` — Awareness Aggregator

**Responsibility:** Orchestrate all awareness sub-modules, maintain a cached `AwarenessSnapshot`, and expose `Snapshot()` and `CaptureScreen()` methods consumed by the gRPC server.

**Struct definition:**

```go
// daemon/awareness/collector.go
package awareness

import (
    "sync"
    "time"
    pb "albedo-ai/daemon/proto"
)

type Collector struct {
    mu        sync.RWMutex
    snapshot  *pb.AwarenessSnapshot
    clipboard *ClipboardMonitor
    metrics   *SystemMetrics   // cached, updated in background
    stopCh    chan struct{}
}

func NewCollector() *Collector
func (c *Collector) Start()          // launches background goroutines
func (c *Collector) Stop()
func (c *Collector) Snapshot() (*pb.AwarenessSnapshot, error)
func (c *Collector) CaptureScreen(req *pb.ScreenCaptureRequest) (*pb.ScreenCaptureResponse, error)
```

**Background polling goroutines launched by `Start()`:**

| Goroutine | Interval | Updates |
|---|---|---|
| `metricsLoop` | 3 seconds | `c.metrics` cache |
| `clipboardLoop` | 2 seconds | `c.snapshot.ClipboardContent` |
| `windowLoop` | 1 second | `c.snapshot.ActiveWindow` |

**`Snapshot()` assembly:**

```go
func (c *Collector) Snapshot() (*pb.AwarenessSnapshot, error) {
    c.mu.RLock()
    defer c.mu.RUnlock()

    win, _ := GetActiveWindow()

    m := c.metrics  // read from cache; never blocks
    clip, _, _ := c.clipboard.Read()

    return &pb.AwarenessSnapshot{
        ActiveWindow: &pb.ActiveWindow{
            Title:   win.Title,
            AppName: win.AppName,
            AppPath: win.AppPath,
            Pid:     win.PID,
        },
        Metrics: &pb.SystemMetrics{
            CpuPercent:    m.CPUPercent,
            RamPercent:    m.RAMPercent,
            DiskPercent:   m.DiskPercent,
            NetworkMbpsIn:  m.NetMbpsIn,
            NetworkMbpsOut: m.NetMbpsOut,
            TopProcesses:  toProtoProcesses(m.TopProcesses),
        },
        ClipboardContent: clip,
        TimestampMs:      uint64(time.Now().UnixMilli()),
    }, nil
}
```

**`CaptureScreen()` implementation:**

```go
func (c *Collector) CaptureScreen(req *pb.ScreenCaptureRequest) (*pb.ScreenCaptureResponse, error) {
    var data []byte
    var w, h int
    var err error

    switch req.Region {
    case "active_window":
        data, w, h, err = CaptureActiveWindowJPEG(int(req.Quality))
    default: // "full"
        if req.Format == "png" {
            data, w, h, err = CaptureScreenPNG()
        } else {
            q := int(req.Quality)
            if q == 0 { q = 75 }
            data, w, h, err = CaptureScreenJPEG(q)
        }
    }
    if err != nil {
        return nil, err
    }
    return &pb.ScreenCaptureResponse{
        ImageData: data,
        Width:     uint32(w),
        Height:    uint32(h),
    }, nil
}
```

**Thread safety:** All mutations to the cached snapshot happen under `c.mu.Lock()`. Reads in `Snapshot()` hold `c.mu.RLock()`. Screen capture is stateless and acquires no lock.

---

### `actions/registry.go` — Tool Registry

**Responsibility:** Maintain the map of registered tools, dispatch `ExecuteTool` requests, and serialize the tool list for `ListTools`.

**Core types:**

```go
// daemon/actions/registry.go
package actions

import (
    "encoding/json"
    "fmt"
    pb "albedo-ai/daemon/proto"
)

// ToolHandler is the function signature for every tool implementation.
// args is the raw JSON from ToolRequest.arguments_json.
// Returns a string result (may be base64, JSON, or plain text) or an error.
type ToolHandler func(args json.RawMessage) (string, error)

// ToolDef describes a single tool: its metadata exposed to the LLM and its handler.
type ToolDef struct {
    Name        string       // Stable identifier used in ToolRequest.tool_name
    Description string       // Human-readable description sent to the LLM
    Schema      string       // JSON Schema string for the parameters object
    Dangerous   bool         // If true, sandbox may require confirmation
    Handler     ToolHandler
}

// Registry is the central tool store. It is safe for concurrent reads
// after initial registration (which happens at startup before any requests).
type Registry struct {
    tools map[string]*ToolDef
    mu    sync.RWMutex
}

func NewRegistry() *Registry

// Register adds a tool definition. Panics on duplicate name.
func (r *Registry) Register(tool *ToolDef)

// Execute dispatches a ToolRequest to the matching handler.
func (r *Registry) Execute(req *pb.ToolRequest) (*pb.ToolResponse, error)

// List returns all registered tools as a gRPC ToolList.
func (r *Registry) List() *pb.ToolList
```

**Handler pattern:** Every handler receives a `json.RawMessage` containing the arguments object and returns `(string, error)`. The string is placed verbatim in `ToolResponse.result`. For binary results (e.g., screenshots), return a tagged base64 string like `[SCREENSHOT:1920x1080:<base64>]`. The Bun orchestrator inspects the prefix to decide whether to pass it to the vision API.

**Error handling in Execute:**

```go
func (r *Registry) Execute(req *pb.ToolRequest) (*pb.ToolResponse, error) {
    r.mu.RLock()
    tool, ok := r.tools[req.ToolName]
    r.mu.RUnlock()

    if !ok {
        return &pb.ToolResponse{
            Success: false,
            Error:   fmt.Sprintf("unknown tool: %q", req.ToolName),
        }, nil
    }

    result, err := tool.Handler(json.RawMessage(req.ArgumentsJson))
    if err != nil {
        return &pb.ToolResponse{Success: false, Error: err.Error()}, nil
    }
    return &pb.ToolResponse{Success: true, Result: result}, nil
}
```

The outer gRPC method never returns a gRPC-level error for tool failures — it always returns `Success: false` with the error message in the `Error` field. This allows the orchestrator to relay the error text back to the LLM for self-correction.

---

### Default Tools (registered in `actions/registry.go` via `RegisterDefaults`)

#### `read_file`

```json
{
  "name": "read_file",
  "description": "Read the contents of a file at the given path. Returns the file text.",
  "dangerous": false,
  "schema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Absolute or home-relative file path" },
      "max_bytes": { "type": "integer", "default": 102400, "description": "Max bytes to read (default 100 KB)" }
    },
    "required": ["path"]
  }
}
```

Implementation: `os.ReadFile(p.Path)` capped at `max_bytes`. Returns the text content. The sandbox validates that `path` is under an allowed read path before the handler runs.

---

#### `run_command`

```json
{
  "name": "run_command",
  "description": "Execute a shell command and return combined stdout+stderr. Sandboxed: blocked and dangerous commands are checked before execution.",
  "dangerous": true,
  "schema": {
    "type": "object",
    "properties": {
      "command": { "type": "string", "description": "Shell command string" },
      "timeout_seconds": { "type": "integer", "default": 30 }
    },
    "required": ["command"]
  }
}
```

Implementation: `exec.CommandContext(ctx, "sh", "-c", p.Command).CombinedOutput()` with a context derived from `context.WithTimeout`. On Windows, use `cmd /c` instead of `sh -c`.

---

#### `open_app`

```json
{
  "name": "open_app",
  "description": "Open an application or file. On Linux uses xdg-open, on macOS uses open -a, on Windows uses start.",
  "dangerous": false,
  "schema": {
    "type": "object",
    "properties": {
      "app": { "type": "string", "description": "Application name, .desktop file, or file path" }
    },
    "required": ["app"]
  }
}
```

Implementation: Platform switch on `runtime.GOOS`. Call `.Start()` (not `.Run()`), so the daemon does not block waiting for the application to exit.

---

#### `type_text`

```json
{
  "name": "type_text",
  "description": "Type a string of text at the current cursor position using OS keyboard automation.",
  "dangerous": false,
  "schema": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "Text to type" },
      "delay_ms": { "type": "integer", "default": 0, "description": "Delay between keystrokes in milliseconds" }
    },
    "required": ["text"]
  }
}
```

Implementation: `robotgo.TypeStr(p.Text)` with optional `robotgo.MilliSleep(p.DelayMs)` per character for slow-typing simulation.

---

#### `screenshot`

```json
{
  "name": "screenshot",
  "description": "Capture the current screen and return it as a base64-encoded JPEG tagged string.",
  "dangerous": false,
  "schema": {
    "type": "object",
    "properties": {
      "quality": { "type": "integer", "default": 60, "minimum": 1, "maximum": 100 },
      "region": { "type": "string", "enum": ["full", "active_window"], "default": "full" }
    }
  }
}
```

Implementation: Calls `CaptureScreenJPEG` or `CaptureActiveWindowJPEG` from the awareness package. Returns `[SCREENSHOT:<w>x<h>:<base64>]`.

---

### `actions/filesystem.go` — File Operations

Beyond `read_file` registered as a default tool, this file implements additional file system handlers that are registered via `RegisterFilesystemTools(r *Registry)`:

| Tool | Description | Dangerous |
|---|---|---|
| `write_file` | Write content to a file (overwrites) | true |
| `append_file` | Append content to a file | true |
| `list_dir` | List directory contents as JSON array | false |
| `find_files` | Recursive glob search | false |
| `delete_file` | Delete a file | true |

All write operations are validated by the sandbox against `AllowedWritePaths` before the handler is invoked.

---

### `actions/shell.go` — Shell Command Execution

Implements only the `run_command` default tool handler in isolation (separated from registry.go for clarity). Exposes `RegisterShellTools(r *Registry)`.

Key details:
- Timeout defaults to 30 seconds, maximum enforced at 300 seconds.
- Combined output is truncated to 64 KB before returning to prevent oversized gRPC responses.
- The working directory defaults to `$HOME`.
- On timeout, the process group is killed with `syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)` on Unix.

---

### `actions/automation.go` — Keyboard and Mouse

Implements keyboard and mouse automation using `github.com/go-vgo/robotgo`. Exposes `RegisterAutomationTools(r *Registry)`.

| Tool | Parameters | Description |
|---|---|---|
| `type_text` | `text string`, `delay_ms int` | Type a string |
| `key_press` | `key string`, `modifiers []string` | Press a key combo (e.g. `ctrl+c`) |
| `mouse_move` | `x int`, `y int` | Move mouse to absolute screen coordinates |
| `mouse_click` | `x int`, `y int`, `button string` | Click at coordinates (`left`/`right`/`middle`) |
| `get_mouse_pos` | — | Return current cursor position as JSON |

**CGO note:** robotgo requires CGO. On Linux it requires `libx11-dev`, `libxtst-dev`, `libxinerama-dev`, `libxrandr-dev`, `libxcursor-dev`. The build will fail without these headers. Set `CGO_ENABLED=1` (default) in the build environment.

**Build tag:** Add `//go:build !noautomation` to allow headless builds that skip robotgo entirely.

---

### `actions/browser.go` — Browser Control

Implements headless browser automation using `github.com/go-rod/rod`. Exposes `RegisterBrowserTools(r *Registry)`.

| Tool | Parameters | Description |
|---|---|---|
| `browser_navigate` | `url string` | Open URL in a managed Chromium instance |
| `browser_click` | `selector string` | Click a CSS selector |
| `browser_type` | `selector string`, `text string` | Type into an element |
| `browser_get_text` | `selector string` | Extract text content of element |
| `browser_screenshot` | `quality int` | Screenshot the browser viewport |
| `browser_close` | — | Close the managed browser instance |

**Browser lifecycle:** The `BrowserActions` struct holds a singleton `*rod.Browser` instance, started lazily on first use and shut down when `browser_close` is called or the daemon exits. Rod manages its own Chromium download on first run (`rod.BrowserPaths`).

**Security note:** `browser_navigate` is marked `Dangerous: false` but the sandbox should still validate that the URL scheme is `https://` or `http://` and is not a `file://` path.

---

### `actions/appctl.go` — Application Control

Implements `RegisterAppctlTools(r *Registry)`.

| Tool | Parameters | Platform | Description |
|---|---|---|---|
| `open_app` | `app string` | All | Open app or file |
| `close_app` | `app string` | All | Kill process by name |
| `focus_window` | `title string` | Linux, Windows | Bring window to foreground |
| `list_windows` | — | All | List open windows as JSON |

**Platform implementations:**
- Linux: `wmctrl -a <title>` for focus; `wmctrl -l` for list.
- macOS: AppleScript `tell application "<app>" to activate`.
- Windows: `SetForegroundWindow` via `syscall`.

---

### `actions/notifications.go` — System Notifications

Implements `RegisterNotificationTools(r *Registry)`.

| Tool | Parameters | Description |
|---|---|---|
| `notify` | `title string`, `body string`, `icon string` | Send a desktop notification |

Uses `github.com/gen2brain/beeep`:
- Linux: `notify-send` (libnotify) or `beeep` fallback.
- macOS: `osascript` / `NSUserNotification`.
- Windows: Toast notification via powershell.

---

### `security/sandbox.go` — Security Sandbox

**Responsibility:** Validate every `ToolRequest` before it reaches the registry. Enforce path allowlists, block catastrophic commands, and flag dangerous commands for user confirmation.

**Full struct definition:**

```go
// daemon/security/sandbox.go
package security

import (
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "strings"
    pb "albedo-ai/daemon/proto"
)

type Sandbox struct {
    AllowedReadPaths  []string // Prefixes; access denied outside these
    AllowedWritePaths []string
    BlockedCommands   []string // Substrings; always rejected
    DangerousCommands []string // Substrings; sets requires_confirmation = true
}

func NewSandbox() *Sandbox
func (s *Sandbox) Validate(req *pb.ToolRequest) error
func (s *Sandbox) ValidatePath(path string, write bool) error
```

**Default blocked commands:**

```go
BlockedCommands: []string{
    "rm -rf /",
    "rm -rf /*",
    "mkfs",
    "dd if=/dev/zero",
    "dd if=/dev/random",
    ":(){ :|:& };:",    // fork bomb
    "> /dev/sda",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
    "systemctl poweroff",
    "systemctl reboot",
    "chmod 777 /",
    "chown -R root /",
    "curl | sh",
    "curl | bash",
    "wget -O- | sh",
    "wget -O- | bash",
},
```

**Default dangerous commands (require confirmation):**

```go
DangerousCommands: []string{
    "rm ",
    "rm\t",
    "mv ",
    "kill ",
    "pkill ",
    "killall ",
    "git push",
    "git reset --hard",
    "git clean -f",
    "npm publish",
    "cargo publish",
    "pip install",
    "sudo ",
    "su ",
    "passwd",
    "crontab",
    "iptables",
    "ufw ",
    "systemctl stop",
    "systemctl disable",
},
```

**Default allowed paths:**

```go
home, _ := os.UserHomeDir()
AllowedReadPaths: []string{
    home,
    "/tmp",
    "/usr/share",
    "/etc/hosts",
    "/proc/cpuinfo",
    "/proc/meminfo",
},
AllowedWritePaths: []string{
    filepath.Join(home, "Desktop"),
    filepath.Join(home, "Documents"),
    filepath.Join(home, "Downloads"),
    filepath.Join(home, "Pictures"),
    "/tmp",
},
```

**Validation flow:**

```
Validate(req) called
│
├─ tool_name == "run_command"?
│   ├─ Unmarshal command string
│   ├─ Lowercase normalize
│   ├─ Check each BlockedCommand substring → return error if match
│   └─ Check each DangerousCommand substring → set req.RequiresConfirmation = true
│
├─ tool_name in {"read_file", "write_file", "append_file", "delete_file"}?
│   ├─ Unmarshal path
│   ├─ filepath.Abs(path) → resolve symlinks
│   └─ ValidatePath(path, isWrite) → check prefix against allowed lists
│
└─ return nil (proceed to registry)
```

**`ValidatePath` logic:**

```go
func (s *Sandbox) ValidatePath(path string, write bool) error {
    abs, err := filepath.Abs(path)
    if err != nil {
        return fmt.Errorf("invalid path: %w", err)
    }
    list := s.AllowedReadPaths
    if write {
        list = s.AllowedWritePaths
    }
    for _, allowed := range list {
        if strings.HasPrefix(abs, allowed) {
            return nil
        }
    }
    return fmt.Errorf("path %q is outside allowed directories", abs)
}
```

**Symlink traversal protection:** After `filepath.Abs`, call `filepath.EvalSymlinks(abs)` and re-check the resolved path against the allowlist. This prevents `~/allowed/../../../etc/shadow`-style escapes.

---

### `cmd/albedo-daemon/main.go` — gRPC Server

**Responsibility:** Wire all subsystems together, listen on a Unix socket, and serve the `albedo.daemon.Daemon` gRPC service.

**Full server struct:**

```go
package main

import (
    "context"
    "log"
    "net"
    "os"
    "os/signal"
    "syscall"
    "time"

    "google.golang.org/grpc"
    pb "albedo-ai/daemon/proto"
    "albedo-ai/daemon/awareness"
    "albedo-ai/daemon/actions"
    "albedo-ai/daemon/security"
)

type daemonServer struct {
    pb.UnimplementedDaemonServer
    collector *awareness.Collector
    tools     *actions.Registry
    sandbox   *security.Sandbox
}
```

**`GetAwareness` implementation:**

```go
func (s *daemonServer) GetAwareness(ctx context.Context, _ *pb.Empty) (*pb.AwarenessSnapshot, error) {
    return s.collector.Snapshot()
}
```

**`StreamAwareness` implementation:**

```go
func (s *daemonServer) StreamAwareness(
    config *pb.AwarenessConfig,
    stream pb.Daemon_StreamAwarenessServer,
) error {
    interval := time.Duration(config.IntervalMs) * time.Millisecond
    if interval < 500*time.Millisecond {
        interval = 500 * time.Millisecond // floor: prevent DoS
    }

    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            snapshot, err := s.collector.Snapshot()
            if err != nil {
                log.Printf("awareness snapshot error: %v", err)
                continue
            }
            if !config.IncludeClipboard {
                snapshot.ClipboardContent = ""
            }
            if err := stream.Send(snapshot); err != nil {
                return err // client disconnected
            }
        case <-stream.Context().Done():
            return nil
        }
    }
}
```

**`CaptureScreen` implementation:**

```go
func (s *daemonServer) CaptureScreen(
    ctx context.Context,
    req *pb.ScreenCaptureRequest,
) (*pb.ScreenCaptureResponse, error) {
    return s.collector.CaptureScreen(req)
}
```

**`ExecuteTool` implementation:**

```go
func (s *daemonServer) ExecuteTool(
    ctx context.Context,
    req *pb.ToolRequest,
) (*pb.ToolResponse, error) {
    if err := s.sandbox.Validate(req); err != nil {
        return &pb.ToolResponse{Success: false, Error: err.Error()}, nil
    }
    if req.RequiresConfirmation {
        // In Phase 5 MVP, the daemon logs and rejects pending confirmation.
        // Phase 6 will wire a confirmation RPC back to the Bun process.
        return &pb.ToolResponse{
            Success: false,
            Error:   "tool requires user confirmation; confirmation flow not yet implemented",
        }, nil
    }
    return s.tools.Execute(req)
}
```

**`ListTools` implementation:**

```go
func (s *daemonServer) ListTools(ctx context.Context, _ *pb.Empty) (*pb.ToolList, error) {
    return s.tools.List(), nil
}
```

**`main()` startup sequence:**

```go
func main() {
    socketPath := "/tmp/albedo-daemon.sock"
    os.Remove(socketPath)

    lis, err := net.Listen("unix", socketPath)
    if err != nil {
        log.Fatalf("[albedo-daemon] listen: %v", err)
    }

    // Init subsystems
    collector := awareness.NewCollector()
    collector.Start()

    registry := actions.NewRegistry()
    actions.RegisterDefaults(registry)
    actions.RegisterFilesystemTools(registry)
    actions.RegisterShellTools(registry)
    actions.RegisterAutomationTools(registry)
    actions.RegisterBrowserTools(registry)
    actions.RegisterAppctlTools(registry)
    actions.RegisterNotificationTools(registry)

    sandbox := security.NewSandbox()

    // gRPC server with sensible limits
    grpcServer := grpc.NewServer(
        grpc.MaxRecvMsgSize(64*1024*1024),   // 64 MB (screen captures)
        grpc.MaxSendMsgSize(64*1024*1024),
    )
    pb.RegisterDaemonServer(grpcServer, &daemonServer{
        collector: collector,
        tools:     registry,
        sandbox:   sandbox,
    })

    // Graceful shutdown on SIGINT/SIGTERM
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
    go func() {
        <-sigCh
        log.Println("[albedo-daemon] shutting down")
        grpcServer.GracefulStop()
        collector.Stop()
        os.Remove(socketPath)
    }()

    log.Printf("[albedo-daemon] listening on %s", socketPath)
    if err := grpcServer.Serve(lis); err != nil {
        log.Fatalf("[albedo-daemon] serve: %v", err)
    }
}
```

---

## Awareness System — Design Detail

### Polling Strategy

The collector uses three independent background goroutines, each with a different polling interval tuned to the cost of the underlying call:

| Loop | Interval | Why |
|---|---|---|
| `windowLoop` | 1 second | Cheap syscall/xdotool; user wants this to feel real-time |
| `clipboardLoop` | 2 seconds | Moderate cost; clipboard rarely changes |
| `metricsLoop` | 3 seconds | `cpu.Percent` blocks for 1 second; network delta adds another second |

All three loops write to a single `*pb.AwarenessSnapshot` protected by a `sync.RWMutex`. The `Snapshot()` call holds `RLock` for the duration of the snapshot read plus the window call.

### `AwarenessSnapshot` Assembly

The snapshot is assembled on every `Snapshot()` call rather than being fully pre-built in the background. This ensures the `TimestampMs` field is always fresh and the window title is as recent as possible (the window loop only updates a sub-field, not the full snapshot).

Fields and sources:

| Proto field | Source | Latency |
|---|---|---|
| `active_window.title` | `GetActiveWindow()` | ~5 ms (xdotool) |
| `active_window.app_name` | `GetActiveWindow()` | ~5 ms |
| `active_window.pid` | `GetActiveWindow()` | ~5 ms |
| `metrics.cpu_percent` | Cached from metricsLoop | 0 ms (cache hit) |
| `metrics.ram_percent` | Cached from metricsLoop | 0 ms |
| `metrics.disk_percent` | Cached from metricsLoop | 0 ms |
| `metrics.network_mbps_in/out` | Cached from metricsLoop | 0 ms |
| `metrics.top_processes` | Cached from metricsLoop | 0 ms |
| `clipboard_content` | Cached from clipboardLoop | 0 ms |
| `timestamp_ms` | `time.Now().UnixMilli()` | 0 ms |

Total `Snapshot()` latency budget: ~5–10 ms on Linux (xdotool round-trip).

### `StreamAwareness` Implementation

`StreamAwareness` is a server-side streaming RPC. The implementation tick-fires `Snapshot()` every `interval_ms` and pushes the result to the client stream. If the client disconnects, `stream.Send()` returns an error and the loop exits cleanly. The minimum interval is clamped to 500 ms to prevent resource exhaustion.

The Bun orchestrator calls `StreamAwareness` once at startup with `interval_ms: 5000` and keeps the stream open for the lifetime of the process.

---

## Tool Registry — Design Detail

### `ToolDef` Type

```go
type ToolDef struct {
    Name        string
    Description string
    Schema      string      // valid JSON Schema object as a string
    Dangerous   bool
    Handler     ToolHandler
}
```

The `Schema` string is passed verbatim to the LLM via `ToolSchema.parameters_json_schema` in the proto message. It must be a valid JSON Schema describing the `properties` object. The orchestrator uses this schema to construct tool calls in the Grok API request.

### Handler Pattern

Each handler is a pure function `func(args json.RawMessage) (string, error)`. The handler is responsible for:
1. Unmarshalling its own `args` struct.
2. Performing its operation.
3. Returning a human-readable or structured string result.
4. Returning an error if the operation fails (not panicking).

Handlers must never call `os.Exit`, never spawn goroutines that outlive the call, and must respect the context passed via a closure if they need cancellation (e.g., `run_command` wraps the exec context from the handler closure).

### Tool Registration at Startup

Registration order in `main.go`:

```
RegisterDefaults(registry)          // read_file, run_command, open_app, type_text, screenshot
RegisterFilesystemTools(registry)   // write_file, append_file, list_dir, find_files, delete_file
RegisterShellTools(registry)        // re-registers run_command with extended options
RegisterAutomationTools(registry)   // key_press, mouse_move, mouse_click, get_mouse_pos
RegisterBrowserTools(registry)      // browser_navigate, browser_click, browser_type, etc.
RegisterAppctlTools(registry)       // close_app, focus_window, list_windows
RegisterNotificationTools(registry) // notify
```

`RegisterDefaults` and `RegisterShellTools` both touch `run_command`. Since `RegisterShellTools` runs second, its more complete implementation wins (it overwrites the key in the map). This is intentional — `RegisterDefaults` is a convenience function that only needs to define the minimal set.

---

## Cross-Platform Considerations

### Window Tracking

| Feature | Linux (X11) | Linux (Wayland) | macOS | Windows |
|---|---|---|---|---|
| Active window title | `xdotool getactivewindow getwindowname` | `swaymsg -t get_tree` or `ydotool` | `osascript` | `GetWindowTextW` via syscall |
| Active window PID | `xdotool getactivewindow getwindowpid` | `swaymsg -t get_tree` JSON | `osascript` | `GetWindowThreadProcessId` |
| App path | `/proc/<pid>/exe` readlink | Same | `proc_pidpath` (CGO) or `lsof -p` | `QueryFullProcessImageNameW` |
| List windows | `wmctrl -l` | `swaymsg -t get_tree` | `osascript` | `EnumWindows` |
| Focus window | `wmctrl -a <title>` | `swaymsg '[title="<title>"]' focus` | `osascript tell activate` | `SetForegroundWindow` |

Use `runtime.GOOS` switches within each function. Group platform-specific implementations into files named `window_linux.go`, `window_darwin.go`, `window_windows.go` using Go build tags:

```go
//go:build linux
// +build linux
```

This avoids runtime switches in the main file and keeps platform-specific imports isolated.

### Screen Capture

`kbinani/screenshot` abstracts platform differences:
- **Linux**: Uses X11 via CGO (`XGetImage`). Does not support Wayland natively — use `grim` subprocess as fallback on Wayland.
- **macOS**: Uses `CGDisplayCreateImage` via CGO.
- **Windows**: Uses `BitBlt` via CGO.

The library is a hard CGO dependency. There is no pure-Go fallback. Ensure the CI build environment has X11 headers on Linux.

### App Control

| Operation | Linux | macOS | Windows |
|---|---|---|---|
| Open app | `xdg-open <app>` | `open -a "<app>"` | `cmd /c start "" "<app>"` |
| Close app | `pkill -f <name>` | `osascript: quit application` | `taskkill /IM <name>.exe` |
| Notifications | `notify-send` | `osascript display notification` | PowerShell `New-BurntToastNotification` or `beeep` |

### Build Tags Summary

| File | Build tag | Purpose |
|---|---|---|
| `window_linux.go` | `//go:build linux` | X11/proc window tracking |
| `window_darwin.go` | `//go:build darwin` | AppleScript window tracking |
| `window_windows.go` | `//go:build windows` | Win32 window tracking |
| `screen.go` (body) | `//go:build !noscrn` | Skip in headless CI |
| `automation.go` (body) | `//go:build !noautomation` | Skip robotgo in CI |

---

## gRPC Server — Method Implementations

### `GetAwareness`

- Type: Unary RPC
- Input: `Empty`
- Output: `AwarenessSnapshot`
- Calls `collector.Snapshot()` and returns the result directly.
- Error: Returns gRPC `Internal` status if the snapshot cannot be assembled.

### `StreamAwareness`

- Type: Server-streaming RPC
- Input: `AwarenessConfig { interval_ms, include_clipboard, include_screen_ocr }`
- Output: stream of `AwarenessSnapshot`
- Runs a ticker loop; clears `clipboard_content` if `include_clipboard` is false.
- `include_screen_ocr` is reserved for Phase 6 (OCR integration); in Phase 5, if set to true, log a warning and proceed without OCR.
- The stream terminates when the client cancels the context.

### `CaptureScreen`

- Type: Unary RPC
- Input: `ScreenCaptureRequest { region, format, quality, include_ocr }`
- Output: `ScreenCaptureResponse { image_data, ocr_text, width, height }`
- Delegates to `collector.CaptureScreen(req)`.
- `include_ocr` is no-op in Phase 5; `ocr_text` returns empty string.
- JPEG quality defaults to 75 if the request sends 0.

### `ExecuteTool`

- Type: Unary RPC
- Input: `ToolRequest { tool_name, arguments_json, requires_confirmation }`
- Output: `ToolResponse { success, result, error }`
- Flow: sandbox.Validate → check requires_confirmation → registry.Execute
- Never returns a non-nil gRPC error — tool failures are expressed as `{ success: false, error: "..." }`.

### `ListTools`

- Type: Unary RPC
- Input: `Empty`
- Output: `ToolList` containing all registered `ToolSchema` entries
- The list is built once at startup and returned from the cached in-memory map.
- Sorted alphabetically by `Name` before returning for deterministic output.

---

## Testing Strategy

### Unit Tests

#### `daemon/awareness/window_test.go`

```go
func TestGetActiveWindowReturnsNonNilOnError(t *testing.T) {
    // Even when xdotool is not present, should return an empty struct, not nil
    win, _ := GetActiveWindow()
    assert.NotNil(t, win)
}

func TestGetActiveWindowHasNonEmptyTitle(t *testing.T) {
    // Skip if running in CI without display
    if os.Getenv("DISPLAY") == "" {
        t.Skip("no display")
    }
    win, err := GetActiveWindow()
    require.NoError(t, err)
    assert.NotEmpty(t, win.Title)
}
```

#### `daemon/awareness/metrics_test.go`

```go
func TestCollectMetricsReturnsValidRanges(t *testing.T) {
    m, err := CollectMetrics()
    require.NoError(t, err)
    assert.GreaterOrEqual(t, m.CPUPercent, float32(0))
    assert.LessOrEqual(t, m.CPUPercent, float32(100))
    assert.GreaterOrEqual(t, m.RAMPercent, float32(0))
    assert.LessOrEqual(t, m.RAMPercent, float32(100))
    assert.GreaterOrEqual(t, m.DiskPercent, float32(0))
    assert.LessOrEqual(t, m.DiskPercent, float32(100))
}

func TestTopProcessesNonEmpty(t *testing.T) {
    m, err := CollectMetrics()
    require.NoError(t, err)
    assert.NotEmpty(t, m.TopProcesses)
}
```

#### `daemon/awareness/collector_test.go` — Integration Test for Snapshot Assembly

```go
func TestCollectorSnapshotIsComplete(t *testing.T) {
    if os.Getenv("DISPLAY") == "" {
        t.Skip("requires display")
    }
    c := NewCollector()
    c.Start()
    defer c.Stop()

    time.Sleep(4 * time.Second) // allow metricsLoop to populate

    snap, err := c.Snapshot()
    require.NoError(t, err)
    assert.NotNil(t, snap.Metrics)
    assert.Greater(t, snap.TimestampMs, uint64(0))
    assert.Greater(t, snap.Metrics.CpuPercent+snap.Metrics.RamPercent, float32(0))
}
```

#### `daemon/actions/registry_test.go`

```go
func TestRegisterAndExecuteTool(t *testing.T) {
    r := NewRegistry()
    r.Register(&ToolDef{
        Name:    "echo_tool",
        Handler: func(args json.RawMessage) (string, error) {
            var p struct{ Msg string `json:"msg"` }
            json.Unmarshal(args, &p)
            return p.Msg, nil
        },
    })
    resp, err := r.Execute(&pb.ToolRequest{
        ToolName:      "echo_tool",
        ArgumentsJson: `{"msg":"hello"}`,
    })
    require.NoError(t, err)
    assert.True(t, resp.Success)
    assert.Equal(t, "hello", resp.Result)
}

func TestExecuteUnknownToolReturnsError(t *testing.T) {
    r := NewRegistry()
    resp, err := r.Execute(&pb.ToolRequest{ToolName: "nonexistent"})
    require.NoError(t, err) // gRPC error must be nil
    assert.False(t, resp.Success)
    assert.Contains(t, resp.Error, "unknown tool")
}
```

#### `daemon/actions/filesystem_test.go`

```go
func TestReadFileTool(t *testing.T) {
    tmp := t.TempDir()
    path := filepath.Join(tmp, "test.txt")
    os.WriteFile(path, []byte("hello world"), 0644)

    r := NewRegistry()
    RegisterFilesystemTools(r)

    resp, _ := r.Execute(&pb.ToolRequest{
        ToolName:      "read_file",
        ArgumentsJson: fmt.Sprintf(`{"path":%q}`, path),
    })
    assert.True(t, resp.Success)
    assert.Equal(t, "hello world", resp.Result)
}
```

#### `daemon/security/sandbox_test.go`

```go
func TestBlockedCommandIsRejected(t *testing.T) {
    s := NewSandbox()
    err := s.Validate(&pb.ToolRequest{
        ToolName:      "run_command",
        ArgumentsJson: `{"command":"rm -rf /"}`,
    })
    assert.Error(t, err)
    assert.Contains(t, err.Error(), "blocked command")
}

func TestDangerousCommandSetsConfirmation(t *testing.T) {
    s := NewSandbox()
    req := &pb.ToolRequest{
        ToolName:      "run_command",
        ArgumentsJson: `{"command":"rm -f /tmp/foo.txt"}`,
    }
    err := s.Validate(req)
    assert.NoError(t, err)
    assert.True(t, req.RequiresConfirmation)
}

func TestPathOutsideAllowlistRejected(t *testing.T) {
    s := NewSandbox()
    err := s.ValidatePath("/etc/shadow", false)
    assert.Error(t, err)
}

func TestPathInsideAllowlistAccepted(t *testing.T) {
    s := NewSandbox()
    err := s.ValidatePath("/tmp/test.txt", true)
    assert.NoError(t, err)
}
```

### Tool Execution Tests

The `run_command` tool is tested with a subprocess that writes to stdout:

```go
func TestRunCommandCapturesOutput(t *testing.T) {
    r := NewRegistry()
    RegisterShellTools(r)

    resp, _ := r.Execute(&pb.ToolRequest{
        ToolName:      "run_command",
        ArgumentsJson: `{"command":"echo hello-daemon"}`,
    })
    assert.True(t, resp.Success)
    assert.Contains(t, resp.Result, "hello-daemon")
}

func TestRunCommandTimesOut(t *testing.T) {
    r := NewRegistry()
    RegisterShellTools(r)

    resp, _ := r.Execute(&pb.ToolRequest{
        ToolName:      "run_command",
        ArgumentsJson: `{"command":"sleep 100","timeout_seconds":1}`,
    })
    assert.False(t, resp.Success)
}
```

### gRPC Integration Test

Create `daemon/cmd/albedo-daemon/integration_test.go` (skipped unless `ALBEDO_INTEGRATION=1`):

```go
//go:build integration

func TestGRPCGetAwareness(t *testing.T) {
    // Start daemon in a goroutine on a temp socket
    // Dial it
    // Call GetAwareness
    // Assert snapshot has non-zero timestamp
}

func TestGRPCStreamAwareness(t *testing.T) {
    // Start daemon
    // Call StreamAwareness with interval_ms=500
    // Receive 3 snapshots
    // Assert each has increasing timestamps
}

func TestGRPCExecuteToolReadFile(t *testing.T) {
    // Write a temp file
    // Call ExecuteTool { tool_name: "read_file", arguments_json: ... }
    // Assert success = true, result contains file content
}
```

---

## Validation Criteria

The phase is complete when all of the following are true:

1. `go build ./...` completes with zero errors from within `daemon/`.
2. `go test ./...` passes with no failures (excluding integration tests that require a display).
3. `bin/albedo-daemon` starts and logs `[albedo-daemon] listening on /tmp/albedo-daemon.sock`.
4. `grpcurl -plaintext -unix /tmp/albedo-daemon.sock albedo.daemon.Daemon/GetAwareness` returns a JSON response with `timestampMs` greater than zero.
5. `grpcurl -plaintext -unix /tmp/albedo-daemon.sock -d '{"intervalMs":1000}' albedo.daemon.Daemon/StreamAwareness` streams at least three `AwarenessSnapshot` objects before being cancelled.
6. `grpcurl -plaintext -unix /tmp/albedo-daemon.sock albedo.daemon.Daemon/ListTools` returns at least five tools including `read_file`, `run_command`, `open_app`, `type_text`, `screenshot`.
7. `grpcurl -plaintext -unix /tmp/albedo-daemon.sock -d '{"toolName":"run_command","argumentsJson":"{\"command\":\"echo ok\"}"}' albedo.daemon.Daemon/ExecuteTool` returns `{"success": true, "result": "ok\n"}`.
8. `grpcurl` call with `toolName: "run_command"` and `argumentsJson: '{"command":"rm -rf /"}'` returns `{"success": false, "error": "blocked command: rm -rf /"}`.
9. The Bun orchestrator's `DaemonClient.streamAwareness` callback receives valid snapshots from the running binary (Phase 6 integration validation).

---

## Dependencies

### Exact Go Module Versions

```
google.golang.org/grpc             v1.64.0
google.golang.org/protobuf         v1.34.1
github.com/go-vgo/robotgo          v0.110.3
github.com/kbinani/screenshot      v0.0.0-20230812210009-b87d31814237
github.com/shirou/gopsutil/v3      v3.24.4
github.com/go-rod/rod              v0.116.0
golang.design/x/clipboard          v0.7.0
github.com/gen2brain/beeep         v0.0.0-20240516210008-9c006672e7f4
```

### Transitive CGO Dependencies (Linux)

| Go module | C library | APT package |
|---|---|---|
| `go-vgo/robotgo` | libx11, libxtst, libxinerama, libxrandr, libxcursor | `libx11-dev libxtst-dev libxinerama-dev libxrandr-dev libxcursor-dev` |
| `kbinani/screenshot` | libx11, libpng | `libx11-dev libpng-dev` |
| `golang.design/x/clipboard` | libx11 | `libx11-dev` |

---

## Risks and Notes

### robotgo CGO Requirements

robotgo requires CGO and a set of X11 development headers on Linux. In environments without a display (headless CI, Docker), the build will succeed but `type_text`, `key_press`, `mouse_move`, and `mouse_click` will panic or return errors at runtime. Mitigate with:

1. Build tag `//go:build !noautomation` on `automation.go` to allow headless builds that compile without robotgo.
2. In the `RegisterAutomationTools` function, check for the `DISPLAY` env var at registration time and skip registration if absent:
   ```go
   if os.Getenv("DISPLAY") == "" && runtime.GOOS == "linux" {
       log.Println("[automation] no DISPLAY, skipping automation tools")
       return
   }
   ```
3. The GitHub Actions CI workflow should set `DISPLAY=:99` with `Xvfb` for full tests.

### Wayland Compatibility

`xdotool` does not work on Wayland. On Wayland-native sessions (common on GNOME 42+ Fedora, Ubuntu 22.04+), window tracking will fail silently and return empty strings. Detection:

```go
if os.Getenv("WAYLAND_DISPLAY") != "" {
    return getActiveWindowWayland()  // uses swaymsg or ydotool
}
```

`kbinani/screenshot` similarly does not support Wayland without XWayland enabled. Users running Wayland must have XWayland available for screen capture to work.

### macOS Permissions

On macOS, the following entitlements/permissions are required:

- **Accessibility** (`com.apple.security.automation.apple-events`): Required for AppleScript window tracking and robotgo.
- **Screen Recording** (`com.apple.security.cs.disable-library-validation`): Required for `CGDisplayCreateImage` screen capture.
- **Automation**: Required for app control via AppleScript.

The binary must be signed and the user must grant permissions in **System Settings → Privacy & Security**. On first run, macOS will prompt the user. Add instructions to the installer.

### Windows Permissions

- Window tracking via Win32 API requires no elevated permissions.
- `GetForegroundWindow` may return null for apps running at a higher integrity level (e.g., Task Manager). Handle gracefully.
- `QueryFullProcessImageNameW` requires `PROCESS_QUERY_LIMITED_INFORMATION` access, which is usually available without elevation.

### gRPC Message Size

Screen captures at 1920×1080 JPEG quality 75 are approximately 300–600 KB. The gRPC server is configured with `MaxSendMsgSize(64*1024*1024)` (64 MB). The Bun `DaemonClient` must be configured with the same `maxReceiveMessageLength` to avoid client-side truncation.

### Socket File Cleanup

The daemon removes `/tmp/albedo-daemon.sock` on startup and on graceful shutdown. If the process is killed with `SIGKILL`, the stale socket file will prevent the next instance from starting. The startup `os.Remove(socketPath)` call handles this case. The Bun orchestrator should also remove stale socket files before spawning the daemon.

### Phase 5 Scope Boundary

The following are **explicitly out of scope for Phase 5** and will be addressed in Phase 6 or later:

- OCR of screen captures (`include_screen_ocr` in `ScreenCaptureRequest` is a no-op).
- User confirmation dialog for dangerous tools (the daemon rejects them with an error message; the confirmation flow requires Bun ↔ daemon round-trip RPC).
- Desktop audio loopback capture (handled by the Rust audio engine).
- Long-term memory integration (handled by the Bun SQLite layer).
- Multi-monitor screen capture (Phase 5 captures display index 0 only).
