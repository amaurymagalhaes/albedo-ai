package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"

	"albedo-ai/daemon/actions"
	"albedo-ai/daemon/awareness"
	pb "albedo-ai/daemon/proto"
	"albedo-ai/daemon/security"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type daemonServer struct {
	pb.UnimplementedDaemonServer
	collector *awareness.Collector
	tools     *actions.Registry
	sandbox   *security.Sandbox
}

func (s *daemonServer) GetAwareness(ctx context.Context, _ *pb.Empty) (*pb.AwarenessSnapshot, error) {
	return s.collector.Snapshot()
}

func (s *daemonServer) StreamAwareness(
	config *pb.AwarenessConfig,
	stream pb.Daemon_StreamAwarenessServer,
) error {
	interval := time.Duration(config.IntervalMs) * time.Millisecond
	if interval < 500*time.Millisecond {
		interval = 500 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			snapshot, err := s.collector.Snapshot()
			if err != nil {
				continue
			}
			if !config.IncludeClipboard {
				snapshot.ClipboardContent = ""
			}
			if err := stream.Send(snapshot); err != nil {
				return err
			}
		case <-stream.Context().Done():
			return nil
		}
	}
}

func (s *daemonServer) CaptureScreen(ctx context.Context, req *pb.ScreenCaptureRequest) (*pb.ScreenCaptureResponse, error) {
	return s.collector.CaptureScreen(req)
}

func (s *daemonServer) ExecuteTool(ctx context.Context, req *pb.ToolRequest) (*pb.ToolResponse, error) {
	if err := s.sandbox.Validate(req); err != nil {
		return &pb.ToolResponse{Success: false, Error: err.Error()}, nil
	}
	if req.RequiresConfirmation {
		return &pb.ToolResponse{
			Success: false,
			Error:   "tool requires user confirmation; confirmation flow not yet implemented",
		}, nil
	}
	return s.tools.Execute(req)
}

func (s *daemonServer) ListTools(ctx context.Context, _ *pb.Empty) (*pb.ToolList, error) {
	return s.tools.List(), nil
}

