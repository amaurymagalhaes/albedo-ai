#!/bin/bash
# Captures make dev output with timestamps to a log file
# Usage: ./scripts/log-capture.sh [log_name]
#
# Log files go to logs/ directory with format:
#   YYYY-MM-DD_HH-MM-SS_<name>.log
#
# The log file path is printed so tools can read it.

LOGDIR="$(cd "$(dirname "$0")/.." && pwd)/logs"
mkdir -p "$LOGDIR"

NAME="${1:-session}"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
LOGFILE="$LOGDIR/${TIMESTAMP}_${NAME}.log"

# Clean old logs (keep last 20)
ls -t "$LOGDIR"/*.log 2>/dev/null | tail -n +21 | xargs -r rm

echo "Logs saving to: $LOGFILE"
echo "$LOGFILE" > "$LOGDIR/.latest"

# Run make dev with timestamps
# Each line gets [YYYY-MM-DD HH:MM:SS.mmm] prefix
make dev 2>&1 | while IFS= read -r line; do
    ts=$(date '+%Y-%m-%d %H:%M:%S.%3N')
    echo "[$ts] $line" | tee -a "$LOGFILE"
done
