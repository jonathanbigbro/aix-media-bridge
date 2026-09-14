"""Local Resolve handoff: verified AIX artifacts, private state and native API."""
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
STATE = Path(os.environ.get('AIX_STATE_DIR', ROOT / '.aix')) / 'resolve'

def digest_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def read_json(path):
    return json.loads(Path(path).read_text())

def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.tmp')
    with temp.open('w') as f:
        json.dump(value, f, indent=2, ensure_ascii=False)
        f.write('\n')
    temp.chmod(0o600)
    temp.replace(path)

def connect():
    if sys.platform != 'darwin':
        raise RuntimeError('THIS_RESOLVE_ADAPTER_IS_VALIDATED_ON_MACOS_ONLY')
    api = Path(os.environ.get('RESOLVE_SCRIPT_API', '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting'))
    sys.path.insert(0, str(api / 'Modules'))
    module = importlib.import_module('DaVinciResolveScript')
    resolve = module.scriptapp('Resolve')
    if not resolve:
        raise RuntimeError('OPEN_RESOLVE_AND_ENABLE_SUPPORTED_LOCAL_SCRIPTING')
    return resolve

def load_config(path, allow_pending=False):
    path = Path(path).resolve()
    raw = read_json(path)
    if raw.get('schemaVersion') == 2:
        from narrated import load_config as load_narrated_config
        return load_narrated_config(path)
    required = {'schemaVersion', 'jobId', 'projectName', 'timelineName', 'outputDir', 'cases', 'timeline', 'privacy', 'render'}
    if set(raw) != required or raw['schemaVersion'] != 1:
        raise ValueError('UNSUPPORTED_RESOLVE_CONFIG')
    if not re.fullmatch(r'[A-Z0-9][A-Z0-9_-]{2,79}', raw['jobId']):
        raise ValueError('INVALID_EDIT_JOB_ID')
    for field in ('projectName', 'timelineName'):
        if not isinstance(raw[field], str) or not raw[field].strip() or len(raw[field]) > 100 or any(ord(c) < 32 for c in raw[field]):
            raise ValueError('INVALID_EDIT_NAME')
    spec = raw['timeline']
    if set(spec) != {'width', 'height', 'fps', 'clipSeconds'}:
        raise ValueError('UNSUPPORTED_TIMELINE_FIELDS')
    if (spec['width'], spec['height'], spec['fps']) != (1280, 720, 24):
        raise ValueError('UNVERIFIED_TIMELINE_FORMAT')
    if spec['clipSeconds'] != 5:
        raise ValueError('UNVERIFIED_EDIT_TIMING')
    if raw['render'] != {'format': 'mp4', 'codec': 'H264', 'audio': False}:
        raise ValueError('UNVERIFIED_RENDER_FORMAT')
    output = (path.parent / raw['outputDir']).resolve()
    if not output.is_relative_to(ROOT / 'outputs') or output == ROOT / 'outputs':
        raise ValueError('EDIT_OUTPUT_MUST_BE_IN_LOCAL_OUTPUTS_SUBDIRECTORY')
    if not isinstance(raw['cases'], list) or not 1 <= len(raw['cases']) <= 6:
        raise ValueError('ONE_TO_SIX_CASES_REQUIRED')
    cases, keys = [], set()
    for case in raw['cases']:
        if not {'key', 'title', 'manifest'} <= set(case) or set(case) - {'key', 'title', 'manifest', 'artifactDirectory'}:
            raise ValueError('INVALID_CASE_FIELDS')
        key = case['key']
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', key) or key in keys:
            raise ValueError('CASE_KEY_NOT_UNIQUE_OR_INVALID')
        keys.add(key)
        if not isinstance(case['title'], str) or not case['title'].strip() or len(case['title']) > 50:
            raise ValueError('INVALID_CASE_TITLE')
        manifest_path = (path.parent / case['manifest']).resolve()
        if allow_pending and not manifest_path.exists():
            cases.append({'key': key, 'title': case['title'], 'assets': None})
            continue
        manifest = read_json(manifest_path)
        if manifest.get('state') != 'completed':
            raise ValueError('ONLY_COMPLETED_AIX_RESULTS_MAY_BE_EDITED')
        assets = {}
        for role in ('image', 'video'):
            matches = [a for a in manifest['artifacts'] if a['role'] == role]
            if len(matches) != 1:
                raise ValueError('UNIQUE_SOURCE_ARTIFACT_REQUIRED')
            artifact = matches[0]
            source = Path(artifact['localPath'])
            if case.get('artifactDirectory'):
                source = (path.parent / case['artifactDirectory'] / source.name).resolve()
            if not source.is_file() or digest_file(source) != artifact['sha256']:
                raise ValueError('AIX_SOURCE_HASH_MISMATCH')
            if source.suffix.lower() not in ({'.jpg', '.jpeg', '.png'} if role == 'image' else {'.mp4'}):
                raise ValueError('UNSUPPORTED_SOURCE_MEDIA')
            if role == 'video' and (not artifact.get('decodeComplete') or artifact.get('videoTrackDurationSeconds', 0) < 5):
                raise ValueError('VIDEO_MUST_DECODE_AND_CONTAIN_FIVE_SECONDS')
            assets[role] = {'path': str(source), 'sha256': artifact['sha256'], 'bytes': source.stat().st_size}
        cases.append({'key': key, 'title': case['title'], 'assets': assets})
    if set(raw['privacy']) - keys:
        raise ValueError('MASK_REFERENCES_UNKNOWN_CASE')
    for roles in raw['privacy'].values():
        if set(roles) - {'video'}:
            raise ValueError('INVALID_MASK_ROLE')
        for points in roles.values():
            if not isinstance(points, list) or not 1 <= len(points) <= 20:
                raise ValueError('INVALID_MASK_POINTS')
            last = -1
            for point in points:
                if len(point) != 6 or any(type(v) not in (int, float) for v in point):
                    raise ValueError('INVALID_MASK_POINT')
                t, x, y, w, h, angle = point
                if not last < t <= 5 or not (0 <= x <= 1 and 0 <= y <= 1 and 0 < w <= 1 and 0 < h <= 1 and -180 <= angle <= 180):
                    raise ValueError('INVALID_MASK_GEOMETRY')
                last = t
            if points[0][0] != 0:
                raise ValueError('MASK_MUST_COVER_FIRST_FRAME')
    identity = {'config': raw, 'output': str(output), 'configDirectory': str(path.parent)}
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    ready = all(c['assets'] for c in cases)
    source_digest = hashlib.sha256(json.dumps(cases, sort_keys=True, ensure_ascii=False).encode()).hexdigest() if ready else None
    return {'raw': raw, 'cases': cases, 'ready': ready, 'sourceDigest': source_digest, 'output': output, 'digest': digest, 'stateDir': STATE / raw['jobId']}

def segments(config):
    fps = config['raw']['timeline']['fps']
    rows = []
    for case in config['cases']:
        rows.append({'key': case['key'] + '-motion', 'case': case, 'role': 'video', 'frames': 5 * fps})
    frame = 0
    for row in rows:
        row['recordFrame'] = frame
        frame += row['frames']
    return rows
