import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resolve'))
import common
from bridge import check_ledger, render_state
from native import expression

class ResolveHandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        (self.root / 'configs').mkdir()
        self.path = self.root / 'configs/edit.json'
        artifacts = []
        for role, extension in [('image', 'jpg'), ('video', 'mp4')]:
            p = self.root / ('synthetic.' + extension)
            p.write_bytes(('synthetic fixture ' + role).encode())
            artifacts.append({'role': role, 'localPath': str(p), 'sha256': common.digest_file(p), 'decodeComplete': True, 'videoTrackDurationSeconds': 5.04})
        self.manifest = self.root / 'result.json'
        self.manifest.write_text(json.dumps({'state': 'completed', 'artifacts': artifacts}))
        self.raw = {'schemaVersion': 1, 'jobId': 'TEST-RESOLVE-001', 'projectName': 'Synthetic Project', 'timelineName': 'Synthetic Timeline',
                    'outputDir': '../outputs/test', 'cases': [{'key': 'one', 'title': 'Synthetic', 'manifest': '../result.json'}],
                    'timeline': {'width': 1280, 'height': 720, 'fps': 24, 'clipSeconds': 5}, 'privacy': {},
                    'render': {'format': 'mp4', 'codec': 'H264', 'audio': False}}
        self.patches = [patch.object(common, 'ROOT', self.root), patch.object(common, 'STATE', self.root / '.aix/resolve')]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def load(self, raw=None):
        self.path.write_text(json.dumps(raw or self.raw))
        return common.load_config(self.path)

    def test_verified_manifest_creates_exact_five_second_segments(self):
        cfg = self.load()
        rows = common.segments(cfg)
        self.assertEqual([(r['role'], r['recordFrame'], r['frames']) for r in rows], [('video', 0, 120)])

    def test_changed_source_bytes_are_rejected(self):
        (self.root / 'synthetic.mp4').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'SOURCE_HASH_MISMATCH'):
            self.load()

    def test_unfinished_aix_job_is_not_imported(self):
        value = json.loads(self.manifest.read_text())
        value['state'] = 'pending'
        self.manifest.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'ONLY_COMPLETED'):
            self.load()

    def test_output_escape_is_rejected(self):
        self.raw['outputDir'] = '../outside'
        with self.assertRaisesRegex(ValueError, 'OUTPUT_MUST_BE'):
            self.load()

    def test_job_identity_and_sources_are_immutable(self):
        cfg = self.load()
        path, ledger = check_ledger(cfg)
        common.atomic_json(path, ledger)
        self.raw['projectName'] = 'Changed Project'
        with self.assertRaisesRegex(RuntimeError, 'CONFIG_OR_SOURCE_CHANGED'):
            check_ledger(self.load())

    def test_mask_must_start_at_first_frame_and_use_known_case(self):
        self.raw['privacy'] = {'one': {'video': [[1, .5, .5, .1, .1, 0]]}}
        with self.assertRaisesRegex(ValueError, 'MASK_MUST_COVER_FIRST_FRAME'):
            self.load()
        self.raw['privacy'] = {'unknown': {'video': [[0, .5, .5, .1, .1, 0]]}}
        with self.assertRaisesRegex(ValueError, 'MASK_REFERENCES_UNKNOWN_CASE'):
            self.load()

    def test_mask_expression_accounts_for_native_comp_start(self):
        value = expression([[0, .4, .5, .1, .1, 0], [5, .6, .5, .1, .1, 0]], 1, 1000, 24)
        self.assertIn('time-1000', value)
        self.assertIn('/120', value)

    def test_unimplemented_still_mask_is_rejected(self):
        self.raw['privacy'] = {'one': {'image': [[0, .5, .5, .1, .1, 0]]}}
        with self.assertRaisesRegex(ValueError, 'INVALID_MASK_ROLE'):
            self.load()

    def test_changed_manifest_cannot_replace_started_source_set(self):
        cfg = self.load()
        path, ledger = check_ledger(cfg)
        ledger['sourceDigest'] = cfg['sourceDigest']
        common.atomic_json(path, ledger)
        source = self.root / 'synthetic.mp4'
        source.write_bytes(b'another validly hashed video')
        manifest = json.loads(self.manifest.read_text())
        manifest['artifacts'][1]['sha256'] = common.digest_file(source)
        self.manifest.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_SET_CHANGED'):
            check_ledger(self.load())

    def test_missing_or_unknown_render_is_never_requeued(self):
        class Project:
            def GetRenderJobList(self):
                return []
        with self.assertRaisesRegex(RuntimeError, 'UNKNOWN_INSPECT'):
            render_state(Project(), {'renderReservation': True})
        with self.assertRaisesRegex(RuntimeError, 'MISSING_DO_NOT_REQUEUE'):
            render_state(Project(), {'renderJobId': 'synthetic-job'})

    def test_native_chinese_complete_status_is_recognized(self):
        class Project:
            def GetRenderJobList(self):
                return [{'JobId': 'synthetic-job'}]
            def GetRenderJobStatus(self, job):
                return {'JobStatus': '完成', 'CompletionPercentage': 100}
        self.assertEqual(render_state(Project(), {'renderJobId': 'synthetic-job'})['JobStatus'], 'Complete')

if __name__ == '__main__':
    unittest.main()
