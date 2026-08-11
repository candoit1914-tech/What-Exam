#!/usr/bin/env python3
"""Generate premium voiceover audio for WhatExam advert using ElevenLabs API."""

import asyncio
import os
import json
import sys

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'audio')
os.makedirs(OUT, exist_ok=True)

# Voiceover lines with timing info — same manifest as Edge TTS version
VO_LINES = [
    {"id": "01-intro", "text": "Exam Bot.", "start_frame": 30},
    {"id": "02-tagline", "text": "Exams that mark themselves. Your bot delivers them, AI does the rest.", "start_frame": 140},
    {"id": "03-chat", "text": "Students take exams right inside WhatsApp. One question at a time, with a live timer keeping things fair.", "start_frame": 285},
    {"id": "04-answers", "text": "Answers arrive as text or photos. Theory, diagrams, whatever the question needs.", "start_frame": 495},
    {"id": "05-aimarking", "text": "Every answer is graded by AI, instantly. Scored across correctness, completeness, and relevance. No waiting. No manual marking.", "start_frame": 675},
    {"id": "06-results", "text": "Results the moment the exam ends.", "start_frame": 785},
    {"id": "07-outro", "text": "Exam Bot. Start examining, for free.", "start_frame": 845},
]


def get_api_key():
    """Read ElevenLabs API key from environment or .env file."""
    key = os.environ.get('ELEVENLABS_API_KEY', '')
    if key:
        return key
    # Try reading from .env files
    for env_path in [
        os.path.join(os.path.dirname(__file__), '..', '..', '.env'),
        os.path.join(os.path.dirname(__file__), '..', '.env'),
    ]:
        if os.path.exists(env_path):
            with open(env_path, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('ELEVENLABS_API_KEY='):
                        val = line.split('=', 1)[1].strip().strip('"').strip("'")
                        if val and not val.startswith('your_'):
                            return val
    return ''


def get_voice_id():
    """Read ElevenLabs voice ID from environment or .env file."""
    vid = os.environ.get('ELEVENLABS_VOICE_ID', '')
    if vid:
        return vid
    for env_path in [
        os.path.join(os.path.dirname(__file__), '..', '..', '.env'),
        os.path.join(os.path.dirname(__file__), '..', '.env'),
    ]:
        if os.path.exists(env_path):
            with open(env_path, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('ELEVENLABS_VOICE_ID='):
                        val = line.split('=', 1)[1].strip().strip('"').strip("'")
                        if val:
                            return val
    # Default: Rachel voice
    return '21m00Tcm4TlvDq8ikWAM'


async def generate():
    api_key = get_api_key()
    voice_id = get_voice_id()

    if not api_key:
        print("ERROR: ELEVENLABS_API_KEY not set.")
        print("Get your key from https://elevenlabs.io/app/settings/api-keys")
        print("Then set it in .env or as an environment variable.")
        sys.exit(1)

    print(f"Generating voiceover with ElevenLabs (voice: {voice_id})")
    print()

    try:
        import httpx
    except ImportError:
        print("ERROR: httpx not installed. Run: pip install httpx")
        sys.exit(1)

    async with httpx.AsyncClient(timeout=60.0) as client:
        for line in VO_LINES:
            output_path = os.path.join(OUT, f"vo-{line['id']}.mp3")
            print(f"  Generating: vo-{line['id']}.mp3 ...")

            # Use ElevenLabs v1 text-to-speech API with streaming for better quality
            url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"

            # Voice settings for natural, expressive speech
            payload = {
                "text": line["text"],
                "model_id": "eleven_multilingual_v2",
                "voice_settings": {
                    "stability": 0.5,
                    "similarity_boost": 0.75,
                    "style": 0.4,
                    "use_speaker_boost": True,
                },
            }

            headers = {
                "xi-api-key": api_key,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            }

            try:
                response = await client.post(url, json=payload, headers=headers)
                response.raise_for_status()

                with open(output_path, 'wb') as f:
                    f.write(response.content)

                size = os.path.getsize(output_path)
                print(f"    OK {size / 1024:.1f} KB")

            except httpx.HTTPStatusError as e:
                print(f"    FAILED: HTTP {e.response.status_code}")
                if e.response.status_code == 401:
                    print("    Check your ELEVENLABS_API_KEY")
                elif e.response.status_code == 429:
                    print("    Rate limited — wait a moment and try again")
                else:
                    print(f"    {e.response.text[:200]}")
                sys.exit(1)
            except Exception as e:
                print(f"    FAILED: {e}")
                sys.exit(1)

    # Write timing manifest
    manifest_path = os.path.join(OUT, "vo-manifest.json")
    with open(manifest_path, 'w') as f:
        json.dump(VO_LINES, f, indent=2)
    print(f"\n  OK Manifest: vo-manifest.json")
    print("\nDone! Premium ElevenLabs voiceover generated.")
    print("Run the Remotion build to create the final video:")
    print("  cd advert && npm run build")


if __name__ == "__main__":
    asyncio.run(generate())
