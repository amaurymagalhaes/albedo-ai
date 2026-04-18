#!/bin/bash
# Analyze an Albedo AI session log
# Usage: ./analyze.sh [latest | session-file.log]
#
# Outputs a summary of key metrics.

LOGDIR="$HOME/.config/albedo-ai/logs"

if [ "$1" = "latest" ] || [ -z "$1" ]; then
    LOGFILE=$(ls -t "$LOGDIR"/session-*.log 2>/dev/null | head -1)
    if [ -z "$LOGFILE" ]; then
        echo "No session logs found in $LOGDIR"
        exit 1
    fi
else
    LOGFILE="$LOGDIR/$1"
fi

if [ ! -f "$LOGFILE" ]; then
    echo "Log file not found: $LOGFILE"
    exit 1
fi

echo "=== Analyzing: $(basename "$LOGFILE") ==="
echo ""

python3 -c "
import json, sys
from datetime import datetime

events = []
with open('$LOGFILE') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except:
            pass

if not events:
    print('No events found.')
    sys.exit(0)

# Session info
start = events[0].get('ts', '?')
end = events[-1].get('ts', '?')
print(f'Session: {start} → {end}')
print(f'Total events: {len(events)}')
print()

# Count events by type
from collections import Counter
counts = Counter(e.get('event','?') for e in events)
print('Event counts:')
for ev, count in counts.most_common():
    print(f'  {ev}: {count}')
print()

# Voice-to-voice latency
ptt_stops = [e for e in events if e.get('event') == 'ptt_stop' and e.get('phase') == 'transcribed']
utterance_starts = [e for e in events if e.get('event') == 'utterance_start']
llm_dones = [e for e in events if e.get('event') == 'llm_done']
utterance_dones = [e for e in events if e.get('event') == 'utterance_done']
ptt_skips = [e for e in events if e.get('event') == 'ptt_skip']
set_muteds = [e for e in events if e.get('event') == 'set_muted']

# PTT interactions
ptt_unmutes = [e for e in set_muteds if e.get('muted') == False]
ptt_mutes = [e for e in set_muteds if e.get('muted') == True]
print(f'PTT interactions: {len(ptt_unmutes)} unmute, {len(ptt_mutes)} mute')
print()

# Latency breakdown
if ptt_stops:
    print('=== Latency Breakdown ===')
    for e in ptt_stops:
        ts = e.get('ts','?')
        text = e.get('text','')[:60]
        whisper_ms = e.get('whisperMs', '?')
        print(f'  [{ts}] Whisper: {whisper_ms}ms | \"{text}\"')
    print()

if llm_dones:
    print('=== LLM Performance ===')
    for e in llm_dones:
        ts = e.get('ts','?')
        first_token = e.get('firstTokenMs', '?')
        first_speak = e.get('firstSpeakMs', '?')
        total = e.get('totalLlmMs', '?')
        resp_len = e.get('responseLen', '?')
        flag = ' ⚠️ SLOW' if isinstance(first_token, (int,float)) and first_token > 3000 else ''
        print(f'  [{ts}] first_token={first_token}ms first_speak={first_speak}ms total={total}ms resp_len={resp_len}{flag}')
    print()

# Compute voice-to-voice (ptt_stop transcribed → first tts_enqueue or llm_done firstSpeak)
if ptt_stops and llm_dones:
    print('=== Voice-to-Voice (PTT release → first audio) ===')
    for i, stop in enumerate(ptt_stops):
        stop_ts = stop.get('ts','')
        # Find matching llm_done (closest after this stop)
        matching_llm = None
        for llm in llm_dones:
            if llm.get('ts','') > stop_ts:
                matching_llm = llm
                break
        if matching_llm:
            try:
                t1 = datetime.fromisoformat(stop_ts.replace('Z','+00:00'))
                t2 = datetime.fromisoformat(matching_llm.get('ts','').replace('Z','+00:00'))
                total_ms = (t2 - t1).total_seconds() * 1000 + matching_llm.get('firstSpeakMs', 0)
                flag = ' ⚠️ OVER 1s' if total_ms > 1000 else ' ✅'
                print(f'  [{stop_ts}] → {total_ms:.0f}ms total{flag}')
            except:
                print(f'  [{stop_ts}] → (could not compute)')
    print()

# Queue stacking
if utterance_starts:
    max_queue = max(e.get('queueLen', 0) for e in utterance_starts)
    stacked = [e for e in utterance_starts if e.get('queueLen', 0) > 0]
    print(f'=== Queue Analysis ===')
    print(f'  Max queue depth: {max_queue}')
    print(f'  Utterances that had to queue: {len(stacked)}/{len(utterance_starts)}')
    if stacked:
        for e in stacked:
            print(f'  ⚠️ [{e.get(\"ts\",\"?\")}] queue={e.get(\"queueLen\")} | \"{e.get(\"transcript\",\"\")[:60]}\"')
    print()

# Hallucination rate
total_transcriptions = len(ptt_stops) + len(ptt_skips)
if total_transcriptions > 0:
    skip_rate = len(ptt_skips) / total_transcriptions * 100
    print(f'=== Hallucination Filter ===')
    print(f'  Accepted: {len(ptt_stops)}, Rejected: {len(ptt_skips)} ({skip_rate:.0f}%)')
    for e in ptt_skips:
        print(f'  ❌ [{e.get(\"ts\",\"?\")}] \"{e.get(\"text\",\"\")[:60]}\" → {e.get(\"reason\",\"?\")}')
    print()

# Errors
errors = [e for e in events if 'error' in e.get('event','')]
if errors:
    print(f'=== Errors ({len(errors)}) ===')
    for e in errors:
        print(f'  ❌ [{e.get(\"ts\",\"?\")}] {e.get(\"event\")}: {e.get(\"error\",\"\")}')
    print()

# Summary
print('=== Summary ===')
if llm_dones:
    avg_first_token = sum(e.get('firstTokenMs',0) for e in llm_dones) / len(llm_dones)
    avg_total_llm = sum(e.get('totalLlmMs',0) for e in llm_dones) / len(llm_dones)
    print(f'  Avg LLM first token: {avg_first_token:.0f}ms')
    print(f'  Avg LLM total: {avg_total_llm:.0f}ms')
if ptt_stops:
    avg_whisper = sum(e.get('whisperMs',0) for e in ptt_stops if isinstance(e.get('whisperMs'), (int,float))) / max(1, len([e for e in ptt_stops if isinstance(e.get('whisperMs'), (int,float))]))
    print(f'  Avg Whisper: {avg_whisper:.0f}ms')
print(f'  Total interactions: {len(ptt_unmutes)}')
print(f'  Hallucination rate: {len(ptt_skips)}/{total_transcriptions} ({len(ptt_skips)/max(1,total_transcriptions)*100:.0f}%)')
"
