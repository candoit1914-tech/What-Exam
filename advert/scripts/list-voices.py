#!/usr/bin/env python3
"""List available ElevenLabs voices."""
import httpx
import json

api_key = 'sk_6e1978285703a1b50cb5c2a0af3cb9175d59c5a834720b5c'
headers = {'xi-api-key': api_key}

response = httpx.get('https://api.elevenlabs.io/v1/voices', headers=headers)
print(f'Status: {response.status_code}')
if response.status_code == 200:
    voices = response.json()['voices']
    print(f'Found {len(voices)} voices:')
    for v in voices[:15]:
        name = v['name']
        vid = v['voice_id']
        cat = v.get('category', 'unknown')
        labels = v.get('labels', {})
        accent = labels.get('accent', '')
        print(f'  {vid}: {name} ({cat}) {accent}')
else:
    print(response.text[:500])
