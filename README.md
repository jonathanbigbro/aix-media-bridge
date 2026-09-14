# AIX Media Bridge 0.5.0 — macOS preview

Version 0.5.0 adds independent Mandarin TTS, word-timed subtitles, editable Resolve text/audio tracks and native AAC export. See [the narrated workflow](docs/NARRATED-VIDEO.md). One new AIX job and a separate voiced editing project were verified on the same Mac, with recorded recovery interventions. The intro remains a workflow validation sample; its visual style was not approved as a promotional example. Sealed 0.4.2 artifacts are unchanged.

A local macOS CLI and project skill for making images and videos in your own logged-in AIX browser session. The workflow uploads one PNG, prepares and checks native Agent cards, generates one PRO image and one Seedance video, downloads the original video once, and verifies the saved canvas and local file.

The local editing adapter continues into a new DaVinci Resolve project, a 24 fps timeline and a native MP4 export. Includes an account-redacted 15-second story case and preview frames. [中文完整上手指南](docs/QUICKSTART.zh-CN.md) · [Case video and explanation](examples/aix-story/README.md) · [Release notes](docs/CHANGELOG.md).

This is an early release for **macOS, Node.js >=22.12.0, Chrome and AIX in Simplified Chinese**. It uses the native AIX interface through Chrome DevTools MCP. It is not an official AIX API client. Browser login and Chrome authorization remain on your computer.

0.4.2 fixes concurrent status commands overwriting production ledgers. Status is now local and read-only throughout the CLI/daemon/operation chain, with no browser target binding. All job mutations and result invalidation use verified task ownership and an exclusive mutation transaction. The 0.4.1 parameter and image-card guards remain enabled. See the [lock protocol](docs/CONCURRENCY.md) and exact [validation scope](docs/VALIDATION.md). The 0.5.0 production path completed after native-card, history and HTTP-status compatibility repairs; this is not an unattended first-run or cross-machine claim.

## Install

Install Node.js >=22.12.0, Python 3.9+ and the Apple command-line tools providing `swiftc`. The editing stage also needs a supported local DaVinci Resolve Studio scripting installation; Studio 19 was tested. Open a terminal in this repository:

```sh
npm run setup
npm run test:all
npm run doctor
npm run bridge
```

Keep the bridge running in that terminal. Open `https://aix.studio/AixCanvas` in your logged-in Chrome profile. Approve Chrome's remote-debugging prompt when requested. In a second terminal:

```sh
npm run doctor -- --live
npm run project -- create --key demo --name "AIX Demo"
```

To use an existing canvas, open it in AIX and run `npm run project -- bind --key demo`, or select it by its exact, unique name:

```sh
npm run project -- select --key demo --name "My Canvas"
npm run project -- open --key demo
npm run project -- list
```

If several AIX canvas tabs are open, use `npm run project -- pages`, then add `--page NUMBER` to the project command. Media commands identify the bound canvas by its stored identity. Project names in history must be unique among the matching visible entries; ambiguous names fail closed.

`create` records its attempt before clicking. Repeating the same key and name returns the existing binding or reconciles the original attempt. An unknown result is not permission to create another canvas. Save any ongoing edits and finish active generation before switching canvases.

## Make a video

The repository includes a synthetic reference image without account information.

```sh
mkdir -p configs
cp examples/media-job.template.json configs/MY-MEDIA-001.json
```

Edit the job ID, `project.key`, prompts, reference path and output directory. The template uses project key `demo`, one PRO image and a 5-second video. Relative paths are resolved from the configuration file's directory.

```sh
npm run media -- plan --job configs/MY-MEDIA-001.json
npm run media -- run --job configs/MY-MEDIA-001.json
```

Only run after `plan` returns `validated-plan`. Plan does not upload, chat or generate. Generation uses account credits in AIX. Each job permits one upload, one image Agent request, one image submission, one video Agent request, one video submission and one native video download.

```sh
npm run media -- status --job configs/MY-MEDIA-001.json
npm run media -- resume --job configs/MY-MEDIA-001.json
```

