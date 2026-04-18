package actions

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	pb "albedo-ai/daemon/proto"

	"albedo-ai/daemon/awareness"
)

func linuxAppCandidates(app string) []string {
	lower := strings.ToLower(app)
	candidates := []string{app}

	switch lower {
	case "firefox", "mozilla firefox":
		candidates = append(candidates, "firefox", "Firefox", "org.mozilla.firefox")
	case "chrome", "google chrome":
		candidates = append(candidates, "google-chrome", "google-chrome-stable", "chrome-browser")
	case "chromium":
		candidates = append(candidates, "chromium", "chromium-browser")
	case "code", "vscode", "visual studio code":
		candidates = append(candidates, "code", "code-oss", "visual-studio-code")
	case "terminal":
		candidates = append(candidates, "org.gnome.Terminal", "gnome-terminal", "konsole", "xfce4-terminal")
	case "files", "file manager", "nautilus":
		candidates = append(candidates, "org.gnome.Nautilus", "nautilus", "thunar", "dolphin", "pcmanfm")
	case "discord":
		candidates = append(candidates, "discord", "com.discordapp.Discord")
	case "spotify":
		candidates = append(candidates, "spotify", "com.spotify.Client")
	}

	dirs := []string{
		"/usr/share/applications",
		"/var/lib/flatpak/exports/share/applications",
		filepath.Join(os.Getenv("HOME"), ".local/share/applications"),
	}
	for _, dir := range dirs {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			name := e.Name()
			if strings.Contains(strings.ToLower(name), lower) && strings.HasSuffix(name, ".desktop") {
				base := strings.TrimSuffix(name, ".desktop")
				candidates = append(candidates, base)
			}
		}
	}

	return candidates
}

type ToolHandler func(args json.RawMessage) (string, error)

type ToolDef struct {
	Name        string
	Description string
	Schema      string
	Dangerous   bool
	Handler     ToolHandler
}

type Registry struct {
	tools map[string]*ToolDef
	mu    sync.RWMutex
}

func NewRegistry() *Registry {
	return &Registry{tools: make(map[string]*ToolDef)}
}

func (r *Registry) Register(tool *ToolDef) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.tools[tool.Name]; exists {
		r.tools[tool.Name] = tool
		return
	}
	r.tools[tool.Name] = tool
}

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

func (r *Registry) List() *pb.ToolList {
	r.mu.RLock()
	defer r.mu.RUnlock()

	tools := make([]*pb.ToolSchema, 0, len(r.tools))
	for _, t := range r.tools {
		tools = append(tools, &pb.ToolSchema{
			Name:                 t.Name,
			Description:          t.Description,
			ParametersJsonSchema: t.Schema,
			Dangerous:            t.Dangerous,
		})
	}
	sort.Slice(tools, func(i, j int) bool {
		return tools[i].Name < tools[j].Name
	})
	return &pb.ToolList{Tools: tools}
}

func RegisterDefaults(r *Registry) {
	r.Register(&ToolDef{
		Name:        "read_file",
		Description: "Read the contents of a file at the given path. Returns the file text.",
		Schema:      `{"type":"object","properties":{"path":{"type":"string","description":"Absolute or home-relative file path"},"max_bytes":{"type":"integer","default":102400,"description":"Max bytes to read (default 100 KB)"}},"required":["path"]}`,
		Dangerous:   false,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Path     string `json:"path"`
				MaxBytes int    `json:"max_bytes"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", fmt.Errorf("invalid args: %w", err)
			}
			if p.MaxBytes == 0 {
				p.MaxBytes = 102400
			}
			data, err := os.ReadFile(p.Path)
			if err != nil {
				return "", err
			}
			if len(data) > p.MaxBytes {
				data = data[:p.MaxBytes]
			}
			return string(data), nil
		},
	})

	r.Register(&ToolDef{
		Name:        "open_app",
		Description: "Open an application or file. On Linux uses gtk-launch or searches .desktop files, on macOS uses open -a, on Windows uses start.",
		Schema:      `{"type":"object","properties":{"app":{"type":"string","description":"Application name (e.g. 'firefox', 'Firefox', 'org.mozilla.firefox'), .desktop file, or file path"}},"required":["app"]}`,
		Dangerous:   false,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				App string `json:"app"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", fmt.Errorf("invalid args: %w", err)
			}

			switch runtime.GOOS {
			case "darwin":
				cmd := exec.Command("open", "-a", p.App)
				if err := cmd.Run(); err != nil {
					return "", fmt.Errorf("failed to open %q: %w", p.App, err)
				}
				return fmt.Sprintf("opened %s", p.App), nil

			case "windows":
				cmd := exec.Command("cmd", "/c", "start", "", p.App)
				if err := cmd.Run(); err != nil {
					return "", fmt.Errorf("failed to open %q: %w", p.App, err)
				}
				return fmt.Sprintf("opened %s", p.App), nil

			default:
				candidates := linuxAppCandidates(p.App)
				for _, candidate := range candidates {
					cmd := exec.Command("gtk-launch", candidate)
					if cmd.Run() == nil {
						return fmt.Sprintf("opened %s", p.App), nil
					}
				}

				cmd := exec.Command("sh", "-c", fmt.Sprintf("which %q 2>/dev/null && nohup %q >/dev/null 2>&1 &", p.App, p.App))
				if err := cmd.Run(); err == nil {
					return fmt.Sprintf("opened %s", p.App), nil
				}

				return "", fmt.Errorf("could not find or launch %q — tried: %v", p.App, candidates)
			}
		},
	})

	r.Register(&ToolDef{
		Name:        "screenshot",
		Description: "Capture the current screen and return it as a base64-encoded JPEG tagged string.",
		Schema:      `{"type":"object","properties":{"quality":{"type":"integer","default":60,"minimum":1,"maximum":100},"region":{"type":"string","enum":["full","active_window"],"default":"full"}}}`,
		Dangerous:   false,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Quality int    `json:"quality"`
				Region  string `json:"region"`
			}
			json.Unmarshal(args, &p)
			if p.Quality == 0 {
				p.Quality = 60
			}
			var data []byte
			var w, h int
			var err error
			if p.Region == "active_window" {
				data, w, h, err = awareness.CaptureActiveWindowJPEG(p.Quality)
			} else {
				data, w, h, err = awareness.CaptureScreenJPEG(p.Quality)
			}
			if err != nil {
				return "", err
			}
			encoded := base64.StdEncoding.EncodeToString(data)
			return fmt.Sprintf("[SCREENSHOT:%dx%d:%s]", w, h, encoded), nil
		},
	})
}
