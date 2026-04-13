package awareness

import (
	"sync"

	"github.com/atotto/clipboard"
)

type ClipboardMonitor struct {
	last string
	mu   sync.Mutex
}

func NewClipboardMonitor() *ClipboardMonitor {
	return &ClipboardMonitor{}
}

func (c *ClipboardMonitor) Read() (string, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	content, err := clipboard.ReadAll()
	if err != nil {
		return "", false, nil
	}

	changed := content != c.last
	c.last = content
	return content, changed, nil
}
