package security

import (
	pb "albedo-ai/daemon/proto"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Sandbox struct {
	AllowedReadPaths  []string
	AllowedWritePaths []string
	BlockedCommands   []string
	DangerousCommands []string
}

func NewSandbox() *Sandbox {
	home, _ := os.UserHomeDir()
	return &Sandbox{
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
		BlockedCommands: []string{
			"rm -rf /",
			"rm -rf /*",
			"mkfs",
			"dd if=/dev/zero",
			"dd if=/dev/random",
			":(){ :|:& };:",
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
	}
}

func (s *Sandbox) Validate(req *pb.ToolRequest) error {
	switch req.ToolName {
	case "run_command":
		var p struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal([]byte(req.ArgumentsJson), &p); err != nil {
			return fmt.Errorf("invalid arguments: %w", err)
		}
		lower := strings.ToLower(p.Command)
		for _, blocked := range s.BlockedCommands {
			if strings.Contains(lower, strings.ToLower(blocked)) {
				return fmt.Errorf("blocked command: %s", blocked)
			}
		}
		for _, dangerous := range s.DangerousCommands {
			if strings.Contains(lower, strings.ToLower(dangerous)) {
				req.RequiresConfirmation = true
				break
			}
		}
	case "read_file":
		var p struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal([]byte(req.ArgumentsJson), &p); err != nil {
			return fmt.Errorf("invalid arguments: %w", err)
		}
		if err := s.ValidatePath(p.Path, false); err != nil {
			return err
		}
	case "write_file", "append_file", "delete_file":
		var p struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal([]byte(req.ArgumentsJson), &p); err != nil {
			return fmt.Errorf("invalid arguments: %w", err)
		}
		if err := s.ValidatePath(p.Path, true); err != nil {
			return err
		}
	}
	return nil
}

func (s *Sandbox) ValidatePath(path string, write bool) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("invalid path: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err == nil {
		abs = resolved
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
