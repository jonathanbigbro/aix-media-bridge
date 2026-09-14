"""Operations on an owned Resolve project; never deletes projects or render jobs."""
from pathlib import Path
import shutil
from common import atomic_json, digest_file, segments

def require(value, message):
    if not value:
        raise RuntimeError(message)
    return value

def project_settings(project):
    for key, value in [('timelineResolutionWidth', '1280'), ('timelineResolutionHeight', '720'), ('timelineFrameRate', '24')]:
        current = project.GetSetting(key)
        if float(current) != float(value):
            require(project.SetSetting(key, value), 'PROJECT_SETTING_REJECTED_' + key)
        require(float(project.GetSetting(key)) == float(value), 'PROJECT_SETTING_NOT_VERIFIED_' + key)

def preserve_current(manager):
    current = manager.GetCurrentProject()
    if not current:
        return
    require(not current.IsRenderingInProgress(), 'CURRENT_PROJECT_IS_RENDERING')
    pool = current.GetMediaPool().GetRootFolder()
    empty = current.GetTimelineCount() == 0 and not pool.GetClipList() and not pool.GetSubFolderList()
    if current.GetName() != 'Untitled Project' or not empty:
        require(manager.SaveProject(), 'SAVE_CURRENT_PROJECT_BEFORE_SWITCHING')

def owned_project(resolve, config, ledger, persist):
    manager = resolve.GetProjectManager()
    name = config['raw']['projectName']
    project = manager.GetCurrentProject()
    if ledger.get('projectId'):
        if not project or project.GetUniqueId() != ledger['projectId']:
            preserve_current(manager)
            project = require(manager.LoadProject(name), 'OWNED_PROJECT_NOT_FOUND')
        require(project.GetUniqueId() == ledger['projectId'], 'RESOLVE_PROJECT_ID_MISMATCH')
        project_settings(project)
        return project
    require(not ledger.get('projectCreationReserved'), 'PROJECT_CREATION_UNKNOWN_DO_NOT_RECREATE')
    require(name not in manager.GetProjectListInCurrentFolder(), 'PROJECT_NAME_ALREADY_EXISTS')
    preserve_current(manager)
    ledger['projectCreationReserved'] = True
    persist()
    project = require(manager.CreateProject(name), 'CREATE_PROJECT_RESULT_UNKNOWN')
    ledger['projectId'] = project.GetUniqueId()
    ledger['projectCreations'] = 1
    persist()
    project_settings(project)
    require(manager.SaveProject(), 'PROJECT_INITIAL_SAVE_FAILED')
    return project

def import_sources(project, config):
    media = config['output'] / 'media'
    media.mkdir(parents=True, exist_ok=True, mode=0o700)
    pool = project.GetMediaPool()
    root = pool.GetRootFolder()
    folders = [f for f in root.GetSubFolderList() if f.GetName() == 'AIX Sources']
    require(len(folders) <= 1, 'DUPLICATE_SOURCE_FOLDERS')
    folder = folders[0] if folders else require(pool.AddSubFolder(root, 'AIX Sources'), 'SOURCE_FOLDER_CREATE_FAILED')
    require(pool.SetCurrentFolder(folder), 'SOURCE_FOLDER_SELECTION_FAILED')
    imported = {}
    for case in config['cases']:
        for role in ('image', 'video'):
            asset = case['assets'][role]
            source = Path(asset['path'])
            dest = media / (case['key'] + ('-still' if role == 'image' else '-motion') + source.suffix.lower())
            if not dest.exists():
                with dest.open('xb') as f, source.open('rb') as original:
                    shutil.copyfileobj(original, f)
                dest.chmod(0o600)
            require(digest_file(dest) == asset['sha256'], 'STAGED_MEDIA_CHANGED')
            matches = [c for c in folder.GetClipList() if c.GetClipProperty('File Path') == str(dest)]
            require(len(matches) <= 1, 'DUPLICATE_IMPORTED_MEDIA')
            if matches:
                clip = matches[0]
            else:
                clips = pool.ImportMedia([str(dest)])
                require(clips and len(clips) == 1, 'SOURCE_IMPORT_FAILED')
                clip = clips[0]
            imported[(case['key'], role)] = clip
    return imported

