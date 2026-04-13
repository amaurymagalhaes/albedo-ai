package awareness

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCollectMetricsReturnsValidRanges(t *testing.T) {
	m, err := CollectMetrics()
	require.NoError(t, err)
	assert.GreaterOrEqual(t, m.CPUPercent, float32(0))
	assert.LessOrEqual(t, m.CPUPercent, float32(100))
	assert.GreaterOrEqual(t, m.RAMPercent, float32(0))
	assert.LessOrEqual(t, m.RAMPercent, float32(100))
	assert.GreaterOrEqual(t, m.DiskPercent, float32(0))
	assert.LessOrEqual(t, m.DiskPercent, float32(100))
}

func TestTopProcessesNonEmpty(t *testing.T) {
	m, err := CollectMetrics()
	require.NoError(t, err)
	assert.NotEmpty(t, m.TopProcesses)
}
