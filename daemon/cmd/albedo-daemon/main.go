package main

import (
	"log"
	"net"
	"os"

	pb "albedo-ai/daemon/proto"
	"google.golang.org/grpc"
)

type server struct {
	pb.UnimplementedDaemonServer
}

func main() {
	socketPath := "/tmp/albedo-daemon.sock"
	os.Remove(socketPath)

	lis, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatalf("failed to listen: %v", err)
	}

	grpcServer := grpc.NewServer()
	pb.RegisterDaemonServer(grpcServer, &server{})

	log.Printf("[albedo-daemon] scaffold placeholder — implement in Phase 5")
	log.Printf("[albedo-daemon] listening on %s", socketPath)
	if err := grpcServer.Serve(lis); err != nil {
		log.Fatalf("failed to serve: %v", err)
	}
}
