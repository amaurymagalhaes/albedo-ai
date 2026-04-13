package awareness

import (
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCollectorSnapshotIsComplete(t *testing.T) {
	if os.Getenv("DISPLAY") == "" {
		t.Skip("requires display")
	}
	c := NewCollector()
	c.Start()
	defer c.Stop()
	time.Sleep(4 * time.Second)
	snap, err := c.Snapshot()
	require.NoError(t, err)
	assert.NotNil(t, snap.Metrics)
	assert.Greater(t, snap.TimestampMs, uint64(0))
	assert.GreaterOrEqual(t, snap.Metrics.CpuPercent+snap.Metrics.RamPercent, float32(0))
}

func TestCollectorStopDoesNotPanic(t *testing.T) {
	c := NewCollector()
	c.Start()
	time.Sleep(500 * time.Millisecond)
	c.Stop()
}

func TestClipboardMonitorRead(t *testing.T) {
	cm := NewClipboardMonitor()
	content, changed, err := cm.Read()
	assert.NoError(t, err)
	_ = content
	_ = changed
}
