#!/bin/bash
# Compare two Albedo AI session logs (before/after analysis)
# Usage: ./compare.sh <old_session.log> <new_session.log>
#
# Shows key metric differences between sessions.

LOGDIR="$HOME/.config/albedo-ai/logs"

if [ -z "$2" ]; then
    echo "Usage: ./compare.sh <old_session.log> <new_session.log>"
    echo "   or: ./compare.sh latest <new_session.log>"
    exit 1
fi

if [ "$1" = "latest" ]; then
    OLD=$(ls -t "$LOGDIR"/session-*.log 2>/dev/null | head -2 | tail -1)
else
    OLD="$LOGDIR/$1"
fi

NEW="$LOGDIR/$2"

if [ ! -f "$OLD" ] || [ ! -f "$NEW" ]; then
    echo "Log files not found."
    echo "  Old: $OLD ($(test -f "$OLD" && echo OK || echo MISSING))"
    echo "  New: $NEW ($(test -f "$NEW" && echo OK || echo MISSING))"
    exit 1
fi

echo "=== Comparing Sessions ==="
echo "  Before: $(basename "$OLD")"
echo "  After:  $(basename "$NEW")"
echo ""

python3 -c "
import json, sys
from datetime import datetime

def parse_session(path):
    events = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try: events.append(json.loads(line))
            except: pass
    return events

def metrics(events):
    m = {}
    llm = [e for e in events if e.get('event') == 'llm_done']
    ptt = [e for e in events if e.get('event') == 'ptt_stop' and e.get('phase') == 'transcribed']
    skips = [e for e in events if e.get('event') == 'ptt_skip']
    utt = [e for e in events if e.get('event') == 'utterance_start']
    dones = [e for e in events if e.get('event') == 'utterance_done']
    errors = [e for e in events if 'error' in e.get('event','')]

    if llm:
        m['avg_first_token_ms'] = sum(e.get('firstTokenMs',0) for e in llm) / len(llm)
        m['max_first_token_ms'] = max(e.get('firstTokenMs',0) for e in llm)
        m['min_first_token_ms'] = min(e.get('firstTokenMs',0) for e in llm)
        m['avg_total_llm_ms'] = sum(e.get('totalLlmMs',0) for e in llm) / len(llm)
        m['llm_count'] = len(llm)

    if ptt:
        whisper_vals = [e.get('whisperMs',0) for e in ptt if isinstance(e.get('whisperMs'), (int,float))]
        if whisper_vals:
            m['avg_whisper_ms'] = sum(whisper_vals) / len(whisper_vals)
            m['max_whisper_ms'] = max(whisper_vals)
            m['min_whisper_ms'] = min(whisper_vals)

    total = len(ptt) + len(skips)
    m['transcriptions'] = len(ptt)
    m['hallucinations'] = len(skips)
    m['hallucination_pct'] = (len(skips) / max(1,total)) * 100

    if utt:
        m['max_queue_depth'] = max(e.get('queueLen',0) for e in utt)
        m['queue_events'] = len([e for e in utt if e.get('queueLen',0) > 0])

    if dones:
        m['avg_total_ms'] = sum(e.get('totalMs',0) for e in dones) / len(dones)
        m['max_total_ms'] = max(e.get('totalMs',0) for e in dones)

    m['errors'] = len(errors)
    m['interactions'] = len([e for e in events if e.get('event') == 'set_muted' and e.get('muted') == False])
    return m

old_m = metrics(parse_session('$OLD'))
new_m = metrics(parse_session('$NEW'))

def fmt_delta(key, unit='ms', lower_is_better=True):
    ov = old_m.get(key)
    nv = new_m.get(key)
    if ov is None or nv is None:
        return f'  {key:30s} {str(ov):>10s} → {str(nv):>10s}'
    delta = nv - ov
    pct = (delta / ov * 100) if ov != 0 else 0
    if delta == 0:
        arrow = '='
    elif (delta < 0) == lower_is_better:
        arrow = '✅ ↓' if delta < 0 else '✅ ↑'
    else:
        arrow = '⚠️ ↑' if delta > 0 else '⚠️ ↓'
    return f'  {key:30s} {ov:>8.0f}{unit} → {nv:>8.0f}{unit}  ({delta:+.0f}, {pct:+.0f}%) {arrow}'

print('  Metric                           Before          After        Delta')
print('  ' + '-'*75)

for key, label in [
    ('avg_first_token_ms', 'LLM avg first token'),
    ('max_first_token_ms', 'LLM max first token'),
    ('avg_total_llm_ms', 'LLM avg total'),
    ('avg_whisper_ms', 'Whisper avg'),
    ('max_whisper_ms', 'Whisper max'),
    ('avg_total_ms', 'Full interaction avg'),
    ('max_total_ms', 'Full interaction max'),
]:
    if key in old_m or key in new_m:
        print(fmt_delta(key))

print()
print('  --- Counts ---')
for key, label in [
    ('interactions', 'PTT interactions'),
    ('transcriptions', 'Transcriptions accepted'),
    ('hallucinations', 'Hallucinations rejected'),
    ('errors', 'Errors'),
    ('queue_events', 'Queue stacking events'),
]:
    ov = old_m.get(key, '?')
    nv = new_m.get(key, '?')
    print(f'  {label:30s} {str(ov):>10s} → {str(nv):>10s}')

print()
if new_m.get('avg_first_token_ms', 999) < old_m.get('avg_first_token_ms', 999):
    print('  🎯 LLM latency IMPROVED')
elif new_m.get('avg_first_token_ms', 0) > old_m.get('avg_first_token_ms', 0):
    print('  ⚠️ LLM latency REGRESSED')
else:
    print('  ➡️ LLM latency unchanged')
"
