"""Frame-accurate, voiced local presentations; immutable revisions of one project."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import time
import wave
from common import ROOT, STATE, atomic_json, digest_file, read_json
from native import require, owned_project, tool


def load_config(path):
    path=Path(path).resolve(); raw=read_json(path)
    required={'schemaVersion','jobId','projectName','timelineName','outputDir','timeline','scenes','narration','overlaySource','render','revision','previousDigest'}
    if set(raw)!=required or raw['schemaVersion']!=2: raise ValueError('INVALID_NARRATED_CONFIG')
    if not re.fullmatch(r'[A-Z0-9][A-Z0-9_-]{2,79}',raw['jobId']): raise ValueError('INVALID_EDIT_JOB_ID')
    if raw['timeline']!={'width':1280,'height':720,'fps':24,'frames':720}: raise ValueError('NARRATED_TIMELINE_REQUIRES_720_FRAMES_24FPS_720P')
    if raw['render']!={'format':'mp4','codec':'H264','audio':True}: raise ValueError('NARRATED_RENDER_REQUIRES_AUDIO')
    if type(raw['revision']) is not int or raw['revision']<1: raise ValueError('INVALID_EDIT_REVISION')
    for field in ('projectName','timelineName'):
        if not isinstance(raw[field],str) or not raw[field].strip() or len(raw[field])>100 or any(ord(c)<32 for c in raw[field]): raise ValueError('INVALID_EDIT_NAME')
    output=(path.parent/raw['outputDir']).resolve()
    if not output.is_relative_to(ROOT/'outputs') or output==ROOT/'outputs': raise ValueError('EDIT_OUTPUT_MUST_BE_IN_LOCAL_OUTPUTS_SUBDIRECTORY')
    def asset(value,extensions):
        if set(value)!={'path','sha256'}: raise ValueError('INVALID_LOCAL_ASSET_FIELDS')
        source=(path.parent/value['path']).resolve()
        if source.suffix.lower() not in extensions or not source.is_file() or digest_file(source)!=value['sha256']: raise ValueError('LOCAL_MEDIA_HASH_OR_TYPE_MISMATCH')
        return {'path':str(source),'sha256':value['sha256']}
    scenes=[]; frame=0
    for row in raw['scenes']:
        if set(row)!={'key','source','sourceStartFrame','frames','texts'} or not re.fullmatch(r'[a-z][a-z0-9-]{0,39}',row['key']): raise ValueError('INVALID_SCENE')
        if type(row['frames']) is not int or row['frames']<=0 or type(row['sourceStartFrame']) is not int or row['sourceStartFrame']<0: raise ValueError('INVALID_SCENE_TIMING')
        if len({t.get('name') for t in row['texts']})!=len(row['texts']):raise ValueError('DUPLICATE_TEXT_TOOL_NAMES')
        for text in row['texts']:
            if set(text)!={'name','text','size','x','y','start','end','color'}: raise ValueError('INVALID_EDITABLE_TEXT_FIELDS')
            if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*',text['name']) or not isinstance(text['text'],str) or not text['text'].strip(): raise ValueError('INVALID_EDITABLE_TEXT')
            if not 0<=text['start']<text['end']<=row['frames'] or not 0<text['size']<=.15 or not 0<=text['x']<=1 or not 0<=text['y']<=1: raise ValueError('INVALID_TEXT_TIMING_OR_LAYOUT')
            if len(text['color'])!=3 or not all(0<=v<=1 for v in text['color']): raise ValueError('INVALID_TEXT_COLOR')
        scenes.append({**row,'source':asset(row['source'],{'.png','.jpg','.mp4','.mov'}),'recordFrame':frame})
        frame+=row['frames']
    if frame!=720 or len({r['key'] for r in scenes})!=len(scenes): raise ValueError('SCENE_TOTAL_OR_KEYS_INVALID')
    narration=asset(raw['narration'],{'.wav'})
    with wave.open(narration['path'],'rb') as f:
        if (f.getframerate(),f.getsampwidth(),f.getnchannels(),f.getnframes())!=(48000,2,1,1440000): raise ValueError('NARRATION_REQUIRES_THIRTY_SECONDS_48K_PCM16_MONO')
        from array import array
        samples=array('h',f.readframes(f.getnframes()))
        if not samples or sum(x*x for x in samples)/len(samples)<32**2: raise ValueError('NARRATION_IS_SILENT')
    overlay=asset(raw['overlaySource'],{'.png'})
    import hashlib
    digest=hashlib.sha256(json.dumps(raw,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    return {'raw':raw,'scenes':scenes,'narration':narration,'overlay':overlay,'output':output,'digest':digest,'stateDir':STATE/raw['jobId'],'ready':True,'path':path}


def stage_and_import(project,config):
    pool=project.GetMediaPool(); root=pool.GetRootFolder()
    matches=[f for f in root.GetSubFolderList() if f.GetName()=='Intro Media']
    require(len(matches)<=1,'DUPLICATE_INTRO_BINS')
    folder=matches[0] if matches else require(pool.AddSubFolder(root,'Intro Media'),'BIN_CREATE_FAILED')
    require(pool.SetCurrentFolder(folder),'BIN_SELECT_FAILED')
    media=config['output']/'media';media.mkdir(parents=True,exist_ok=True)
    entries={row['key']:row['source'] for row in config['scenes']}
    entries.update(narration=config['narration'],overlay=config['overlay'])
    result={}
    for key,source in entries.items():
        dest=media/(key+'-'+source['sha256'][:10]+Path(source['path']).suffix)
        if not dest.exists():
            with dest.open('xb') as out,open(source['path'],'rb') as original: shutil.copyfileobj(original,out)
        require(digest_file(dest)==source['sha256'],'STAGED_MEDIA_HASH_MISMATCH')
        existing=[c for c in folder.GetClipList() if c.GetClipProperty('File Path')==str(dest)]
        require(len(existing)<=1,'DUPLICATE_IMPORTED_MEDIA')
        clips=existing or pool.ImportMedia([str(dest)])
        require(clips and len(clips)==1,'MEDIA_IMPORT_FAILED_'+key)
        result[key]=clips[0]
    return result


def select_time(resolve,timeline,frame):
    seconds,sub=divmod(frame,24)
    require(timeline.SetCurrentTimecode(f'00:{seconds//60:02}:{seconds%60:02}:{sub:02}'),'SET_PLAYHEAD_FAILED')
    require(resolve.OpenPage('fusion'),'OPEN_FUSION_FAILED')


def decorate(resolve,project,timeline,clip,row):
    select_time(resolve,timeline,row['recordFrame'])
    comp=clip.GetFusionCompByIndex(1) if clip.GetFusionCompCount() else require(clip.AddFusionComp(),'FUSION_COMP_FAILED')
    require(clip.LoadFusionCompByName(clip.GetFusionCompNameList()[0]),'ACTIVATE_TEXT_COMP_FAILED')
    comp.StartUndo('AIX editable titles and captions');comp.Lock()
    try:
        output=require(comp.FindTool('MediaOut1'),'NO_MEDIA_OUT')
        current=require(comp.FindTool('MediaIn1'),'NO_MEDIA_IN')
        start=comp.GetAttrs().get('COMPN_RenderStart',0)
        for item in row['texts']:
            text=tool(comp,'TextPlus',item['name'])
            for key,value in [('StyledText',item['text']),('Font','PingFang SC'),('Style','Semibold'),('Size',item['size']),('Center',{1:item['x'],2:item['y'],3:0}),('Red1',item['color'][0]),('Green1',item['color'][1]),('Blue1',item['color'][2])]: text.SetInput(key,value)
            merge=tool(comp,'Merge',item['name']+'_Merge')
            merge.Background=current.Output;merge.Foreground=text.Output
            merge.Blend.SetExpression(f'iif(time>={start+item["start"]} and time<{start+item["end"]},1,0)')
            current=merge
        output.Input=current.Output
    finally: comp.Unlock();comp.EndUndo(True)
    require(resolve.OpenPage('edit'),'OPEN_EDIT_FAILED')
    require(resolve.GetProjectManager().SaveProject(),'TEXT_COMMIT_FAILED')
    # Resolve may acknowledge the project save before the just-activated Fusion
    # composition has finished committing. Require the observed clean state.
    for _ in range(20):
        if not comp.GetAttrs()['COMPB_Modified']:break
        time.sleep(.1)
        require(resolve.GetProjectManager().SaveProject(),'TEXT_COMMIT_FAILED')
    require(not comp.GetAttrs()['COMPB_Modified'],'UNCOMMITTED_TEXT')


def prepare(resolve,project,config,ledger,persist):
    pool=project.GetMediaPool();imported=stage_and_import(project,config)
    if ledger.get('timelineId'):
        timelines=[project.GetTimelineByIndex(i) for i in range(1,project.GetTimelineCount()+1)]
        timeline=require(next((t for t in timelines if t.GetUniqueId()==ledger['timelineId']),None),'OWNED_TIMELINE_MISSING')
    else:
        require(project.GetTimelineCount()==0 and not ledger.get('timelineCreationReserved'),'TIMELINE_CREATION_UNKNOWN')
        ledger['timelineCreationReserved']=True;persist()
        timeline=require(pool.CreateEmptyTimeline(config['raw']['timelineName']),'CREATE_TIMELINE_FAILED')
        require(timeline.SetStartTimecode('00:00:00:00'),'SET_START_TIMECODE_FAILED')
        ledger['timelineId']=timeline.GetUniqueId();persist()
    require(project.SetCurrentTimeline(timeline),'SELECT_TIMELINE_FAILED')
    while timeline.GetTrackCount('video')<2: require(timeline.AddTrack('video'),'ADD_TEXT_TRACK_FAILED')
    if not ledger.get('monoNarrationTrackCreated'):
        require(timeline.GetTrackCount('audio')<=1,'UNEXPECTED_AUDIO_TRACKS')
        had_default=timeline.GetTrackCount('audio')==1
        if had_default:
            require(not timeline.GetItemListInTrack('audio',1),'EXISTING_AUDIO_REQUIRES_EXPLICIT_ROUTING_REPAIR')
        require(timeline.AddTrack('audio','mono'),'ADD_MONO_NARRATION_TRACK_FAILED')
        # Resolve will not remove the last audio track. Create mono first, then
        # remove only the verified empty default stereo track.
        if had_default:require(timeline.DeleteTrack('audio',1),'REMOVE_EMPTY_DEFAULT_AUDIO_TRACK_FAILED')
        ledger['monoNarrationTrackCreated']=True;persist()
    timeline.SetTrackName('video',1,'画面 · 720 帧');timeline.SetTrackName('video',2,'标题与中文字幕 · 可编辑');timeline.SetTrackName('audio',1,'普通话旁白 · 48 kHz')
    for track in (1,2):
        existing=timeline.GetItemListInTrack('video',track)
        require(len(existing)<=len(config['scenes']),'UNEXPECTED_VIDEO_ITEMS')
        for index,row in enumerate(config['scenes']):
            item=imported[row['key'] if track==1 else 'overlay'];start=row['sourceStartFrame'] if track==1 else 0
            if index<len(existing):
                clip=existing[index]
                require(clip.GetMediaPoolItem().GetMediaId()==item.GetMediaId(),'TIMELINE_SOURCE_CHANGED_USE_EXPLICIT_REVISION')
            else:
                ledger['appendReservation']={'track':track,'key':row['key']};persist()
                clips=pool.AppendToTimeline([{'mediaPoolItem':item,'mediaType':1,'startFrame':start,'endFrame':start+row['frames']-1,'trackIndex':track,'recordFrame':row['recordFrame']}])
                require(clips and len(clips)==1,'APPEND_VIDEO_UNKNOWN');clip=clips[0]
            require(int(clip.GetStart())==row['recordFrame'] and int(clip.GetDuration())==row['frames'],'VIDEO_TIMING_MISMATCH')
            if track==2: decorate(resolve,project,timeline,clip,row)
    audio=timeline.GetItemListInTrack('audio',1)
    if not audio:
        ledger['appendReservation']={'track':'audio','key':'narration'};persist()
        audio=pool.AppendToTimeline([{'mediaPoolItem':imported['narration'],'mediaType':2,'startFrame':0,'endFrame':719,'trackIndex':1,'recordFrame':0}])
    require(audio and len(audio)==1 and audio[0].GetMediaPoolItem().GetMediaId()==imported['narration'].GetMediaId(),'NARRATION_MAPPING_MISMATCH')
    require(int(audio[0].GetDuration())==720 and int(audio[0].GetStart())==0,'NARRATION_TIMING_MISMATCH')
    ledger.update(phase='timeline-ready',appendReservation=None);persist()
    require(resolve.GetProjectManager().SaveProject(),'SAVE_TIMELINE_FAILED')
    return timeline


def verify(project,config,ledger):
    timeline=project.GetCurrentTimeline()
    require(timeline and timeline.GetUniqueId()==ledger['timelineId'],'WRONG_TIMELINE')
    require(timeline.GetEndFrame()-timeline.GetStartFrame()==720,'TIMELINE_NOT_720_FRAMES')
    for track in (1,2):
        clips=timeline.GetItemListInTrack('video',track)
        require(len(clips)==len(config['scenes']),'TIMELINE_CLIP_COUNT_CHANGED')
        for clip,row in zip(clips,config['scenes']):
            require(clip.GetStart()==row['recordFrame'] and clip.GetDuration()==row['frames'],'TIMELINE_TIMING_CHANGED')
            require(digest_file(clip.GetMediaPoolItem().GetClipProperty('File Path'))==(row['source'] if track==1 else config['overlay'])['sha256'],'TIMELINE_MEDIA_CHANGED')
            if track==2:
                comp=require(clip.GetFusionCompByIndex(1),'TEXT_COMPOSITION_MISSING')
                for text in row['texts']:
                    node=require(comp.FindTool(text['name']),'EDITABLE_TEXT_MISSING')
                    require(node.GetInput('StyledText')==text['text'],'EDITABLE_TEXT_CHANGED')
    audio=timeline.GetItemListInTrack('audio',1)
    require(len(audio)==1 and audio[0].GetStart()==0 and audio[0].GetDuration()==720,'AUDIO_TRACK_MISSING_OR_CHANGED')
    require(digest_file(audio[0].GetMediaPoolItem().GetClipProperty('File Path'))==config['narration']['sha256'],'NARRATION_LINK_CHANGED')
    return {'frames':720,'fps':24,'videoTracks':2,'audioItems':1,'editableTextElements':sum(len(r['texts']) for r in config['scenes']),'mediaHashesMatch':True}


def check_audio_result(actual,reference):
    require(actual['decodeComplete'] and actual['audioTracks']==1 and actual['nonSilent'],'EXPORT_AUDIO_MISSING_OR_SILENT')
    require(actual['clippedSamples']==0 and actual['peakDbFS']<-.1,'EXPORT_AUDIO_CLIPPING')
    levels=actual.get('channelRmsDbFS',[])
    require(actual.get('channels')==2 and len(levels)==2 and min(levels)>-60 and abs(levels[0]-levels[1])<.5,'NARRATION_NOT_CENTERED_IN_STEREO_EXPORT')
    require(abs(actual['firstActiveSeconds']-reference['firstActiveSeconds'])<.12 and abs(actual['lastActiveSeconds']-reference['lastActiveSeconds'])<.12,'NARRATION_TRUNCATED_OR_SHIFTED')
    a=actual['envelope100ms'];b=reference['envelope100ms']
    amap={round(x['time'],1):x['rms'] for x in a};bmap={round(x['time'],1):x['rms'] for x in b}
    pairs=[(amap[k],v) for k,v in bmap.items() if k in amap]
    import math
    cross=sum(x*y for x,y in pairs);den=math.sqrt(sum(x*x for x,y in pairs)*sum(y*y for x,y in pairs))
    similarity=cross/den if den else 0
    require(similarity>.985,'EXPORT_NARRATION_ENVELOPE_MISMATCH')
    return {'fullDecode':True,'nonSilent':True,'clippingSamples':0,'envelopeSimilarity':similarity,'firstAndLastSpeechPreserved':True}


def execute(mode,config,resolve,project_lock):
    ledger_path=config['stateDir']/'ledger.json'
    def emit(**v):print(json.dumps(v,ensure_ascii=False),flush=True)
    if mode=='plan':emit(state='validated-narrated-plan',frames=720,fps=24,audio=True,scenes=len(config['scenes']),newAixGenerations=0);return
    if mode=='status':
        ledger=read_json(ledger_path) if ledger_path.exists() else {};emit(state=ledger.get('phase','planned'),readOnly=True,revision=ledger.get('revision'));return
    with project_lock():
        ledger=read_json(ledger_path) if ledger_path.exists() else {'phase':'planned','configDigest':config['digest'],'revision':config['raw']['revision']}
        def persist():atomic_json(ledger_path,ledger)
        if mode=='revise':
            require(ledger_path.exists() and ledger.get('timelineId'),'NO_OWNED_EDIT_TO_REVISE')
            require(config['raw']['revision']==ledger['revision']+1 and config['raw']['previousDigest']==ledger['configDigest'],'REVISION_CHAIN_MISMATCH')
            old=read_json(config['stateDir']/f'config-r{ledger["revision"]}.json')
            for key in ('jobId','projectName','timelineName','timeline','outputDir','render'):
                require(old[key]==config['raw'][key],'REVISION_IDENTITY_OR_FORMAT_CHANGED')
            require([(r['key'],r['frames'],r['sourceStartFrame']) for r in old['scenes']]==[(r['key'],r['frames'],r['sourceStartFrame']) for r in config['raw']['scenes']],'REVISION_TIMING_CHANGED')
            project=owned_project(resolve,config,ledger,persist)
            require(not project.IsRenderingInProgress(),'REVISION_DURING_RENDER_FORBIDDEN')
            require(project.GetCurrentTimeline().GetUniqueId()==ledger['timelineId'],'REVISION_WRONG_TIMELINE')
            if not ledger.get('revisionPending'):
                atomic_json(config['stateDir']/f'ledger-r{ledger["revision"]}-before-revision.json',ledger)
                ledger['revisionPending']={'from':ledger['configDigest'],'to':config['digest']};persist()
            require(ledger['revisionPending']['to']==config['digest'],'ANOTHER_REVISION_PENDING')
            timeline=project.GetCurrentTimeline();media=config['output']/'media'
            replacements=[]
            for index,(before,after) in enumerate(zip(old['scenes'],config['scenes'])):
                if before['source']['sha256']!=after['source']['sha256']:
                    replacements.append((timeline.GetItemListInTrack('video',1)[index],before['source'],after['source'],after['key']))
            if old['narration']['sha256']!=config['narration']['sha256']:
                replacements.append((timeline.GetItemListInTrack('audio',1)[0],old['narration'],config['narration'],'narration'))
            require(old['overlaySource']['sha256']==config['overlay']['sha256'],'OVERLAY_CARRIER_REVISION_NOT_SUPPORTED')
            for clip,before,after,key in replacements:
                item=clip.GetMediaPoolItem();actual=digest_file(item.GetClipProperty('File Path'))
                require(actual in (before['sha256'],after['sha256']),'REVISION_SOURCE_CHANGED_EXTERNALLY')
                dest=media/(key+'-'+after['sha256'][:10]+Path(after['path']).suffix)
                if not dest.exists():
                    with dest.open('xb') as out,open(after['path'],'rb') as original:shutil.copyfileobj(original,out)
                require(digest_file(dest)==after['sha256'],'REVISION_MEDIA_HASH_MISMATCH')
                if actual!=after['sha256']:require(item.ReplaceClip(str(dest)),'NATIVE_MEDIA_REPLACEMENT_FAILED')
            require(resolve.GetProjectManager().SaveProject(),'REVISION_SAVE_FAILED')
            ledger.setdefault('revisionHistory',[]).append({k:ledger.get(k) for k in ('revision','configDigest','phase','renderJobId','movie','renderSha256')})
            for key in ('renderJobId','renderReservation','renderStartReserved','movie','renderSha256','revisionPending'):ledger.pop(key,None)
            ledger.update(configDigest=config['digest'],revision=config['raw']['revision'],phase='revision-accepted');persist()
        require(ledger['configDigest']==config['digest'],'EDIT_CONFIG_CHANGED_USE_EXPLICIT_REVISION')
        config['output'].mkdir(parents=True,exist_ok=True);persist()
        config_copy=config['stateDir']/f'config-r{ledger["revision"]}.json'
        if config_copy.exists():require(read_json(config_copy)==config['raw'],'RECORDED_REVISION_CONFIG_CHANGED')
        else:atomic_json(config_copy,config['raw'])
        project=owned_project(resolve,config,ledger,persist)
        if mode=='init':emit(state='project-ready');return
        if ledger['phase']=='completed':
            verify(project,config,ledger)
            require(digest_file(ledger['movie'])==ledger['renderSha256'],'COMPLETED_EXPORT_CHANGED')
            def audio_probe(file):
                p=subprocess.run([str(ROOT/'bridge/probe-audio'),str(file)],capture_output=True,text=True)
                require(p.returncode==0,'COMPLETED_AUDIO_DECODE_FAILED');return json.loads(p.stdout)
            check_audio_result(audio_probe(ledger['movie']),audio_probe(config['narration']['path']))
            emit(state='already-completed-verified',newRenders=0);return
        if not ledger.get('renderJobId'):
            prepare(resolve,project,config,ledger,persist);verification=verify(project,config,ledger)
            if mode in ('build','revise'):emit(state='timeline-ready',**verification);return
            require(not ledger.get('renderReservation'),'UNKNOWN_RENDER_RESERVATION')
            name='aix-media-bridge-intro-r'+str(ledger['revision']);movie=config['output']/(name+'.mp4')
            require(not movie.exists(),'OUTPUT_EXISTS_NO_OVERWRITE')
            require(project.SetCurrentRenderFormatAndCodec('mp4','H264'),'H264_UNAVAILABLE');require(project.SetCurrentRenderMode(1),'RENDER_MODE_FAILED')
            require(project.SetRenderSettings({'SelectAllFrames':False,'MarkIn':0,'MarkOut':719,'TargetDir':str(config['output']),'CustomName':name,'ExportVideo':True,'ExportAudio':True,'AudioCodec':'aac','AudioSampleRate':48000,'FormatWidth':1280,'FormatHeight':720,'FrameRate':24,'VideoQuality':16000,'NetworkOptimization':True}),'AUDIO_RENDER_SETTINGS_REJECTED')
            ledger['renderReservation']=True;persist()
            job=require(project.AddRenderJob(),'RENDER_JOB_RESULT_UNKNOWN')
            ledger.update(renderJobId=job,renderSubmissions=ledger.get('renderSubmissions',0)+1,movie=str(movie));persist()
        job=ledger['renderJobId'];status=project.GetRenderJobStatus(job)
        if status.get('JobStatus') not in ('Complete','完成') and not project.IsRenderingInProgress():
            require(not ledger.get('renderStartReserved'),'UNKNOWN_OR_FAILED_RENDER_DO_NOT_REQUEUE')
            ledger['renderStartReserved']=True;persist();require(project.StartRendering(job),'START_RENDER_FAILED')
        for _ in range(600):
            status=project.GetRenderJobStatus(job)
            if status.get('JobStatus') in ('Complete','完成'):break
            if status.get('JobStatus') in ('Failed','失败','Cancelled','已取消'):raise RuntimeError('NATIVE_RENDER_FAILED')
            time.sleep(1)
        else: raise RuntimeError('RENDER_PENDING_RESUME_ORIGINAL_JOB')
        verification=verify(project,config,ledger);movie=Path(ledger['movie'])
        def probe(binary,file,*args):
            p=subprocess.run([str(ROOT/'bridge'/binary),str(file),*args],capture_output=True,text=True)
            require(p.returncode==0,'NATIVE_DECODE_FAILED_'+binary);return json.loads(p.stdout)
        video=probe('probe-video',movie,'30');audio=probe('probe-audio',movie);reference=probe('probe-audio',config['narration']['path'])
        require(video['decodedFrames']==720 and video['decodeComplete'] and video['nominalFrameRate']==24 and (video['width'],video['height'])==(1280,720) and abs(video['videoTrackDurationSeconds']-30)<.001,'FINAL_VIDEO_NOT_EXACT')
        audio_check=check_audio_result(audio,reference)
        require(resolve.GetProjectManager().SaveProject(),'FINAL_SAVE_FAILED')
        backup=config['output']/('aix-media-bridge-intro-r'+str(ledger['revision'])+'-private.drp')
        require(not backup.exists(),'BACKUP_EXISTS_NO_OVERWRITE')
        require(resolve.GetProjectManager().ExportProject(project.GetName(),str(backup),False),'DRP_EXPORT_FAILED')
        result={'state':'completed','sourceVersion':json.loads((ROOT/'package.json').read_text())['version'],'resolveVersion':resolve.GetVersionString(),'movie':str(movie),'backup':str(backup),'backupIsPrivate':True,'video':video,'audio':audio,'audioComparison':audio_check,'timeline':verification,'renderSubmissions':ledger['renderSubmissions'],'visualReviewRequired':True}
        atomic_json(config['output']/'resolve-result.json',result)
        ledger.update(phase='completed',renderSha256=digest_file(movie));persist();resolve.OpenPage('edit')
        emit(state='completed',movie=str(movie),backup=str(backup),**verification)