A submitted-parameter mismatch or missing required historical evidence persists as `blocked-submitted-parameters`. Run, resume, asset checks, completed recovery and manifest creation enforce it. Status reports a local diagnostic snapshot without changing ledger/result/manifest bytes or accessing the browser; existing assets and original request evidence are retained. During a locked run/resume or verification, a previously misleading completed manifest is marked blocked and its original bytes are kept in a private invalidated-result copy. Do not edit the original request to clear the block. Native output duration drift is recorded separately.

A repeated job reuses its ledger. Do not change its configuration or reference bytes after it starts. Do not delete its ledger or invent another ID to retry an unknown result. Completed jobs only reconcile and verify; they do not generate again. Unknown states may require inspection in the original AIX session. Recovery after every possible browser or server failure is not guaranteed.

## Supported media

| Item | Supported values |
|---|---|
| Input | One PNG, at most 5 MiB; each dimension at most 4096 |
| Image | PRO / `main_image` / workflow `248`; 16:9, 2k, one image |
| Video | Seedance2.0（真人） / `1888` / workflow `225`; 4 or 5 seconds, 16:9, 720p, one video |
| Photography and lighting | The fixed combination in the template; AIX prompt descriptions, not independent camera controls |
| Output | Original image, original native video, reference copy and JSON manifest |

Requested duration and measured duration are separate. The manifest reports container duration, video-track duration and browser duration. Native results may differ slightly from the requested whole seconds. Files are not trimmed or transcoded. Frame decoding and identity/hash checks do not replace visual review of the creative result.

Other operating systems, models, aspect ratios, multi-reference input, batch generation, team-canvas administration and server-side cancellation recovery are outside this release's validation scope. The interface must provide the native manual-confirmation mode; if unavailable, generation stops.

## Continue in DaVinci Resolve

A local Python adapter imports completed AIX image/video pairs into a new Resolve project, assembles each video into a 5-second segment, applies configured Fusion privacy masks and exports a native MP4 plus an editable local project backup. Requires Python 3.9+ and a supported Resolve Studio scripting installation; tested on Studio 19.

```sh
npm run edit -- doctor
npm run edit -- plan --job configs/MY-EDIT-001.json
npm run edit -- run --job configs/MY-EDIT-001.json
npm run test:resolve
```

Copy the [configuration template](examples/resolve-job.template.json) into `configs/`, point it to your completed AIX manifests, and follow the [Resolve workflow and validation](docs/DAVINCI.md). The included movie is a reviewed showcase; private source media and native project backups are not included.

## Local data and publishing

- `.aix/` contains local project bindings, creation attempts, bridge logs and temporary pipe directories.
- `jobs/` contains task ledgers, prompts and sanitized protocol evidence. `outputs/` contains generated media and manifests.
- `configs/` and `inputs/` are private working directories, excluded from the distributable.
- No login cookie or API token is required in configuration. Authentication stays in Chrome. Network headers are excluded from persisted evidence. Local prompts, canvas names and media can still be personal, so runtime folders are never published.
- Chrome's download directory defaults to your `Downloads` folder. Set `AIX_DOWNLOAD_DIR` to an alternate directory before starting the bridge and media CLI if needed. Set the same `AIX_STATE_DIR` for both only when deliberately selecting a different local state directory. Neither directory belongs in a release.

Builds use an explicit file allowlist, reject symlinks and scan the selected bytes. The zip is made from the same audited bytes and contains no original Git history or runtime folders. See [release procedure](docs/RELEASING.md) and [validation record](docs/VALIDATION.md).

Only the four previously reviewed media files listed in `scripts/release-media.json` are allowed as real case assets. The builder checks their exact hashes and review record. Changed or additional media requires a fresh visual and metadata review. The package contains source code, not a bundled Chrome, Resolve, Python or Node installation.

## Project skill

The skill is included at `.agents/skills/aix-media-workflow/SKILL.md`. It lives with the CLI so it can resolve this repository without machine-specific paths. Example:

> Use aix-media-workflow to make a 5-second video from this PNG in my bound `demo` canvas, with a slow camera push-in.

## Stop

```sh
npm run stop
```

Shutdown refuses while a job lock is owned by a running process or the selected canvas is busy. Keep the original browser session and local ledgers when recovering a job. A stale socket is reported for inspection rather than overwritten.

## License

[MIT](LICENSE).
