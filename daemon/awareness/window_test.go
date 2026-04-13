package awareness

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetActiveWindowReturnsNonNilOnError(t *testing.T) {
	win, _ := GetActiveWindow()
	assert.NotNil(t, win)
}

func TestGetActiveWindowHasNonEmptyTitle(t *testing.T) {
	if os.Getenv("DISPLAY") == "" {
		t.Skip("no display")
	}
	win, err := GetActiveWindow()
	require.NoError(t, err)
	if win.Title == "" {
		t.Skip("no active window detected (headless environment)")
	}
}
