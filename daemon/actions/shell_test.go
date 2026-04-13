package actions

import (
	"testing"

	pb "albedo-ai/daemon/proto"
	"github.com/stretchr/testify/assert"
)

func TestRunCommandCapturesOutput(t *testing.T) {
	r := NewRegistry()
	RegisterShellTools(r)
	resp, _ := r.Execute(&pb.ToolRequest{
		ToolName:      "run_command",
		ArgumentsJson: `{"command":"echo hello-daemon"}`,
	})
	assert.True(t, resp.Success)
	assert.Contains(t, resp.Result, "hello-daemon")
}

func TestRunCommandTimesOut(t *testing.T) {
	r := NewRegistry()
	RegisterShellTools(r)
	resp, _ := r.Execute(&pb.ToolRequest{
		ToolName:      "run_command",
		ArgumentsJson: `{"command":"while true; do :; done","timeout_seconds":1}`,
	})
	assert.Contains(t, resp.Result, "TIMEOUT")
}
