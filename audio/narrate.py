#!/usr/bin/env python3
"""Replaceable TTS stage. No AIX or Resolve imports, state, or submissions."""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import subprocess
import wave


def wav_info(path):
    with wave.open(str(path), 'rb') as f:
        if (f.getframerate(), f.getsampwidth(), f.getnchannels()) != (48000, 2, 1):
            raise ValueError('NARRATION_REQUIRES_48KHZ_MONO_PCM16')
        return f.getnframes(), f.readframes(f.getnframes())


def validate_script(script):
    if script.get('fps') != 24 or script.get('frames') != 720:
        raise ValueError('INTRO_REQUIRES_720_FRAMES_AT_24FPS')
    if not isinstance(script.get('segments'),list) or not script['segments']:
        raise ValueError('NARRATION_SEGMENTS_REQUIRED')
    last = 0
    for row in script['segments']:
        if not row['text'].strip() or not last <= row['startFrame'] < row['endFrame'] <= 720:
            raise ValueError('INVALID_NARRATION_SEGMENT')
        last = row['endFrame']


async def generate(script, output, voice, rate, ffmpeg):
    import edge_tts
    validate_script(script)
    output.mkdir(parents=True, exist_ok=True)
    frames = 720 * 2000
    combined = bytearray(frames * 2)
    evidence = []
    for index, row in enumerate(script['segments'], 1):
        stem = output / f'{index:02d}'
        raw, wav = stem.with_suffix('.mp3'), stem.with_suffix('.wav')
        if raw.exists() or wav.exists():
            raise ValueError('TTS_OUTPUT_EXISTS_USE_EXPLICIT_NEW_AUDIO_REVISION')
        talk = edge_tts.Communicate(row.get('spokenText', row['text']), voice, rate=rate, boundary='WordBoundary')
        marks = []
        with raw.open('xb') as file:
            async for chunk in talk.stream():
                if chunk['type'] == 'audio':
                    file.write(chunk['data'])
                elif chunk['type'] == 'WordBoundary':
                    marks.append({k:v for k,v in chunk.items() if k != 'type'})
        stem.with_suffix('.timing.json').write_text(json.dumps(marks, ensure_ascii=False, indent=2))
        subprocess.run([ffmpeg, '-v', 'error', '-i', str(raw), '-af', 'loudnorm=I=-18:TP=-2:LRA=7',
                        '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-n', str(wav)], check=True)
        count, pcm = wav_info(wav)
        available = (row['endFrame'] - row['startFrame']) * 2000
        if count > available:
            raise ValueError(f'NARRATION_DOES_NOT_FIT_SEGMENT_{index}: {count/48000:.3f}s > {available/48000:.3f}s; shorten text, never truncate')
        offset = row['startFrame'] * 2000 * 2
        combined[offset:offset + len(pcm)] = pcm
        evidence.append({**row, 'rawAudio': raw.name, 'pcmAudio': wav.name, 'seconds': count/48000,
                         'sha256': hashlib.sha256(raw.read_bytes()).hexdigest(), 'wordBoundaries': marks})
    with wave.open(str(output / 'narration-48k.wav'), 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(48000); f.writeframes(combined)
    manifest = {'provider':'edge-tts', 'voice':voice, 'rate':rate, 'audioIndependentOfAix':True,
                'frames':720, 'fps':24, 'samples':frames, 'segments':evidence}
    (output / 'narration.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    return manifest


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--script',required=True); p.add_argument('--output',required=True)
    p.add_argument('--voice',default='zh-CN-XiaoxiaoNeural'); p.add_argument('--rate',default='+0%')
    p.add_argument('--ffmpeg',required=True)
    a=p.parse_args()
    result=asyncio.run(generate(json.loads(Path(a.script).read_text()),Path(a.output),a.voice,a.rate,a.ffmpeg))
    print(json.dumps({'state':'narration-ready','segments':[{k:r[k] for k in ('text','seconds')} for r in result['segments']]},ensure_ascii=False))

if __name__=='__main__': main()
