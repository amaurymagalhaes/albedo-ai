//go:build !noautomation

package actions

import (
	"encoding/json"

	"github.com/go-vgo/robotgo"
)

func RegisterAutomationTools(r *Registry) {
	r.Register(&ToolDef{
		Name:        "type_text",
		Description: "Type a string of text",
		Schema: `{
			"type": "object",
			"properties": {
				"text": {"type": "string", "description": "Text to type"},
				"delay_ms": {"type": "integer", "description": "Delay between keystrokes in milliseconds (0 for instant)", "default": 0}
			},
			"required": ["text"]
		}`,
		Dangerous: true,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Text    string `json:"text"`
				DelayMs int    `json:"delay_ms"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			if p.DelayMs > 0 {
				for _, ch := range p.Text {
					robotgo.KeyTap(string(ch))
					robotgo.MilliSleep(p.DelayMs)
				}
			} else {
				robotgo.TypeStr(p.Text)
			}
			return "ok", nil
		},
	})

	r.Register(&ToolDef{
		Name:        "key_press",
		Description: "Press a key with optional modifiers",
		Schema: `{
			"type": "object",
			"properties": {
				"key": {"type": "string", "description": "Key to press"},
				"modifiers": {"type": "array", "items": {"type": "string"}, "description": "Key modifiers (e.g. ctrl, alt, shift)"}
			},
			"required": ["key"]
		}`,
		Dangerous: true,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Key       string   `json:"key"`
				Modifiers []string `json:"modifiers"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			modifiers := make([]interface{}, len(p.Modifiers))
			for i, m := range p.Modifiers {
				modifiers[i] = m
			}
			robotgo.KeyTap(p.Key, modifiers...)
			return "ok", nil
		},
	})

	r.Register(&ToolDef{
		Name:        "mouse_move",
		Description: "Move the mouse cursor to coordinates",
		Schema: `{
			"type": "object",
			"properties": {
				"x": {"type": "integer", "description": "X coordinate"},
				"y": {"type": "integer", "description": "Y coordinate"}
			},
			"required": ["x", "y"]
		}`,
		Dangerous: true,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				X int `json:"x"`
				Y int `json:"y"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			robotgo.Move(p.X, p.Y)
			return "ok", nil
		},
	})

	r.Register(&ToolDef{
		Name:        "mouse_click",
		Description: "Click the mouse at coordinates",
		Schema: `{
			"type": "object",
			"properties": {
				"x": {"type": "integer", "description": "X coordinate"},
				"y": {"type": "integer", "description": "Y coordinate"},
				"button": {"type": "string", "enum": ["left", "right", "middle"], "description": "Mouse button (default left)", "default": "left"}
			},
			"required": ["x", "y"]
		}`,
		Dangerous: true,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				X      int    `json:"x"`
				Y      int    `json:"y"`
				Button string `json:"button"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			if p.Button == "" {
				p.Button = "left"
			}
			robotgo.Move(p.X, p.Y)
			robotgo.Click(p.Button, false)
			return "ok", nil
		},
	})

	r.Register(&ToolDef{
		Name:        "get_mouse_pos",
		Description: "Get the current mouse cursor position",
		Schema: `{
			"type": "object",
			"properties": {},
			"required": []
		}`,
		Dangerous: false,
		Handler: func(args json.RawMessage) (string, error) {
			x, y := robotgo.Location()
			result := struct {
				X int `json:"x"`
				Y int `json:"y"`
			}{X: x, Y: y}
			data, err := json.Marshal(result)
			if err != nil {
				return "", err
			}
			return string(data), nil
		},
	})
}