def prepare_timeline(project, config, ledger, persist, imported):
    pool = project.GetMediaPool()
    if ledger.get('timelineId'):
        timelines = [project.GetTimelineByIndex(i) for i in range(1, project.GetTimelineCount() + 1)]
        timeline = require(next((t for t in timelines if t.GetUniqueId() == ledger['timelineId']), None), 'OWNED_TIMELINE_MISSING')
    else:
        require(project.GetTimelineCount() == 0, 'UNEXPECTED_TIMELINE_NO_RECREATE')
        require(not ledger.get('timelineCreationReserved'), 'TIMELINE_CREATION_UNKNOWN')
        ledger['timelineCreationReserved'] = True
        persist()
        timeline = require(pool.CreateEmptyTimeline(config['raw']['timelineName']), 'TIMELINE_CREATE_FAILED')
        require(timeline.SetStartTimecode('00:00:00:00'), 'TIMELINE_START_TIMECODE_FAILED')
        ledger['timelineId'] = timeline.GetUniqueId()
        persist()
    require(project.SetCurrentTimeline(timeline), 'CURRENT_TIMELINE_FAILED')
    expected = segments(config)
    existing = timeline.GetItemListInTrack('video', 1)
    require(len(existing) <= len(expected), 'UNEXPECTED_EXTRA_TIMELINE_ITEMS')
    for index, row in enumerate(expected):
        item = imported[(row['case']['key'], 'video')]
        if index < len(existing):
            clip = existing[index]
            require(clip.GetMediaPoolItem().GetMediaId() == item.GetMediaId(), 'TIMELINE_SOURCE_MISMATCH')
        else:
            # Record position and source first. After an interrupted append, the
            # exact existing clip is verified instead of blindly appending again.
            ledger['appendReserved'] = row['key']
            persist()
            clips = pool.AppendToTimeline([{'mediaPoolItem': item, 'startFrame': 0, 'endFrame': row['frames'] - 1,
                                          'mediaType': 1, 'trackIndex': 1, 'recordFrame': row['recordFrame']}])
            require(clips and len(clips) == 1, 'APPEND_RESULT_UNKNOWN')
            clip = clips[0]
        require(int(clip.GetDuration()) == row['frames'] and int(clip.GetStart()) == row['recordFrame'], 'TIMELINE_TIMING_MISMATCH')
    ledger['timelineFrames'] = sum(row['frames'] for row in expected)
    ledger['appendReserved'] = None
    persist()
    require(int(timeline.GetEndFrame() - timeline.GetStartFrame()) == ledger['timelineFrames'], 'TIMELINE_END_MISMATCH')
    return timeline

def tool(comp, identifier, name):
    existing = comp.FindTool(name)
    if existing:
        require(existing.ID == identifier, 'UNEXPECTED_FUSION_TOOL_TYPE')
        return existing
    value = require(comp.AddTool(identifier, -32768, -32768), 'FUSION_TOOL_UNAVAILABLE_' + identifier)
    value.SetAttrs({'TOOLS_Name': name})
    return value

def expression(points, column, start_frame, fps):
    result = str(points[-1][column])
    for left, right in reversed(list(zip(points, points[1:]))):
        start, end = left[0] * fps + start_frame, right[0] * fps + start_frame
        linear = f'({left[column]}+({right[column]-left[column]})*min(max((time-{start})/{end-start},0),1))'
        result = f'iif(time<={end},{linear},{result})'
    return result

def decorate_clip(clip, row, config, index):
    comp = clip.GetFusionCompByIndex(1) if clip.GetFusionCompCount() else clip.AddFusionComp()
    require(comp, 'FUSION_COMPOSITION_UNAVAILABLE')
    require(clip.LoadFusionCompByName(clip.GetFusionCompNameList()[0]), 'FUSION_COMPOSITION_ACTIVATION_FAILED')
    media = require(comp.FindTool('MediaIn1'), 'MEDIA_INPUT_NOT_FOUND')
    output = require(comp.FindTool('MediaOut1'), 'MEDIA_OUTPUT_NOT_FOUND')
    comp.StartUndo('AIX privacy treatment')
    comp.Lock()
    try:
        current = media
        points = config['raw']['privacy'].get(row['case']['key'], {}).get('video')
        if points:
            attrs = comp.GetAttrs()
            start = attrs.get('COMPN_RenderStart', 0)
            mask = tool(comp, 'RectangleMask', 'AIX_PrivacyRegion')
            mask.SetInput('SoftEdge', 0)
            mask.SetInput('CornerRadius', 0)
            mask.Center.SetExpression('Point(' + expression(points, 1, start, 24) + ',' + expression(points, 2, start, 24) + ')')
            for name, column in [('Width', 3), ('Height', 4), ('Angle', 5)]:
                getattr(mask, name).SetExpression(expression(points, column, start, 24))
            fill = tool(comp, 'Background', 'AIX_PrivacyFill')
            for name, value in [('Width', 1280), ('Height', 720), ('TopLeftRed', 0.004), ('TopLeftGreen', 0.005), ('TopLeftBlue', 0.005), ('TopLeftAlpha', 1)]:
                fill.SetInput(name, value)
            fill.EffectMask = mask.Mask
            merge = tool(comp, 'Merge', 'AIX_PrivacyMerge')
            merge.Background = current.Output
            merge.Foreground = fill.Output
            current = merge
        output.Input = current.Output
    finally:
        comp.Unlock()
        comp.EndUndo(True)
    return {'case': row['case']['key'], 'frames': row['frames'], 'privacyMask': bool(points), 'fusionTools': len(comp.GetToolList(False))}

