#!/usr/bin/env python3
"""Derive editable frame cues and SRT from retained TTS word timings; no AIX calls."""
import argparse
import copy
import json
import math
from pathlib import Path
from narrate import validate_script


def make_cues(manifest):
    validate_script(manifest)
    result=copy.deepcopy(manifest);previous_end=0
    for row in result['segments']:
        marks=row.get('wordBoundaries')
        if not marks or len(row['text'].splitlines())>2:raise ValueError('CAPTIONS_REQUIRE_WORD_TIMINGS_AND_AT_MOST_TWO_LINES')
        previous_offset=-1
        for mark in marks:
            if not isinstance(mark.get('offset'),(int,float)) or not isinstance(mark.get('duration'),(int,float)) or mark['offset']<previous_offset or mark['duration']<=0:raise ValueError('INVALID_WORD_TIMING')
            previous_offset=mark['offset']
        start=row['startFrame']+math.floor(marks[0]['offset']/10_000_000*24)
        spoken_end=max(m['offset']+m['duration'] for m in marks)/10_000_000
        if spoken_end>row.get('seconds',0)+.1:raise ValueError('WORD_TIMING_EXCEEDS_AUDIO')
        end=min(row['endFrame'],row['startFrame']+math.ceil((spoken_end+.125)*24))
        if not previous_end<=start<end<=720:raise ValueError('CAPTION_TIMING_OVERLAP_OR_OVERFLOW')
        row.update(captionStartFrame=start,captionEndFrame=end);previous_end=end
    return result


def srt_text(cues):
    def timecode(frame):
        milliseconds=round(frame/24*1000);seconds,ms=divmod(milliseconds,1000);minutes,sec=divmod(seconds,60);hour,minute=divmod(minutes,60)
        return f'{hour:02}:{minute:02}:{sec:02},{ms:03}'
    return '\n\n'.join(f'{i}\n{timecode(row["captionStartFrame"])} --> {timecode(row["captionEndFrame"])}\n{row["text"]}' for i,row in enumerate(cues['segments'],1))+'\n'


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--narration',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
    cues=make_cues(json.loads(Path(args.narration).read_text()));output=Path(args.output)
    output.mkdir(parents=True,exist_ok=True)
    files={'timeline-cues.json':json.dumps(cues,ensure_ascii=False,indent=2)+'\n','subtitles.srt':srt_text(cues)}
    if any((output/name).exists() for name in files):raise ValueError('CAPTION_OUTPUT_EXISTS_USE_NEW_REVISION')
    for name,body in files.items():
        with (output/name).open('x') as file:file.write(body)
    print(json.dumps({'state':'captions-ready','cues':len(cues['segments']),'fps':24,'aixSubmissions':0}))

if __name__=='__main__':main()