func main() {
	socketPath := "/tmp/albedo-daemon-smoke.sock"
	os.Remove(socketPath)

	passed := 0
	failed := 0

	check := func(name string, ok bool, detail string) {
		if ok {
			passed++
			fmt.Printf("  PASS  %s\n", name)
		} else {
			failed++
			fmt.Printf("  FAIL  %s — %s\n", name, detail)
		}
	}

	collector := awareness.NewCollector()
	collector.Start()
	defer collector.Stop()

	registry := actions.NewRegistry()
	actions.RegisterDefaults(registry)
	actions.RegisterFilesystemTools(registry)
	actions.RegisterShellTools(registry)
	actions.RegisterAutomationTools(registry)
	actions.RegisterBrowserTools(registry)
	actions.RegisterAppctlTools(registry)
	actions.RegisterNotificationTools(registry)

	sandbox := security.NewSandbox()

	grpcServer := grpc.NewServer(
		grpc.MaxRecvMsgSize(64*1024*1024),
		grpc.MaxSendMsgSize(64*1024*1024),
	)
	pb.RegisterDaemonServer(grpcServer, &daemonServer{
		collector: collector,
		tools:     registry,
		sandbox:   sandbox,
	})

	lis, err := net.Listen("unix", socketPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen: %v\n", err)
		os.Exit(1)
	}
	go grpcServer.Serve(lis)
	defer grpcServer.Stop()

	time.Sleep(500 * time.Millisecond)

	conn, err := grpc.NewClient("unix://"+socketPath, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		fmt.Fprintf(os.Stderr, "dial: %v\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	client := pb.NewDaemonClient(conn)
	ctx := context.Background()

	fmt.Println("\n=== Phase 5 Smoke Tests ===\n")

	{
		fmt.Println("[Criterion 4: GetAwareness]")
		resp, err := client.GetAwareness(ctx, &pb.Empty{})
		check("returns without error", err == nil, fmt.Sprintf("%v", err))
		if err == nil {
			check("timestampMs > 0", resp.TimestampMs > 0, fmt.Sprintf("got %d", resp.TimestampMs))
			check("has Metrics", resp.Metrics != nil, "nil metrics")
			check("has ActiveWindow", resp.ActiveWindow != nil, "nil active window")
		}
	}

	{
		fmt.Println("\n[Criterion 5: StreamAwareness]")
		stream, err := client.StreamAwareness(ctx, &pb.AwarenessConfig{
			IntervalMs: 1000,
		})
		check("stream opens without error", err == nil, fmt.Sprintf("%v", err))
		if err == nil {
			count := 0
			for i := 0; i < 3; i++ {
				snap, err := stream.Recv()
				if err == io.EOF {
					break
				}
				if err != nil {
					break
				}
				if snap.TimestampMs > 0 {
					count++
				}
			}
			check("receives 3+ snapshots with timestampMs > 0", count >= 3, fmt.Sprintf("got %d", count))
			stream.CloseSend()
		}
	}

	{
		fmt.Println("\n[Criterion 6: ListTools]")
		resp, err := client.ListTools(ctx, &pb.Empty{})
		check("returns without error", err == nil, fmt.Sprintf("%v", err))
		if err == nil {
			check("returns 5+ tools", len(resp.Tools) >= 5, fmt.Sprintf("got %d", len(resp.Tools)))
			names := map[string]bool{}
			for _, t := range resp.Tools {
				names[t.Name] = true
			}
			check("includes read_file", names["read_file"], "")
			check("includes run_command", names["run_command"], "")
			check("includes open_app", names["open_app"], "")
			check("includes type_text", names["type_text"], "")
			check("includes screenshot", names["screenshot"], "")
		}
	}

	{
		fmt.Println("\n[Criterion 7: ExecuteTool run_command echo ok]")
		resp, err := client.ExecuteTool(ctx, &pb.ToolRequest{
			ToolName:      "run_command",
			ArgumentsJson: `{"command":"echo ok"}`,
		})
		check("returns without gRPC error", err == nil, fmt.Sprintf("%v", err))
		if err == nil {
			check("success is true", resp.Success, fmt.Sprintf("error: %s", resp.Error))
			check("result contains 'ok'", resp.Success && strings.Contains(resp.Result, "ok"), fmt.Sprintf("got %q", resp.Result))
		}
	}

	{
		fmt.Println("\n[Criterion 8: ExecuteTool run_command rm -rf / blocked]")
		resp, err := client.ExecuteTool(ctx, &pb.ToolRequest{
			ToolName:      "run_command",
			ArgumentsJson: `{"command":"rm -rf /"}`,
		})
		check("returns without gRPC error", err == nil, fmt.Sprintf("%v", err))
		if err == nil {
			check("success is false", !resp.Success, "expected failure")
			check("error mentions 'blocked command'", strings.Contains(resp.Error, "blocked command"), fmt.Sprintf("got %q", resp.Error))
		}
	}

	{
		fmt.Println("\n[Extra: ExecuteTool read_file]")
		tmpFile := "/tmp/albedo-smoke-test.txt"
		os.WriteFile(tmpFile, []byte("hello from smoke test"), 0644)
		resp, err := client.ExecuteTool(ctx, &pb.ToolRequest{
			ToolName:      "read_file",
			ArgumentsJson: fmt.Sprintf(`{"path":%q}`, tmpFile),
		})
		check("read_file succeeds", err == nil && resp.Success, fmt.Sprintf("err=%v resp.Error=%s", err, resp.Error))
		if resp.Success {
			check("read_file returns correct content", resp.Result == "hello from smoke test", fmt.Sprintf("got %q", resp.Result))
		}
		os.Remove(tmpFile)
	}

	fmt.Printf("\n=== Results: %d passed, %d failed ===\n", passed, failed)
	if failed > 0 {
		os.Exit(1)
	}
}
