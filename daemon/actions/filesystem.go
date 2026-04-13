package actions

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func RegisterFilesystemTools(r *Registry) {
	r.Register(&ToolDef{
		Name:        "read_file",
		Description: "Read the contents of a file",
		Schema: `{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "Path to the file"},
				"max_bytes": {"type": "integer", "description": "Maximum bytes to read (default 102400)", "default": 102400}
			},
			"required": ["path"]
		}`,
		Dangerous: false,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Path     string `json:"path"`
				MaxBytes int    `json:"max_bytes"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			if p.MaxBytes <= 0 {
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
		Name:        "write_file",
		Description: "Write content to a file",
		Schema: `{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "Path to the file"},
				"content": {"type": "string", "description": "Content to write"}
			},
			"required": ["path", "content"]
		}`,
		Dangerous: true,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Path    string `json:"path"`
				Content string `json:"content"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			if err := os.WriteFile(p.Path, []byte(p.Content), 0644); err != nil {
				return "", err
			}
			return "ok", nil
		},
	})

	r.Register(&ToolDef{
		Name:        "append_file",
		Description: "Append content to a file",
		Schema: `{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "Path to the file"},
				"content": {"type": "string", "description": "Content to append"}
			},
			"required": ["path", "content"]
		}`,
		Dangerous: true,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Path    string `json:"path"`
				Content string `json:"content"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			f, err := os.OpenFile(p.Path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
			if err != nil {
				return "", err
			}
			defer f.Close()
			if _, err := f.WriteString(p.Content); err != nil {
				return "", err
			}
			return "ok", nil
		},
	})

	r.Register(&ToolDef{
		Name:        "list_dir",
		Description: "List directory contents",
		Schema: `{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "Path to the directory"}
			},
			"required": ["path"]
		}`,
		Dangerous: false,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Path string `json:"path"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			entries, err := os.ReadDir(p.Path)
			if err != nil {
				return "", err
			}
			type entry struct {
				Name  string `json:"name"`
				IsDir bool   `json:"is_dir"`
			}
			result := make([]entry, 0, len(entries))
			for _, e := range entries {
				result = append(result, entry{
					Name:  e.Name(),
					IsDir: e.IsDir(),
				})
			}
			data, err := json.Marshal(result)
			if err != nil {
				return "", err
			}
			return string(data), nil
		},
	})

	r.Register(&ToolDef{
		Name:        "find_files",
		Description: "Find files matching a glob pattern",
		Schema: `{
			"type": "object",
			"properties": {
				"pattern": {"type": "string", "description": "Glob pattern to match"}
			},
			"required": ["pattern"]
		}`,
		Dangerous: false,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Pattern string `json:"pattern"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			matches, err := filepath.Glob(p.Pattern)
			if err != nil {
				return "", err
			}
			data, err := json.Marshal(matches)
			if err != nil {
				return "", err
			}
			return string(data), nil
		},
	})

	r.Register(&ToolDef{
		Name:        "delete_file",
		Description: "Delete a file",
		Schema: `{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "Path to the file to delete"}
			},
			"required": ["path"]
		}`,
		Dangerous: true,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Path string `json:"path"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			if err := os.Remove(p.Path); err != nil {
				return "", err
			}
			return "ok", nil
		},
	})

}
