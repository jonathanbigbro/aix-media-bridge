#!/usr/bin/env python3
"""Audit FFmpeg binary PGM diagnostic frames using the Python standard library."""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path


def read_pgm(path):
    data = Path(path).read_bytes()
    match = re.match(rb'P5\s+(\d+)\s+(\d+)\s+255\r?\n', data)
    if not match:
        raise ValueError('Expected binary 8-bit PGM from FFmpeg')
    width, height = map(int, match.groups())
    pixels = data[match.end():]
    if len(pixels) != width * height:
        raise ValueError('Incomplete PGM frame')
    return (width, height), pixels


def audit(directory, fps):
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError('FPS must be positive')
    paths = sorted(Path(directory).glob('frame-*.pgm'))
    if not paths:
        raise ValueError('No diagnostic frames')
    ids = [int(p.stem.split('-')[-1]) for p in paths]
    if ids != list(range(ids[0], ids[0] + len(ids))):
        raise ValueError('Missing or duplicated frame indices')
    previous, size, differences, repeated = None, None, [], []
    for index, path in enumerate(paths):
        dims, pixels = read_pgm(path)
        if size and size != dims:
            raise ValueError('Frame size changed')
        size = dims
        if previous is not None:
            value = sum(abs(a-b) for a, b in zip(previous, pixels)) / len(pixels)
            differences.append(value)
            if pixels == previous:
                repeated.append(index)
        previous = pixels
    mean = lambda values: sum(values)/len(values) if values else None
    even, odd = mean(differences[::2]), mean(differences[1::2])
    return {'frames': len(paths), 'fps': fps, 'frameDurationSeconds': len(paths)/fps,
            'diagnosticSize': size, 'duplicateFrameIndicesZeroBased': repeated,
            'adjacentMeanAbsoluteDifferences': differences,
            'evenTransitionMean': even, 'oddTransitionMean': odd,
            'parityRatio': None if not even or not odd else max(even, odd)/min(even, odd),
            'firstFrameSha256': hashlib.sha256(paths[0].read_bytes()).hexdigest(),
            'scope': 'Diagnostic downscaled pixels only; static holds may be intentional; inspect original active-motion frames.'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('directory'); p.add_argument('--fps', type=float, required=True)
    p.add_argument('--out', required=True)
    a = p.parse_args(); result = audit(a.directory, a.fps)
    Path(a.out).write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps({'frames': result['frames'], 'duplicates': len(result['duplicateFrameIndicesZeroBased']), 'report': a.out}))


if __name__ == '__main__':
    main()
