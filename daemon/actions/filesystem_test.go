package actions

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	pb "albedo-ai/daemon/proto"
	"github.com/stretchr/testify/assert"
)

func TestReadFileTool(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "test.txt")
	os.WriteFile(path, []byte("hello world"), 0644)
	r := NewRegistry()
	RegisterFilesystemTools(r)
	resp, _ := r.Execute(&pb.ToolRequest{
		ToolName:      "read_file",
		ArgumentsJson: fmt.Sprintf(`{"path":%q}`, path),
	})
	assert.True(t, resp.Success)
	assert.Equal(t, "hello world", resp.Result)
}

func TestWriteFileTool(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "output.txt")
	r := NewRegistry()
	RegisterFilesystemTools(r)
	resp, _ := r.Execute(&pb.ToolRequest{
		ToolName:      "write_file",
		ArgumentsJson: fmt.Sprintf(`{"path":%q,"content":"test content"}`, path),
	})
	assert.True(t, resp.Success)
	data, _ := os.ReadFile(path)
	assert.Equal(t, "test content", string(data))
}

func TestListDirTool(t *testing.T) {
	tmp := t.TempDir()
	os.WriteFile(filepath.Join(tmp, "a.txt"), nil, 0644)
	os.Mkdir(filepath.Join(tmp, "subdir"), 0755)
	r := NewRegistry()
	RegisterFilesystemTools(r)
	resp, _ := r.Execute(&pb.ToolRequest{
		ToolName:      "list_dir",
		ArgumentsJson: fmt.Sprintf(`{"path":%q}`, tmp),
	})
	assert.True(t, resp.Success)
	assert.Contains(t, resp.Result, "a.txt")
	assert.Contains(t, resp.Result, "subdir")
}

func TestDeleteFileTool(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "todelete.txt")
	os.WriteFile(path, []byte("bye"), 0644)
	r := NewRegistry()
	RegisterFilesystemTools(r)
	resp, _ := r.Execute(&pb.ToolRequest{
		ToolName:      "delete_file",
		ArgumentsJson: fmt.Sprintf(`{"path":%q}`, path),
	})
	assert.True(t, resp.Success)
	_, err := os.Stat(path)
	assert.True(t, os.IsNotExist(err))
}
