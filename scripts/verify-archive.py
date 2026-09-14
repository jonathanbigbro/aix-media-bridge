#!/usr/bin/env python3
"""Independently inspect a release ZIP with Python's standard-library reader."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import zipfile


def verify(archive, directory=None):
    archive = Path(archive)
    with zipfile.ZipFile(archive) as z:
        members = z.infolist()
        names = [m.filename for m in members]
        if len(names) != len(set(names)):
            raise ValueError('DUPLICATE_ARCHIVE_ENTRY')
        if z.comment or sum(m.file_size for m in members) > 250 * 1024 * 1024:
            raise ValueError('UNEXPECTED_ARCHIVE_METADATA_OR_SIZE')
        for m in members:
            p = PurePosixPath(m.filename)
            if p.is_absolute() or '\\' in m.filename or '..' in p.parts or p.as_posix() != m.filename or m.is_dir():
                raise ValueError('UNSAFE_ARCHIVE_ENTRY')
            if any(x in p.parts for x in ('.git', '.aix', 'node_modules', 'jobs', 'outputs', 'configs', 'inputs')) or p.suffix in ('.drp', '.drt', '.har', '.log'):
                raise ValueError('PRIVATE_RUNTIME_ENTRY_IN_ARCHIVE')
            if m.extra or m.comment or m.create_system != 0 or m.external_attr != 0 or m.date_time != (1980, 1, 1, 0, 0, 0):
                raise ValueError('ARCHIVE_OWNER_PATH_OR_TIMESTAMP_METADATA')
        bad = z.testzip()
        if bad:
            raise ValueError('ARCHIVE_CRC_FAILED')
        manifest = json.loads(z.read('release-files-manifest.json'))
        listed = [row['path'] for row in manifest['files']]
        if len(set(listed)) != len(listed) or set(names) != set(listed + ['release-files-manifest.json']):
            raise ValueError('ARCHIVE_MANIFEST_MEMBERS_MISMATCH')
        allowlist = json.loads(z.read('scripts/release-files.json'))
        if len(allowlist) != len(set(allowlist)) or set(allowlist) != set(listed):
            raise ValueError('ARCHIVE_ALLOWLIST_MISMATCH')
        package = json.loads(z.read('package.json'))
        if package['version'] != manifest['version']:
            raise ValueError('ARCHIVE_VERSION_MISMATCH')
        for row in manifest['files']:
            data = z.read(row['path'])
            if not re.fullmatch('[a-f0-9]{64}', row['sha256']) or len(data) != row['bytes'] or hashlib.sha256(data).hexdigest() != row['sha256']:
                raise ValueError('ARCHIVE_FILE_HASH_MISMATCH')
        if directory:
            for name in names:
                p = Path(directory) / name
                if p.is_symlink() or not p.is_file() or p.read_bytes() != z.read(name):
                    raise ValueError('ARCHIVE_DIFFERS_FROM_RELEASE_DIRECTORY')
        return {'state': 'passed', 'archive': archive.name, 'version': manifest['version'],
                'files': len(names), 'archiveBytes': archive.stat().st_size,
                'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                'crcVerified': True, 'fileHashesVerified': True, 'allowlistVerified': True,
                'anonymousArchiveMetadata': True, 'directoryBytesMatch': bool(directory)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('archive')
    parser.add_argument('--directory')
    args = parser.parse_args()
    print(json.dumps(verify(args.archive, args.directory), indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'state': 'failed', 'error': str(error)}))
        sys.exit(2)
