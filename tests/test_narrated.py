import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave
from array import array
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'resolve'))
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'audio'))
import narrated
from narrate import validate_script
from captions import make_cues,srt_text
from native import render_settings

class NarratedTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();(self.root/'configs').mkdir()
  self.patch=patch.object(narrated,'ROOT',self.root);self.patch.start()
  (self.root/'plate.png').write_bytes(b'synthetic')
  with wave.open(str(self.root/'voice.wav'),'wb') as f:
   f.setnchannels(1);f.setsampwidth(2);f.setframerate(48000);f.writeframes(array('h',[1000,-1000]*720000).tobytes())
  def asset(name):return {'path':'../'+name,'sha256':narrated.digest_file(self.root/name)}
  self.raw={'schemaVersion':2,'jobId':'TEST-NARRATED-001','projectName':'Synthetic intro','timelineName':'Synthetic timeline','outputDir':'../outputs/intro','timeline':{'width':1280,'height':720,'fps':24,'frames':720},'scenes':[{'key':'one','source':asset('plate.png'),'sourceStartFrame':0,'frames':720,'texts':[{'name':'Caption','text':'合成字幕','size':.03,'x':.5,'y':.1,'start':0,'end':720,'color':[1,1,1]}]}],'narration':asset('voice.wav'),'overlaySource':asset('plate.png'),'render':{'format':'mp4','codec':'H264','audio':True},'revision':1,'previousDigest':None}
 def tearDown(self):self.patch.stop();self.tmp.cleanup()
 def load(self):
  path=self.root/'configs/intro.json';path.write_text(json.dumps(self.raw));return narrated.load_config(path)
 def test_exact_voiced_plan_preserves_audio_and_editable_text(self):
  c=self.load();self.assertEqual(c['scenes'][0]['frames'],720);self.assertTrue(c['raw']['render']['audio']);self.assertEqual(c['scenes'][0]['texts'][0]['text'],'合成字幕')
 def test_719_frames_cannot_pass(self):
  self.raw['scenes'][0]['frames']=719;self.raw['scenes'][0]['texts'][0]['end']=719
  with self.assertRaisesRegex(ValueError,'SCENE_TOTAL'):self.load()
 def test_empty_or_short_narration_cannot_pass(self):
  with wave.open(str(self.root/'voice.wav'),'wb') as f:
   f.setnchannels(1);f.setsampwidth(2);f.setframerate(48000);f.writeframes(bytes(1440000*2))
  self.raw['narration']['sha256']=narrated.digest_file(self.root/'voice.wav')
  with self.assertRaisesRegex(ValueError,'IS_SILENT'):self.load()
 def test_changed_audio_rejected_before_import(self):
  (self.root/'voice.wav').write_bytes(b'changed')
  with self.assertRaisesRegex(ValueError,'HASH_OR_TYPE'):self.load()
 def test_voiced_render_cannot_disable_audio(self):
  self.raw['render']['audio']=False
  with self.assertRaisesRegex(ValueError,'REQUIRES_AUDIO'):self.load()
 def test_subtitle_outside_clip_rejected(self):
  self.raw['scenes'][0]['texts'][0]['end']=721
  with self.assertRaisesRegex(ValueError,'TEXT_TIMING'):self.load()
 def test_duplicate_caption_tools_rejected_before_fusion(self):
  self.raw['scenes'][0]['texts']*=2
  with self.assertRaisesRegex(ValueError,'DUPLICATE_TEXT'):self.load()
 def test_tts_overlap_and_empty_script_rejected(self):
  for rows in ([],[{'startFrame':0,'endFrame':120,'text':'合成'},{'startFrame':119,'endFrame':240,'text':'重复'}]):
   with self.assertRaises(ValueError):validate_script({'fps':24,'frames':720,'segments':rows})
 def test_final_audio_silence_truncation_clipping_and_wrong_content_rejected(self):
  good={'channels':2,'channelRmsDbFS':[-20,-20],'decodeComplete':True,'audioTracks':1,'nonSilent':True,'clippedSamples':0,'peakDbFS':-3,'firstActiveSeconds':.4,'lastActiveSeconds':28.3,'envelope100ms':[{'time':0,'rms':.1},{'time':.1,'rms':.4},{'time':.2,'rms':.2}]}
  self.assertTrue(narrated.check_audio_result(good,good)['firstAndLastSpeechPreserved'])
  for change in ({'channelRmsDbFS':[-20,-120]},{'nonSilent':False},{'clippedSamples':1},{'lastActiveSeconds':25},{'envelope100ms':[{'time':0,'rms':.8},{'time':.1,'rms':.01},{'time':.2,'rms':.01}]}):
   with self.assertRaises(RuntimeError):narrated.check_audio_result({**good,**change},good)
 def test_legacy_silent_render_settings_remain_silent(self):
  class Project:
   def IsRenderingInProgress(self):return False
   def SetCurrentRenderFormatAndCodec(self,*a):return True
   def SetCurrentRenderMode(self,*a):return True
   def SetRenderSettings(self,s):self.settings=s;return True
  p=Project();render_settings(p,{'output':self.root});self.assertFalse(p.settings['ExportAudio'])
if __name__=='__main__':unittest.main()

class CaptionTests(unittest.TestCase):
 def manifest(self):return {'fps':24,'frames':720,'segments':[{'text':'给 Codex 参考图。','spokenText':'给 Codex 参考图。','startFrame':5,'endFrame':118,'seconds':3.84,'wordBoundaries':[{'offset':1000000,'duration':2000000,'text':'给'},{'offset':28875000,'duration':3625000,'text':'参考图'}]}]}
 def test_word_boundaries_become_exact_editable_frames_and_srt(self):
  original=self.manifest();before=copy.deepcopy(original);cues=make_cues(original);self.assertEqual(original,before)
  self.assertEqual((cues['segments'][0]['captionStartFrame'],cues['segments'][0]['captionEndFrame']),(7,86));self.assertIn('00:00:00,292 --> 00:00:03,583',srt_text(cues));self.assertIn('Codex',srt_text(cues))
 def test_missing_or_out_of_order_timing_and_excess_lines_fail(self):
  for case in ('missing','order','lines','tail'):
   m=self.manifest();r=m['segments'][0]
   if case=='missing':r['wordBoundaries']=[]
   if case=='order':r['wordBoundaries'].reverse()
   if case=='lines':r['text']='一\n二\n三'
   if case=='tail':r['seconds']=1
   with self.assertRaises(ValueError):make_cues(m)
 def test_captions_stay_inside_the_authorized_segment(self):
  m=self.manifest();m['segments'][0]['endFrame']=84;c=make_cues(m);self.assertEqual(c['segments'][0]['captionEndFrame'],84)
