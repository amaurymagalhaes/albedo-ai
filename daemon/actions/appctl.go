package actions

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

func RegisterAppctlTools(r *Registry) {
	r.Register(&ToolDef{
		Name:        "close_app",
		Description: "Close an application by name",
		Schema: `{
			"type": "object",
			"properties": {
				"name": {"type": "string", "description": "Application name to close"}
			},
			"required": ["name"]
		}`,
		Dangerous: true,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Name string `json:"name"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			var cmd *exec.Cmd
			switch runtime.GOOS {
			case "linux":
				cmd = exec.Command("pkill", "-f", p.Name)
			case "darwin":
				cmd = exec.Command("osascript", "-e", fmt.Sprintf(`quit app "%s"`, p.Name))
			case "windows":
				cmd = exec.Command("taskkill", "/IM", p.Name)
			default:
				return "", fmt.Errorf("unsupported platform: %s", runtime.GOOS)
			}
			if err := cmd.Run(); err != nil {
				return "", err
			}
			return "ok", nil
		},
	})

	r.Register(&ToolDef{
		Name:        "focus_window",
		Description: "Focus a window by title",
		Schema: `{
			"type": "object",
			"properties": {
				"title": {"type": "string", "description": "Window title to focus"}
			},
			"required": ["title"]
		}`,
		Dangerous: false,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Title string `json:"title"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			var cmd *exec.Cmd
			switch runtime.GOOS {
			case "linux":
				cmd = exec.Command("wmctrl", "-a", p.Title)
			case "darwin":
				cmd = exec.Command("osascript", "-e", fmt.Sprintf(`tell application "%s" to activate`, p.Title))
			default:
				return "", fmt.Errorf("unsupported platform: %s", runtime.GOOS)
			}
			if err := cmd.Run(); err != nil {
				return "", err
			}
			return "ok", nil
		},
	})

	r.Register(&ToolDef{
		Name:        "list_windows",
		Description: "List all visible windows",
		Schema: `{
			"type": "object",
			"properties": {},
			"required": []
		}`,
		Dangerous: false,
		Handler: func(args json.RawMessage) (string, error) {
			var cmd *exec.Cmd
			switch runtime.GOOS {
			case "linux":
				cmd = exec.Command("wmctrl", "-l")
			case "darwin":
				cmd = exec.Command("osascript", "-e", `tell application "System Events" to get name of every window of every process whose visible is true`)
			default:
				return "", fmt.Errorf("unsupported platform: %s", runtime.GOOS)
			}
			output, err := cmd.CombinedOutput()
			if err != nil {
				return "", err
			}
			return strings.TrimSpace(string(output)), nil
		},
	})
}
