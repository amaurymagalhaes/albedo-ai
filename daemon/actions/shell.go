//go:build !noautomation

package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func RegisterShellTools(r *Registry) {
	r.Register(&ToolDef{
		Name:        "run_command",
		Description: "Run a shell command",
		Schema: `{
			"type": "object",
			"properties": {
				"command": {"type": "string", "description": "Shell command to run"},
				"timeout_seconds": {"type": "integer", "description": "Timeout in seconds (default 30, max 300)", "default": 30}
			},
			"required": ["command"]
		}`,
		Dangerous: true,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Command        string `json:"command"`
				TimeoutSeconds int    `json:"timeout_seconds"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			if p.TimeoutSeconds <= 0 {
				p.TimeoutSeconds = 30
			}
			if p.TimeoutSeconds > 300 {
				p.TimeoutSeconds = 300
			}

			timeout := time.Duration(p.TimeoutSeconds) * time.Second
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()

			cmd := exec.CommandContext(ctx, "sh", "-c", p.Command)
			cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

			home, _ := os.UserHomeDir()
			if home != "" {
				cmd.Dir = home
			}

			output, err := cmd.CombinedOutput()
			if ctx.Err() == context.DeadlineExceeded {
				if cmd.Process != nil {
					syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
				}
				return string(output) + fmt.Sprintf("\n[TIMEOUT: command exceeded %d seconds]", p.TimeoutSeconds), nil
			}
			if err != nil {
				return string(output), err
			}

			if len(output) > 64*1024 {
				output = output[:64*1024]
			}
			return string(output), nil
		},
	})
}
