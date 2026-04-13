package main

import (
	"context"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"albedo-ai/daemon/actions"
	"albedo-ai/daemon/awareness"
	pb "albedo-ai/daemon/proto"
	"albedo-ai/daemon/security"
	"google.golang.org/grpc"
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
				log.Printf("awareness snapshot error: %v", err)
				continue
			}
			if !config.IncludeClipboard {
				snapshot.ClipboardContent = ""
			}
			if config.IncludeScreenOcr {
				log.Println("[albedo-daemon] OCR not yet implemented (Phase 6)")
			}
			if err := stream.Send(snapshot); err != nil {
				return err
			}
		case <-stream.Context().Done():
			return nil
		}
	}
}

func (s *daemonServer) CaptureScreen(
	ctx context.Context,
	req *pb.ScreenCaptureRequest,
) (*pb.ScreenCaptureResponse, error) {
	return s.collector.CaptureScreen(req)
}

func (s *daemonServer) ExecuteTool(
	ctx context.Context,
	req *pb.ToolRequest,
) (*pb.ToolResponse, error) {
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
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	socketPath := "/tmp/albedo-daemon.sock"
	os.Remove(socketPath)

	lis, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatalf("[albedo-daemon] listen: %v", err)
	}

	collector := awareness.NewCollector()
	collector.Start()

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

	go func() {
		<-ctx.Done()
		log.Println("[albedo-daemon] Shutting down gracefully...")
		grpcServer.GracefulStop()
		collector.Stop()
		os.Remove(socketPath)
	}()

	log.Printf("[albedo-daemon] Listening on %s", socketPath)
	grpcServer.Serve(lis)
}
