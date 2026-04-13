package actions

import (
	"encoding/json"
	"testing"

	pb "albedo-ai/daemon/proto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRegisterAndExecuteTool(t *testing.T) {
	r := NewRegistry()
	r.Register(&ToolDef{
		Name: "echo_tool",
		Handler: func(args json.RawMessage) (string, error) {
			var p struct {
				Msg string `json:"msg"`
			}
			json.Unmarshal(args, &p)
			return p.Msg, nil
		},
	})
	resp, err := r.Execute(&pb.ToolRequest{
		ToolName:      "echo_tool",
		ArgumentsJson: `{"msg":"hello"}`,
	})
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, "hello", resp.Result)
}

func TestExecuteUnknownToolReturnsError(t *testing.T) {
	r := NewRegistry()
	resp, err := r.Execute(&pb.ToolRequest{ToolName: "nonexistent"})
	require.NoError(t, err)
	assert.False(t, resp.Success)
	assert.Contains(t, resp.Error, "unknown tool")
}

func TestRegistryListSorted(t *testing.T) {
	r := NewRegistry()
	r.Register(&ToolDef{Name: "zebra_tool", Schema: "{}"})
	r.Register(&ToolDef{Name: "alpha_tool", Schema: "{}"})
	list := r.List()
	require.Len(t, list.Tools, 2)
	assert.Equal(t, "alpha_tool", list.Tools[0].Name)
	assert.Equal(t, "zebra_tool", list.Tools[1].Name)
}

func TestRegisterOverwritesExisting(t *testing.T) {
	r := NewRegistry()
	r.Register(&ToolDef{
		Name:    "my_tool",
		Handler: func(args json.RawMessage) (string, error) { return "v1", nil },
	})
	r.Register(&ToolDef{
		Name:    "my_tool",
		Handler: func(args json.RawMessage) (string, error) { return "v2", nil },
	})
	resp, _ := r.Execute(&pb.ToolRequest{ToolName: "my_tool"})
	assert.Equal(t, "v2", resp.Result)
}
