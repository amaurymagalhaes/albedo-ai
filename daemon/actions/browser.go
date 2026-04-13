package actions

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"sync"

	"github.com/go-rod/rod"
)

type browserState struct {
	mu      sync.Mutex
	browser *rod.Browser
	page    *rod.Page
}

func (bs *browserState) getBrowser() *rod.Browser {
	bs.mu.Lock()
	defer bs.mu.Unlock()
	if bs.browser == nil {
		bs.browser = rod.New()
		bs.browser.MustConnect()
	}
	return bs.browser
}

func (bs *browserState) getPage() (*rod.Page, error) {
	bs.mu.Lock()
	defer bs.mu.Unlock()
	if bs.page == nil {
		return nil, fmt.Errorf("no active page; use browser_navigate first")
	}
	return bs.page, nil
}

func (bs *browserState) close() {
	bs.mu.Lock()
	defer bs.mu.Unlock()
	if bs.browser != nil {
		bs.browser.MustClose()
		bs.browser = nil
		bs.page = nil
	}
}

var globalBrowser = &browserState{}

func RegisterBrowserTools(r *Registry) {
	r.Register(&ToolDef{
		Name:        "browser_navigate",
		Description: "Navigate to a URL in the browser",
		Schema: `{
			"type": "object",
			"properties": {
				"url": {"type": "string", "description": "URL to navigate to (http or https only)"}
			},
			"required": ["url"]
		}`,
		Dangerous: false,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				URL string `json:"url"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			parsed, err := url.Parse(p.URL)
			if err != nil {
				return "", fmt.Errorf("invalid URL: %w", err)
			}
			if parsed.Scheme != "http" && parsed.Scheme != "https" {
				return "", fmt.Errorf("only http and https URLs are allowed, got scheme: %s", parsed.Scheme)
			}
			b := globalBrowser.getBrowser()
			page := b.MustPage(p.URL)
			page.MustWaitLoad()
			globalBrowser.mu.Lock()
			globalBrowser.page = page
			globalBrowser.mu.Unlock()
			return "ok", nil
		},
	})

	r.Register(&ToolDef{
		Name:        "browser_click",
		Description: "Click an element in the browser",
		Schema: `{
			"type": "object",
			"properties": {
				"selector": {"type": "string", "description": "CSS selector of the element to click"}
			},
			"required": ["selector"]
		}`,
		Dangerous: false,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Selector string `json:"selector"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			page, err := globalBrowser.getPage()
			if err != nil {
				return "", err
			}
			el := page.MustElement(p.Selector)
			el.MustClick()
			return "ok", nil
		},
	})

	r.Register(&ToolDef{
		Name:        "browser_type",
		Description: "Type text into an element in the browser",
		Schema: `{
			"type": "object",
			"properties": {
				"selector": {"type": "string", "description": "CSS selector of the element"},
				"text": {"type": "string", "description": "Text to type"}
			},
			"required": ["selector", "text"]
		}`,
		Dangerous: false,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Selector string `json:"selector"`
				Text     string `json:"text"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			page, err := globalBrowser.getPage()
			if err != nil {
				return "", err
			}
			el := page.MustElement(p.Selector)
			el.MustInput(p.Text)
			return "ok", nil
		},
	})

	r.Register(&ToolDef{
		Name:        "browser_get_text",
		Description: "Get the text content of an element in the browser",
		Schema: `{
			"type": "object",
			"properties": {
				"selector": {"type": "string", "description": "CSS selector of the element"}
			},
			"required": ["selector"]
		}`,
		Dangerous: false,
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Selector string `json:"selector"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return "", err
			}
			page, err := globalBrowser.getPage()
			if err != nil {
				return "", err
			}
			el := page.MustElement(p.Selector)
			return el.MustText(), nil
		},
	})

	r.Register(&ToolDef{
		Name:        "browser_screenshot",
		Description: "Take a screenshot of the current browser page",
		Schema: `{
			"type": "object",
			"properties": {},
			"required": []
		}`,
		Dangerous: false,
		Handler: func(args json.RawMessage) (string, error) {
			page, err := globalBrowser.getPage()
			if err != nil {
				return "", err
			}
			img := page.MustScreenshot()
			b64 := base64.StdEncoding.EncodeToString(img)
			return fmt.Sprintf("[BROWSER_SCREENSHOT:%d:%s]", len(img), b64), nil
		},
	})

	r.Register(&ToolDef{
		Name:        "browser_close",
		Description: "Close the browser instance",
		Schema: `{
			"type": "object",
			"properties": {},
			"required": []
		}`,
		Dangerous: false,
		Handler: func(args json.RawMessage) (string, error) {
			globalBrowser.close()
			return "ok", nil
		},
	})

}
