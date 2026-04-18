#!/usr/bin/env python3
"""TTS server using ElevenLabs API (Roberta, PT-BR)."""

import argparse
import io
import json
import os
import struct
import sys
import traceback

import aiohttp
import pydub
from aiohttp import web

SAMPLE_RATE = 24000
CHANNELS = 1
SAMPLE_WIDTH = 2

ELEVENLABS_API = "https://api.elevenlabs.io/v1/text-to-speech"


def make_wav(pcm_data):
    buf = io.BytesIO()
    data_len = len(pcm_data)
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_len))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))
    buf.write(struct.pack("<H", 1))
    buf.write(struct.pack("<H", CHANNELS))
    buf.write(struct.pack("<I", SAMPLE_RATE))
    buf.write(struct.pack("<I", SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH))
    buf.write(struct.pack("<H", CHANNELS * SAMPLE_WIDTH))
    buf.write(struct.pack("<H", SAMPLE_WIDTH * 8))
    buf.write(b"data")
    buf.write(struct.pack("<I", data_len))
    buf.write(pcm_data)
    return buf.getvalue()


async def synthesize(text, voice_id, api_key, session):
    payload = {
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75,
        },
    }

    async with session.post(
        f"{ELEVENLABS_API}/{voice_id}",
        json=payload,
        headers={"xi-api-key": api_key},
        timeout=aiohttp.ClientTimeout(total=30),
    ) as resp:
        if resp.status != 200:
            error = await resp.text()
            raise Exception(f"ElevenLabs API error {resp.status}: {error}")
        mp3_data = await resp.read()

    mp3_buf = io.BytesIO(mp3_data)
    audio = pydub.AudioSegment.from_mp3(mp3_buf)
    audio = audio.set_frame_rate(SAMPLE_RATE).set_channels(CHANNELS).set_sample_width(SAMPLE_WIDTH)
    return audio.raw_data


async def handle_synthesize(request):
    try:
        body = await request.json()
        text = body.get("text", "")
        voice = body.get("voice", request.app["voice_id"])

        if not text.strip():
            return web.Response(status=400, text="empty text")

        print(f"[tts-server] Synthesizing: {text[:60]!r}", flush=True)

        pcm_data = await synthesize(text, voice, request.app["api_key"], request.app["http_session"])

        wav_bytes = make_wav(pcm_data)
        print(f"[tts-server] Sent {len(pcm_data)} PCM bytes", flush=True)
        return web.Response(body=wav_bytes, content_type="audio/wav")
    except Exception as e:
        traceback.print_exc()
        print(f"[tts-server] ERROR: {e}", flush=True)
        return web.Response(status=500, text=f"{type(e).__name__}: {e}")


async def handle_health(request):
    return web.Response(
        body=json.dumps({"status": "ok"}),
        content_type="application/json",
    )


async def on_startup(app):
    app["http_session"] = aiohttp.ClientSession()


async def on_cleanup(app):
    await app["http_session"].close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9880)
    parser.add_argument("--voice", default="RGymW84CSmfVugnA5tvA")
    parser.add_argument("--api-key", default=os.environ.get("ELEVENLABS_API_KEY", ""))
    args = parser.parse_args()

    api_key = args.api_key
    if not api_key:
        print("[tts-server] ERROR: ELEVENLABS_API_KEY required (env var or --api-key)", flush=True)
        sys.exit(1)

    app = web.Application()
    app["voice_id"] = args.voice
    app["api_key"] = api_key
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    app.router.add_post("/synthesize", handle_synthesize)
    app.router.add_get("/health", handle_health)

    print(f"[tts-server] Listening on {args.host}:{args.port} (voice={args.voice})", flush=True)
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
