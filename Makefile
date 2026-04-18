.PHONY: all dev build-rust build-go build-bun proto clean test-integration

RUST_BINARY   = audio-engine/target/release/albedo-audio
GO_BINARY     = daemon/cmd/albedo-daemon/albedo-daemon
BIN_DIR       = bin

PROTO_DIR     = proto
GO_PROTO_OUT  = daemon/proto
TS_PROTO_OUT  = src/bun/rpc/generated

PROTO_GEN_TS  = node_modules/.bin/protoc-gen-ts
PROTO_GEN_GO  = $(HOME)/go/bin/protoc-gen-go
PROTO_GEN_GO_GRPC = $(HOME)/go/bin/protoc-gen-go-grpc

# ─── Default: build everything ──────────────────────────────────────────────

all: proto build-rust build-go bun-run-build

# ─── Protobuf codegen ────────────────────────────────────────────────────────

proto: $(GO_PROTO_OUT) $(TS_PROTO_OUT)
	@echo "==> Generating Go protobuf code..."
	protoc \
		--proto_path=$(PROTO_DIR) \
		--plugin=protoc-gen-go=$(PROTO_GEN_GO) \
		--plugin=protoc-gen-go-grpc=$(PROTO_GEN_GO_GRPC) \
		--go_out=$(GO_PROTO_OUT) \
		--go_opt=paths=source_relative \
		--go-grpc_out=$(GO_PROTO_OUT) \
		--go-grpc_opt=paths=source_relative \
		$(PROTO_DIR)/daemon.proto
	@echo "==> Generating TypeScript protobuf stubs..."
	mkdir -p $(TS_PROTO_OUT)
	protoc \
		--plugin=protoc-gen-ts=$(PROTO_GEN_TS) \
		--ts_out=$(TS_PROTO_OUT) \
		--ts_opt=long_type_string,server_none \
		--proto_path=$(PROTO_DIR) \
		$(PROTO_DIR)/audio.proto \
		$(PROTO_DIR)/daemon.proto
	@echo "==> proto done."

$(GO_PROTO_OUT):
	mkdir -p $(GO_PROTO_OUT)

$(TS_PROTO_OUT):
	mkdir -p $(TS_PROTO_OUT)

# ─── Rust Audio Engine ───────────────────────────────────────────────────────

build-rust:
	@echo "==> Building Rust audio engine..."
	cd audio-engine && cargo build --release
	mkdir -p $(BIN_DIR)
	cp $(RUST_BINARY) $(BIN_DIR)/albedo-audio
	@echo "==> albedo-audio built."

# ─── Go Daemon ───────────────────────────────────────────────────────────────

build-go:
	@echo "==> Building Go daemon..."
	cd daemon && go build -o cmd/albedo-daemon/albedo-daemon ./cmd/albedo-daemon
	mkdir -p $(BIN_DIR)
	cp $(GO_BINARY) $(BIN_DIR)/albedo-daemon
	@echo "==> albedo-daemon built."

# ─── Electrobun / Bun ────────────────────────────────────────────────────────

build-bun:
	@echo "==> Patching Electrobun..."
	bash scripts/patch-electrobun.sh
	@echo "==> Building Electrobun app..."
	bun run build
	@echo "==> Electrobun build done."

# ─── Dev mode ────────────────────────────────────────────────────────────────

dev:
	@echo "==> Stopping existing processes..."
	@killall -9 albedo-audio albedo-daemon 2>/dev/null || true
	@for i in 1 2 3 4 5; do lsof $(BIN_DIR)/albedo-daemon 2>/dev/null || break; sleep 0.5; done
	@rm -f /tmp/albedo-audio.sock /tmp/albedo-daemon.sock
	@echo "==> Building..."
	$(MAKE) build-rust build-go bun-run-build
	@if ! curl -s -o /dev/null -w '%%{http_code}' -X POST http://localhost:9880/synthesize -H 'Content-Type: application/json' -d '{"text":"t","speed":1.0}' 2>/dev/null | grep -q 200; then \
		echo "==> Starting TTS server..."; \
		ELEVENLABS_API_KEY=$$(grep ELEVENLABS_API_KEY .env | cut -d= -f2) setsid python3 scripts/tts/server.py --port 9880 > /tmp/albedo-tts.log 2>&1 & \
		sleep 3; \
	fi
	@echo "==> Starting Electrobun dev server..."
	bun run dev; EXIT=$$?; \
	killall -9 albedo-audio albedo-daemon 2>/dev/null || true; \
	rm -f /tmp/albedo-audio.sock /tmp/albedo-daemon.sock; \
	exit $$EXIT

bun-run-build:
	bun run build

# ─── Clean ───────────────────────────────────────────────────────────────────

clean:
	@echo "==> Cleaning build artefacts..."
	rm -rf $(BIN_DIR)
	cd audio-engine && cargo clean
	rm -f $(GO_BINARY)
	rm -rf $(GO_PROTO_OUT)/*.pb.go
	rm -rf $(TS_PROTO_OUT)
	@echo "==> Clean done."

test-integration: build-rust build-go
	@echo "==> Starting native processes for integration test..."
	$(BIN_DIR)/albedo-audio &
	AUDIO_PID=$$!; \
	$(BIN_DIR)/albedo-daemon & \
	DAEMON_PID=$$!; \
	sleep 2; \
	bun run scripts/integration-test.ts; \
	EXIT_CODE=$$?; \
	kill $$AUDIO_PID $$DAEMON_PID 2>/dev/null; \
	rm -f /tmp/albedo-audio.sock /tmp/albedo-daemon.sock; \
	exit $$EXIT_CODE
