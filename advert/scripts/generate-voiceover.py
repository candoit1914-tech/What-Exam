#!/usr/bin/env python3
"""Generate voiceover audio for WhatExam advert using Microsoft Edge TTS."""

import asyncio
import os
import struct
import math
import json

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'audio')
os.makedirs(OUT, exist_ok=True)

# Voiceover lines with timing info
VO_LINES = [
    {"id": "01-intro", "text": "Exam Bot.", "start_frame": 30},
    {"id": "02-tagline", "text": "Exams that mark themselves. Your bot delivers them — AI does the rest.", "start_frame": 140},
    {"id": "03-chat", "text": "Students take exams right inside WhatsApp. One question at a time, with a live timer keeping things fair.", "start_frame": 285},
    {"id": "04-answers", "text": "Answers arrive as text or photos. Theory, diagrams — whatever the question needs.", "start_frame": 495},
    {"id": "05-aimarking", "text": "Every answer is graded by AI — instantly. Scored across correctness, completeness, and relevance. No waiting. No manual marking.", "start_frame": 675},
    {"id": "06-results", "text": "Results the moment the exam ends.", "start_frame": 785},
    {"id": "07-outro", "text": "Exam Bot. Start examining — for free.", "start_frame": 845},
]

VOICE = "en-US-GuyNeural"
RATE = "-5%"
PITCH = "-2Hz"


async def generate():
    try:
        import edge_tts
    except ImportError:
        print("ERROR: edge-tts not installed. Run: pip install edge-tts")
        return

    print(f"Generating voiceover with voice: {VOICE}")
    print()

    for line in VO_LINES:
        output_path = os.path.join(OUT, f"vo-{line['id']}.mp3")
        print(f"  Generating: vo-{line['id']}.mp3 ...")
        communicate = edge_tts.Communicate(
            text=line["text"],
            voice=VOICE,
            rate=RATE,
            pitch=PITCH,
        )
        await communicate.save(output_path)
        size = os.path.getsize(output_path)
        print(f"    OK {size / 1024:.1f} KB")

    # Write timing manifest
    manifest_path = os.path.join(OUT, "vo-manifest.json")
    with open(manifest_path, 'w') as f:
        json.dump(VO_LINES, f, indent=2)
    print(f"\n  OK Manifest: vo-manifest.json")
    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(generate())
