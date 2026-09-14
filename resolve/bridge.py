#!/usr/bin/env python3
"""Verified AIX media -> a new local Resolve project -> native MP4 render."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
from pathlib import Path
import subprocess
import sys
import time

from common import ROOT, STATE, atomic_json, connect, digest_file, load_config, read_json, segments
from native import decorate_clip, import_sources, owned_project, prepare_timeline, render_settings, require, verify_timeline

def now():
    return datetime.now(timezone.utc).isoformat()

def emit(**value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

@contextmanager
def project_lock():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / '.lock').open('a') as file:
        try:
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('ANOTHER_RESOLVE_EDIT_IS_ACTIVE')
        yield

def check_ledger(config):
    path = config['stateDir'] / 'ledger.json'
    ledger = read_json(path) if path.exists() else {'schemaVersion': 1, 'configDigest': config['digest'], 'phase': 'planned', 'createdAt': now()}
    require(ledger['configDigest'] == config['digest'], 'EDIT_CONFIG_OR_SOURCE_CHANGED_DO_NOT_REBUILD')
    if ledger.get('sourceDigest'):
        require(ledger['sourceDigest'] == config['sourceDigest'], 'EDIT_SOURCE_SET_CHANGED_DO_NOT_REIMPORT')
    return path, ledger

def render_state(project, ledger):
    if not ledger.get('renderJobId'):
        require(not ledger.get('renderReservation'), 'RENDER_JOB_UNKNOWN_INSPECT_ORIGINAL_QUEUE')
        return None
    jobs = [x for x in project.GetRenderJobList() if x.get('JobId') == ledger['renderJobId']]
    require(len(jobs) == 1, 'ORIGINAL_RENDER_JOB_MISSING_DO_NOT_REQUEUE')
    status = project.GetRenderJobStatus(ledger['renderJobId'])
    native = status.get('JobStatus')
    status['nativeStatus'] = native
    status['JobStatus'] = {'完成': 'Complete', '失败': 'Failed', '已取消': 'Cancelled', '取消': 'Cancelled'}.get(native, native)
    return status

def finalize(resolve, project, config, ledger, persist):
    verification = verify_timeline(project, config, ledger)
    movie = config['output'] / 'aix-story.mp4'
    require(movie.is_file() and movie.stat().st_size > 0, 'NATIVE_RENDER_FILE_MISSING')
    probe = subprocess.run([str(ROOT / 'bridge/probe-video'), str(movie), str(verification['frames'] / 24)], capture_output=True, text=True)
    require(probe.returncode == 0, 'RENDER_DECODE_FAILED')
    data = json.loads(probe.stdout)
    require(data['decodeComplete'] and data['decodedFrames'] == verification['frames'], 'RENDER_FRAME_COUNT_MISMATCH')
    require(data['width'] == 1280 and data['height'] == 720, 'RENDER_RESOLUTION_MISMATCH')
    require(abs(data['durationSeconds'] - verification['frames'] / 24) <= 1 / 24, 'RENDER_DURATION_MISMATCH')
    review_config = config['stateDir'] / 'review-config.json'
    atomic_json(review_config, config['raw'])
    review = subprocess.run([str(ROOT / 'bridge/review-video'), str(movie), str(review_config), str(config['output'] / 'qa/pixel-review')], capture_output=True, text=True)
    require(review.returncode == 0, 'RENDER_PIXEL_REVIEW_FAILED_KEEP_ORIGINAL_JOB')
    pixels = json.loads(review.stdout)
    require(pixels['audioTracks'] == 0, 'UNEXPECTED_AUDIO_TRACK')
    require(resolve.GetProjectManager().SaveProject(), 'FINAL_PROJECT_SAVE_FAILED')
    backup = config['output'] / 'aix-story-local.drp'
    if not backup.exists():
        require(resolve.GetProjectManager().ExportProject(project.GetName(), str(backup), False), 'PROJECT_BACKUP_EXPORT_FAILED')
    ledger.update(phase='completed', renderSha256=digest_file(movie), completedAt=ledger.get('completedAt', now()), lastVerifiedAt=now())
    persist()
    result = {'schemaVersion': 1, 'state': 'completed', 'application': resolve.GetProductName(), 'version': resolve.GetVersionString(),
              'projectName': config['raw']['projectName'], 'timelineName': config['raw']['timelineName'],
              'videoPath': str(movie), 'localProjectBackup': str(backup), 'projectBackupPublishable': False,
              'video': data, 'timeline': verification, 'pixelReview': pixels, 'projectCreations': ledger['projectCreations'],
              'renderSubmissions': ledger['renderSubmissions'], 'renderStatus': 'Complete',
              'sourceCases': [{'key': c['key'], 'title': c['title'], 'hashes': {k: a['sha256'] for k, a in c['assets'].items()}} for c in config['cases']],
              'privacy': {'masksConfigured': list(config['raw']['privacy']), 'visualReviewRequired': True,
                          'publicationAuthorizedNow': False, 'localProjectContainsMachinePaths': True}, 'verifiedAt': now()}
    atomic_json(config['output'] / 'resolve-result.json', result)
    emit(state='completed', videoPath=str(movie), projectBackup=str(backup), frames=verification['frames'], seconds=verification['frames'] / 24,
         projectCreations=ledger['projectCreations'], renderSubmissions=ledger['renderSubmissions'])
    resolve.OpenPage('edit')

def execute(mode, config):
    if config['raw']['schemaVersion'] == 2:
        from narrated import execute as execute_narrated
        return execute_narrated(mode, config, connect(), project_lock)
    path, ledger = check_ledger(config)
    def persist():
        atomic_json(path, ledger)
    resolve = connect()
    if mode == 'plan':
        emit(state='validated-edit-plan', sourceCases=len(config['cases']), sourceFiles=2 * len(config['cases']),
             timelineFrames=sum(r['frames'] for r in segments(config)), fps=24, newAixGenerations=0,
             projectName=config['raw']['projectName'], existingLocalLedger=path.exists(), mutatingActionsExecuted=False)
        return
    if mode == 'status':
        project = resolve.GetProjectManager().GetCurrentProject()
        status = render_state(project, ledger) if project and project.GetUniqueId() == ledger.get('projectId') else None
        emit(state=ledger['phase'], render=status, boundProjectIsOpen=bool(project and project.GetUniqueId() == ledger.get('projectId')))
        return
    if mode == 'resume':
        require(path.exists(), 'NO_EDIT_LEDGER_USE_RUN')
    with project_lock():
        persist()
        try:
            if mode != 'init':
                require((ROOT / 'bridge/probe-video').is_file() and (ROOT / 'bridge/review-video').is_file(), 'RUN_SETUP_TO_COMPILE_MEDIA_CHECKS')
            config['output'].mkdir(parents=True, exist_ok=True, mode=0o700)
            project = owned_project(resolve, config, ledger, persist)
            if mode == 'init':
                if ledger['phase'] == 'planned':
                    ledger['phase'] = 'project-ready'
                persist()
                emit(state='project-ready', projectName=config['raw']['projectName'], sourceCasesReady=sum(bool(c['assets']) for c in config['cases']),
                     sourceCasesRequired=len(config['cases']), newGenerations=0)
                return
            require(config['ready'], 'WAIT_FOR_COMPLETED_AIX_SOURCE_JOBS')
            ledger['sourceDigest'] = config['sourceDigest']
            persist()
            if ledger['phase'] == 'completed':
                require(digest_file(config['output'] / 'aix-story.mp4') == ledger['renderSha256'], 'COMPLETED_RENDER_CHANGED')
                verify_timeline(project, config, ledger)
                emit(state='already-completed-verified', newProjects=0, newImports=0, newRenders=0, videoPath=str(config['output'] / 'aix-story.mp4'))
                return
            if not ledger.get('renderJobId'):
                imported = import_sources(project, config)
                timeline = prepare_timeline(project, config, ledger, persist, imported)
                reports = []
                for index, (clip, row) in enumerate(zip(timeline.GetItemListInTrack('video', 1), segments(config))):
                    seconds, frame = divmod(row['recordFrame'], 24)
                    require(timeline.SetCurrentTimecode(f'00:{seconds // 60:02d}:{seconds % 60:02d}:{frame:02d}'), 'FUSION_CLIP_SELECTION_FAILED')
                    require(resolve.OpenPage('fusion'), 'FUSION_PAGE_UNAVAILABLE')
                    reports.append(decorate_clip(clip, row, config, index))
                    require(resolve.OpenPage('edit'), 'EDIT_PAGE_UNAVAILABLE')
                    require(resolve.GetProjectManager().SaveProject(), 'COMPOSITION_COMMIT_FAILED')
                    if reports[-1]['privacyMask']:
                        require(not clip.GetFusionCompByIndex(1).GetAttrs()['COMPB_Modified'], 'FUSION_CHANGES_NOT_COMMITTED')
                ledger['decorations'] = reports
                ledger['phase'] = 'timeline-ready'
                persist()
                verify_timeline(project, config, ledger)
                require(resolve.GetProjectManager().SaveProject(), 'TIMELINE_SAVE_FAILED')
                resolve.OpenPage('edit')
                if mode == 'build':
                    emit(state='timeline-ready', clips=len(reports), frames=ledger['timelineFrames'], renderSubmitted=False)
                    return
                require(not ledger.get('renderReservation'), 'RENDER_RESERVATION_EXISTS_DO_NOT_REQUEUE')
                require(not (config['output'] / 'aix-story.mp4').exists(), 'OUTPUT_EXISTS_DO_NOT_OVERWRITE')
                render_settings(project, config)
                ledger['renderReservation'] = True
                persist()
                job = require(project.AddRenderJob(), 'ADD_RENDER_JOB_RESULT_UNKNOWN')
                ledger.update(renderJobId=job, renderSubmissions=ledger.get('renderSubmissions', 0) + 1, phase='render-queued')
                persist()
            status = render_state(project, ledger)
            if status.get('JobStatus') != 'Complete' and not project.IsRenderingInProgress():
                require(not ledger.get('renderStartReserved'), 'RENDER_START_RESULT_UNKNOWN_OR_FAILED_INSPECT_ORIGINAL_JOB')
                ledger['renderStartReserved'] = True
                persist()
                require(project.StartRendering(ledger['renderJobId']), 'NATIVE_RENDER_START_FAILED')
                ledger['phase'] = 'rendering'
                persist()
            for _ in range(150):
                status = render_state(project, ledger)
                emit(state='render-status', status=status.get('JobStatus'), percent=status.get('CompletionPercentage'))
                if status.get('JobStatus') == 'Complete':
                    finalize(resolve, project, config, ledger, persist)
                    return
                require(status.get('JobStatus') not in ('Failed', 'Cancelled'), 'ORIGINAL_NATIVE_RENDER_FAILED_NO_REQUEUE')
                time.sleep(2)
            emit(state='render-still-active-use-status-or-resume')
        except Exception as error:
            atomic_json(config['stateDir'] / 'last-error.json', {'at': now(), 'phase': ledger['phase'], 'error': str(error),
                                                               'instruction': 'Keep the same project, configuration and ledger. Never delete the ledger to retry.'})
            raise

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['doctor', 'init', 'plan', 'build', 'run', 'status', 'resume', 'revise'])
    parser.add_argument('--job')
    args = parser.parse_args()
    if args.mode == 'doctor':
        r = connect()
        emit(state='resolve-connected', product=r.GetProductName(), version=r.GetVersionString(), currentPage=r.GetCurrentPage(),
             decoderInstalled=(ROOT / 'bridge/probe-video').is_file(), pixelReviewerInstalled=(ROOT / 'bridge/review-video').is_file(), externalNetworkUsed=False)
        return
    require(args.job, 'JOB_CONFIG_REQUIRED')
    execute(args.mode, load_config(args.job, allow_pending=args.mode == 'init'))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit(state='not-completed-keep-original-project', error=str(error))
        sys.exit(2)
