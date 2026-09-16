import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('audit_cadence', Path(__file__).resolve().parents[1]/'.agents/skills/blender-reference-blockout/scripts/audit_cadence.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CadenceTests(unittest.TestCase):
    def frames(self, directory, values):
        for i, value in enumerate(values):
            (Path(directory)/f'frame-{i+1:06}.pgm').write_bytes(b'P5\n2 2\n255\n'+bytes([value])*4)

    def test_continuous_sequence(self):
        with tempfile.TemporaryDirectory() as d:
            self.frames(d, [0, 10, 20, 30])
            r = module.audit(d, 24)
            self.assertEqual(r['frames'], 4)
            self.assertEqual(r['duplicateFrameIndicesZeroBased'], [])
            self.assertEqual(r['parityRatio'], 1)

    def test_alternating_held_frames(self):
        with tempfile.TemporaryDirectory() as d:
            self.frames(d, [0, 0, 40, 40, 80, 80])
            r = module.audit(d, 24)
            self.assertEqual(r['duplicateFrameIndicesZeroBased'], [1, 3, 5])
            self.assertEqual(r['evenTransitionMean'], 0)
            self.assertEqual(r['oddTransitionMean'], 40)

    def test_static_hold_is_reported_without_quality_failure(self):
        with tempfile.TemporaryDirectory() as d:
            self.frames(d, [20, 20, 20])
            self.assertEqual(len(module.audit(d, 24)['duplicateFrameIndicesZeroBased']), 2)

    def test_missing_corrupt_and_invalid_rate(self):
        with tempfile.TemporaryDirectory() as d:
            self.frames(d, [0, 10, 20])
            for fps in [0, -1, float('nan')]:
                with self.assertRaises(ValueError): module.audit(d, fps)
            (Path(d)/'frame-000002.pgm').unlink()
            with self.assertRaises(ValueError): module.audit(d, 24)
            (Path(d)/'frame-000002.pgm').write_bytes(b'P5\n2 2\n255\n\x01')
            with self.assertRaises(ValueError): module.audit(d, 24)
