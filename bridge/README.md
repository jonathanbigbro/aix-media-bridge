# Runtime implementation

Use the commands in the [root README](../README.md). The public entry points are `project.mjs`, `media-run.mjs` and `daemon.mjs`.

`job-config.mjs` validates the task and resolves its local project binding. `media-ops.mjs` owns native UI interactions and writes each irreversible reservation before it executes. `job-run.mjs` coordinates progress and builds the result manifest. `network-full.mjs` uses 0600 named pipes to read observed JSON request/response bodies without persisting headers or raw body files. `probe-video.swift` decodes every video frame and computes SHA-256.

Schema 2 uses `project: {"key": "demo"}`. Schema 1 configurations with an explicit name and canvas alias can be read only after that same canvas has been registered locally. Rebinding a key to a different identity fails. Historical test directories are not runtime dependencies or part of the public distribution.

Only reviewed operations are dispatched by the release bridge. Arbitrary evaluation scripts and arbitrary network request replay are not public entry points. Unknown or ambiguous UI state stops the workflow; it is not retried as another generation job.

`generation-validation.mjs` checks persisted acknowledgements and immutable original request evidence at every production/completion boundary. `image-card.mjs` reads current native card evidence and rechecks it immediately before confirmation. It recognizes explicit message state or the captured pure active-message getter; unfamiliar component wrappers fail closed and need native compatibility validation. `node-version.mjs` is the shared Node.js >=22.12.0 policy used before setup, doctor and daemon work.

`job-status.mjs` provides the shared read-only status path, without browser binding. `job-lock.mjs` separates CLI workflow ownership from exclusive mutation transactions shared with the daemon; ledger reads for writes occur inside the transaction. `daemon-operations.mjs` exposes the actual dispatcher for synthetic transport tests without starting a bridge. See [concurrency](../docs/CONCURRENCY.md).
