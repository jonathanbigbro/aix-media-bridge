# Task configuration

Copy `examples/media-job.template.json` into `configs/` and edit it. Relative paths resolve from the configuration file's directory.

- `schemaVersion`: 2. `jobId`: 3–64 uppercase letters, digits, underscores or hyphens, starting with a letter or digit. Use a unique ID for a new authorized task; recovery keeps the original ID.
- `project`: exactly `{"key":"demo"}`; the local registry records the verified name and canvas identity. Use project bind/create/select before planning. Account credentials do not belong in this object.
- `referencePng`: one local PNG, at most 5 MiB, dimensions at most 4096. The workflow verifies the uploaded bytes and dimensions against the local input.
- `image`: `main_image` / workflow `248`, ratio `16:9`, resolution `2k`, count 1; `prompt` describes the still composition.
- `video`: `1888` / workflow `225`, ratio `16:9`, resolution `720p`, duration 4 or 5, count 1; `prompt` describes the motion using the newly generated image.
- `photography`: 飞思 XF IQ4 150MP, Cooke S4, 50mm, ƒ/5.6, 1/500s-清晰.
- `lighting`: 电影三点光, 45°侧光, 柔雾灰. Photography and lighting are AIX-generated prompt descriptions.
- `outputDir`: a task subdirectory under the repository's outputs directory; no symlink redirection.
- `limits`: uploads, imageSubmissions, videoSubmissions, downloads, imageAgentRequests and videoAgentRequests are all 1.

Unknown fields and unsupported combinations are rejected. Configuration and reference content are hashed. Changing them after the job starts is rejected before a new operation is dispatched.

Outputs include a local ledger, input summary, sanitized protocol evidence, original media and manifest. Manifests include local paths, prompts and canvas/asset aliases for recovery; they remain private runtime data and are excluded from the source distribution.

Runtime requires Node.js >=22.12.0. Submission validation is persistent and fails closed for invalid or incomplete old acknowledgements. Actual output duration is recorded independently of the requested duration.

In 0.4.2, status is local and read-only, including when it diagnoses invalid parameters. Persisting that block and invalidating old results require task ownership and a mutation transaction. Snapshots may lag concurrent production.