def verify_timeline(project, config, ledger):
    timeline = project.GetCurrentTimeline()
    require(timeline and timeline.GetUniqueId() == ledger['timelineId'], 'WRONG_CURRENT_TIMELINE')
    clips = timeline.GetItemListInTrack('video', 1)
    rows = segments(config)
    require(len(clips) == len(rows), 'UNEXPECTED_TIMELINE_ITEM_COUNT')
    for clip, row in zip(clips, rows):
        require(int(clip.GetDuration()) == row['frames'] and int(clip.GetStart()) == row['recordFrame'], 'TIMELINE_TIMING_CHANGED')
        source = Path(clip.GetMediaPoolItem().GetClipProperty('File Path'))
        require(digest_file(source) == row['case']['assets']['video']['sha256'], 'TIMELINE_SOURCE_BYTES_CHANGED')
        if config['raw']['privacy'].get(row['case']['key'], {}).get('video'):
            comp = clip.GetFusionCompByIndex(1)
            require(comp and comp.FindTool('AIX_PrivacyMerge') and comp.FindTool('AIX_PrivacyRegion'), 'PRIVACY_MASK_MISSING')
            mask = comp.FindTool('AIX_PrivacyRegion')
            fill = comp.FindTool('AIX_PrivacyFill')
            merge = comp.FindTool('AIX_PrivacyMerge')
            points = config['raw']['privacy'][row['case']['key']]['video']
            start = comp.GetAttrs().get('COMPN_RenderStart', 0)
            expected = 'Point(' + expression(points, 1, start, 24) + ',' + expression(points, 2, start, 24) + ')'
            require(mask.Center.GetExpression() == expected, 'PRIVACY_TRACKING_CHANGED')
            for name, column in [('Width', 3), ('Height', 4), ('Angle', 5)]:
                require(getattr(mask, name).GetExpression() == expression(points, column, start, 24), 'PRIVACY_GEOMETRY_CHANGED')
            for name, value in [('TopLeftRed', .004), ('TopLeftGreen', .005), ('TopLeftBlue', .005), ('TopLeftAlpha', 1)]:
                require(fill and abs(fill.GetInput(name) - value) < .00001, 'PRIVACY_FILL_CHANGED')
            for input_port, name in [(fill.EffectMask, 'AIX_PrivacyRegion'), (merge.Foreground, 'AIX_PrivacyFill'),
                                     (merge.Background, 'MediaIn1'), (comp.FindTool('MediaOut1').Input, 'AIX_PrivacyMerge')]:
                connection = input_port.GetConnectedOutput()
                require(connection and connection.GetTool().Name == name, 'PRIVACY_CONNECTION_CHANGED')
    return {'clipCount': len(clips), 'frames': sum(r['frames'] for r in rows), 'fps': 24, 'sourceHashesMatch': True}

def render_settings(project, config):
    require(not project.IsRenderingInProgress(), 'RENDER_ALREADY_ACTIVE')
    require(project.SetCurrentRenderFormatAndCodec('mp4', 'H264'), 'NATIVE_H264_MP4_UNAVAILABLE')
    require(project.SetCurrentRenderMode(1), 'SINGLE_CLIP_MODE_FAILED')
    require(project.SetRenderSettings({'SelectAllFrames': True, 'TargetDir': str(config['output']), 'CustomName': 'aix-story',
                                      'ExportVideo': True, 'ExportAudio': False, 'FormatWidth': 1280, 'FormatHeight': 720,
                                      'FrameRate': 24, 'VideoQuality': 16000, 'NetworkOptimization': True}), 'RENDER_SETTINGS_REJECTED')
