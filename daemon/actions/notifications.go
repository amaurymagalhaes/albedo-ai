package actions

import (
	"encoding/json"

	"github.com/gen2brain/beeep"
)

func RegisterNotificationTools(r *Registry) {
	r.Register(&ToolDef{
		Name:        "notify",
		Description: "Send a desktop notification",
		Schema: `{
			"type": "object",
			"properties": {
				"title": {"type": "string", "description": "Notification title"},
				"body": {"type": "string", "description": "Notification body text"},
				"icon": {"type": "string", "description": "Path to icon image (optional)"}
			},
			"required": ["title", "body"]
		}`,
		Dangerous: false,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Title string `json:"title"`
				Body  string `json:"body"`
				Icon  string `json:"icon"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			if err := beeep.Notify(p.Title, p.Body, p.Icon); err != nil {
				return "", err
			}
			return "ok", nil
		},
	})
}
