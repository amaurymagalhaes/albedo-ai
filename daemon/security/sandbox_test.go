package security

import (
	"os"
	"testing"

	pb "albedo-ai/daemon/proto"
	"github.com/stretchr/testify/assert"
)

func TestBlockedCommandIsRejected(t *testing.T) {
	s := NewSandbox()
	err := s.Validate(&pb.ToolRequest{
		ToolName:      "run_command",
		ArgumentsJson: `{"command":"rm -rf /"}`,
	})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "blocked command")
}

func TestDangerousCommandSetsConfirmation(t *testing.T) {
	s := NewSandbox()
	req := &pb.ToolRequest{
		ToolName:      "run_command",
		ArgumentsJson: `{"command":"rm -f /tmp/foo.txt"}`,
	}
	err := s.Validate(req)
	assert.NoError(t, err)
	assert.True(t, req.RequiresConfirmation)
}

func TestPathOutsideAllowlistRejected(t *testing.T) {
	s := NewSandbox()
	err := s.ValidatePath("/etc/shadow", false)
	assert.Error(t, err)
}

func TestPathInsideAllowlistAccepted(t *testing.T) {
	s := NewSandbox()
	err := s.ValidatePath("/tmp/test.txt", true)
	assert.NoError(t, err)
}

func TestSafeCommandPasses(t *testing.T) {
	s := NewSandbox()
	req := &pb.ToolRequest{
		ToolName:      "run_command",
		ArgumentsJson: `{"command":"ls -la"}`,
	}
	err := s.Validate(req)
	assert.NoError(t, err)
	assert.False(t, req.RequiresConfirmation)
}

func TestReadFileInsideHome(t *testing.T) {
	s := NewSandbox()
	home, _ := os.UserHomeDir()
	err := s.ValidatePath(home+"/somefile.txt", false)
	assert.NoError(t, err)
}

func TestWriteFileOutsideWritePaths(t *testing.T) {
	s := NewSandbox()
	err := s.ValidatePath("/usr/share/test.txt", true)
	assert.Error(t, err)
}
