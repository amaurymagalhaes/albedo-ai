#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[setup]${NC} $*"; }
ok()    { echo -e "${GREEN}[ok]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $*"; }
die()   { echo -e "${RED}[error]${NC} $*"; exit 1; }

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# ─── 1. .env ─────────────────────────────────────────────────────────────────

if [ ! -f .env ]; then
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then
    echo "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" > .env
    ok "Created .env from environment variable"
  else
    warn "No OPENROUTER_API_KEY found."
    echo -n "Enter your OpenRouter API key: "
    read -r API_KEY
    [ -z "$API_KEY" ] && die "API key is required."
    echo "OPENROUTER_API_KEY=$API_KEY" > .env
    ok "Saved .env"
  fi
else
  ok ".env already exists"
fi

# ─── 2. Tool checks ──────────────────────────────────────────────────────────

for cmd in bun cargo go protoc; do
  command -v "$cmd" &>/dev/null || die "Missing '$cmd'. Install it first."
done
ok "All required tools found (bun, cargo, go, protoc)"

# ─── 3. Go protobuf plugins ──────────────────────────────────────────────────

if ! command -v protoc-gen-go &>/dev/null; then
  info "Installing protoc-gen-go + protoc-gen-go-grpc..."
  go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
  go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
  ok "Go protobuf plugins installed"
else
  ok "Go protobuf plugins already installed"
fi

# ─── 4. Bun dependencies ─────────────────────────────────────────────────────

info "Installing JS dependencies..."
bun install
ok "JS dependencies installed"

# ─── 5. Model files ──────────────────────────────────────────────────────────

download_if_missing() {
  local path="$1" url="$2" label="$3"
  if [ -f "$path" ]; then
    ok "$label already exists"
  else
    info "Downloading $label..."
    mkdir -p "$(dirname "$path")"
    curl -L --progress-bar -o "$path" "$url"
    [ -f "$path" ] || die "Failed to download $label"
    ok "$label downloaded ($(du -h "$path" | cut -f1))"
  fi
}

download_if_missing \
  "assets/whisper/ggml-base.bin" \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" \
  "Whisper base model"

download_if_missing \
  "assets/vad/silero_vad.onnx" \
  "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx" \
  "Silero VAD model"

# ─── 6. Build ────────────────────────────────────────────────────────────────

info "Building all components..."
make all
ok "All components built"

# ─── 7. Live2D model check ───────────────────────────────────────────────────

if [ -z "$(ls assets/models/ 2>/dev/null)" ]; then
  warn "No Live2D model found in assets/models/"
  warn "The avatar will not render. Place a .model3.json model there."
fi

# ─── 8. Run ──────────────────────────────────────────────────────────────────

info "Starting Albedo AI..."
exec make dev
