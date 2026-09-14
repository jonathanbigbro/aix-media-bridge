# Voiced presentations — 0.5.0

This is the 0.5.0 preview following the sealed 0.4.2 preview. No sealed archive or release Git history is updated. AIX remains responsible for images and video. Narration synthesis and Resolve editing are separate local stages; neither imports or invokes an AIX submission function.

## Independent Mandarin narration

Use an isolated Python environment. The same-machine production used edge-tts 7.2.8, voice `zh-CN-XiaoxiaoNeural`, and normal speed. Query the service's current voice list before choosing a voice. Generate and play a short sample first, checking product names. Keep the MP3 originals and word-boundary evidence; normalize a separate editing copy to 48 kHz mono PCM16 WAV. TTS sends the authorized narration text to the selected provider; it does not send project state or account data.

```sh
python3 -m venv .aix/tts-venv
.aix/tts-venv/bin/pip install -r audio/requirements.txt
.aix/tts-venv/bin/python -m edge_tts --list-voices
.aix/tts-venv/bin/python audio/narrate.py --script configs/narration.json --output outputs/MY-EDIT/narration-r1 --ffmpeg PATH_TO_FFMPEG
```

Copy `examples/narration.template.json` to a private configuration and write the actual narration. The script declares 24 fps, 720 frames, and non-overlapping segments with `text`, optional `spokenText`, `startFrame`, and `endFrame`. Overlong speech fails; it is never silently accelerated or truncated. Existing audio files are not overwritten. Changing a narration revision does not regenerate AIX media. If the provider is unavailable, inspect installed macOS Chinese voices or an already configured official provider; do not silently add a paid service.

After synthesis, run `python3 audio/captions.py --narration outputs/MY-EDIT/narration-r1/narration.json --output outputs/MY-EDIT/captions-r1`. It preserves display text, rounds observed word timings to 24 fps, writes SRT plus `timeline-cues.json`, and rejects missing or out-of-order evidence. Use each cue’s frame bounds for the corresponding editable timeline text; check line length and visual sync in the actual export.

## Resolve schema 2

The narrated configuration is separate from the unchanged schema 1 silent montage. It declares exactly 720 frames at 1280×720/24fps, hashed local scene sources, a thirty-second 48 kHz PCM narration file, and a transparent PNG carrier. Each scene specifies its duration, source start frame and editable Text+ elements (content, color, size, position and frame bounds). Start from `examples/narrated-edit.template.json`; replace its illustrative source paths and hashes with your own reviewed local assets. Its one-scene structure is only a schema example, not an editorial recommendation. Real production configs stay private.

```sh
npm run edit -- plan --job configs/MY-EDIT-r1.json
npm run edit -- build --job configs/MY-EDIT-r1.json
npm run edit -- run --job configs/MY-EDIT-r1.json
npm run edit -- status --job configs/MY-EDIT-r1.json
npm run edit -- resume --job configs/MY-EDIT-r1.json
```

Video occupies V1, editable Fusion Text+ titles/captions V2, and narration A1. A1 is explicitly created as mono before importing the mono WAV. Resolve's default stereo track can otherwise route the voice to the left channel only. The adapter first creates mono and then removes only the verified empty default track; Resolve refuses to delete its last audio track. An existing populated track is not silently replaced. Native Inspector gain changes must be verified in the actual export. A separate SRT accompanies the private project; these editable timeline captions are Text+ elements, not a native subtitle track.

Export is native Resolve H.264 MP4 with AAC audio at 48 kHz. The local audio checker decodes the exported track, measures each channel, requires centered non-silent stereo, checks clipping and the first/last audible samples, and compares the complete speech envelope to the source WAV. Completed resume checks the actual MP4 again. Waveform agreement cannot establish subjective voice quality. Play the movie and inspect captions and image privacy before delivery. AAC track/player duration may include encoder padding; report it separately from the exact 720-frame video track and each parser's container duration.

## Recorded local revisions

Use a new configuration file with the next `revision` and the current ledger's `configDigest` as `previousDigest`, then `npm run edit -- revise --job configs/MY-EDIT-r2.json`. Project identity, timing and output directory remain fixed. The adapter records the previous configuration, ledger, source hashes and render job, stages new media under hash-based names, and updates only the owned timeline. Earlier MP4/DRP files and render jobs remain available. A revision does not authorize new AIX submissions. Interrupted or unexpected routing/source state must be inspected in the original project.

The DRP and media folder are private working deliverables and contain local paths. They are not part of the public source package. Another computer requires the accompanying media and may need relinking; no cross-machine acceptance is implied.
