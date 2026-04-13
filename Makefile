.PHONY: all dev build-rust build-go build-bun proto clean

RUST_BINARY   = audio-engine/target/release/albedo-audio
GO_BINARY     = daemon/cmd/albedo-daemon/albedo-daemon
BIN_DIR       = bin

PROTO_DIR     = proto
GO_PROTO_OUT  = daemon/proto
TS_PROTO_OUT  = src/bun/rpc/generated

PROTO_GEN_TS  = node_modules/.bin/protoc-gen-ts

# ─── Default: build everything ──────────────────────────────────────────────

all: proto build-rust build-go build-bun

# ─── Protobuf codegen ────────────────────────────────────────────────────────

proto: $(GO_PROTO_OUT) $(TS_PROTO_OUT)
	@echo "==> Generating Go protobuf code..."
	protoc \
		--proto_path=$(PROTO_DIR) \
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
	@echo "==> Building Electrobun app..."
	bun run build
	@echo "==> Electrobun build done."

# ─── Dev mode ────────────────────────────────────────────────────────────────

dev: build-rust build-go
	@echo "==> Starting native processes..."
	$(BIN_DIR)/albedo-audio &
	$(BIN_DIR)/albedo-daemon &
	@echo "==> Starting Electrobun dev server..."
	bun run dev

# ─── Clean ───────────────────────────────────────────────────────────────────

clean:
	@echo "==> Cleaning build artefacts..."
	rm -rf $(BIN_DIR)
	cd audio-engine && cargo clean
	rm -f $(GO_BINARY)
	rm -rf $(GO_PROTO_OUT)/*.pb.go
	rm -rf $(TS_PROTO_OUT)
	@echo "==> Clean done."
