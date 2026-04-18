---
name: self-improve
description: Analyzes Albedo AI performance logs to identify bottlenecks, regressions, and improvement opportunities. Use when the user asks to analyze logs, improve latency, debug performance issues, review session quality, or when the user says "auto-improve", "check logs", "analyze performance". Also triggers on patterns like "why is it slow", "improve response time", "self-improve".
---

# Self-Improve: Albedo AI Performance Analysis

Analyzes the Albedo AI session logs (JSON lines with timestamps) to identify performance issues and propose concrete fixes.

## Log Location

Logs are stored in `~/.config/albedo-ai/logs/` as JSONL files. Each session creates a new file named `session-YYYY-MM-DDTHH-MM-SS.log`.

## Quick Analysis

```bash
# Analyze the latest session
./scripts/analyze.sh latest

# Analyze a specific session
./scripts/analyze.sh session-2026-04-18T07-40-03.log

# Compare two sessions (before/after a change)
./scripts/compare.sh session-old.log session-new.log
```

## Event Schema

Each log line is JSON with at minimum `ts` (ISO timestamp) and `event` (string). Key events:

| Event | Meaning | Key Fields |
|-------|---------|------------|
| `session_start` | App started | `logFile` |
| `set_muted` | PTT toggle | `muted`, `captureStarted`, `isProcessing`, `isSpeaking` |
| `ptt_stop` | User released PTT | `phase`, `whisperMs` |
| `ptt_skip` | Transcription rejected | `text`, `reason` |
| `ptt_error` | PTT failed | `error` |
| `utterance_start` | Processing user speech | `transcript`, `queueLen` |
| `llm_done` | LLM finished streaming | `firstTokenMs`, `firstSpeakMs`, `totalLlmMs`, `responseLen` |
| `tts_enqueue` | Sentence queued for TTS | `sentence`, `queueLen` |
| `utterance_done` | Full response complete | `totalMs`, `queueRemaining` |
| `queue_pop` | Picked next from queue | `next` |

## Analysis Workflow

When this skill is triggered, follow these steps:

### Step 1: Read the logs

```bash
./scripts/analyze.sh latest
```

Or manually:
```bash
cat ~/.config/albedo-ai/logs/session-*.log | python3 -c "import sys,json; [print(json.dumps(json.loads(l))) for l in sys.stdin]"
```

### Step 2: Compute key metrics

From the events, calculate and report:

1. **Voice-to-voice latency** (the most important metric):
   - Time from `ptt_stop` (phase=transcribed) to first `tts_enqueue` ≈ user stopped speaking → first audio out
   - Breakdown: Whisper time + LLM first token time + TTS first synthesis
   - Target: **under 1000ms**

2. **LLM latency**:
   - `firstTokenMs` — time to first LLM token (should be < 1000ms)
   - `totalLlmMs` — total LLM streaming time
   - Flag if `firstTokenMs > 3000ms`

3. **Whisper latency**:
   - From `ptt_stop` phase `stop_recording` to phase `transcribed` → `whisperMs`
   - Flag if > 500ms

4. **Queue stacking**:
   - If `utterance_start` has `queueLen > 0`, utterances are stacking
   - Check if `queue_pop` events happen (means old responses were queued)
   - Flag if queue ever exceeds 1

5. **Hallucination rate**:
   - Count `ptt_skip` with reason `hallucination` vs successful transcriptions
   - Flag if > 20% skip rate

6. **Error rate**:
   - Count `ptt_error` events
   - Any error is worth investigating

### Step 3: Identify patterns

Look for these common patterns:

- **Slow LLM spikes**: If `firstTokenMs` varies wildly (3s → 14s), likely tool calls timing out
- **Queue accumulation**: Multiple `utterance_start` with `queueLen > 0` means responses overlap
- **Hallucination in wrong language**: Check `ptt_skip` texts for non-Portuguese
- **TTS backlog**: Many `tts_enqueue` before `utterance_done` means slow synthesis

### Step 4: Propose fixes

Based on findings, propose specific code changes. Reference the relevant source files:

- LLM latency → `src/bun/orchestrator.ts` (streaming), `src/bun/grok-client.ts` (API calls)
- Whisper latency → `audio-engine/src/stt.rs` (model selection, params)
- Queue issues → `src/bun/orchestrator.ts` (processUtterance, processingQueue)
- Hallucination → `src/bun/orchestrator.ts` (isHallucination), `audio-engine/src/stt.rs` (looks_like_hallucination)
- TTS latency → `src/bun/orchestrator.ts` (drainTtsQueue, prefetch), `src/bun/tts-client.ts`
- Capture latency → `src/bun/orchestrator.ts` (setMuted, captureStarted)

### Step 5: Apply fixes

After proposing, ask the user if they want the fixes applied. Then make the code changes.

## Continuous Improvement

For ongoing monitoring, the user can add to their workflow:
- Run analysis after each coding session
- Compare sessions with `compare.sh` to verify improvements
- Track metrics over time to spot regressions
