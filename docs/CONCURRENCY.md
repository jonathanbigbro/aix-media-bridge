# Job status and mutation ownership — 0.4.2

`status` is a local, read-only snapshot. The CLI calls `readJobStatus` directly; daemon `job:status` and direct `media:status` use the same function. None binds a browser page, calls browser tools, acquires a writer lock, updates a ledger, invalidates a result, creates a backup or writes a manifest. It can run while a production command owns the job, and it does not require the bridge to be running.

Parameter diagnostics remain enabled. `state` reports a diagnostic block when needed, while `observedPhase` preserves the phase actually read. A stored completed result can be presented as blocked with `diagnosticOnly` and `storedState`; its disk bytes are unchanged. A concurrent producer may advance after the snapshot was read. Status is not a transactional completion acceptance check.

## Lock protocol

| Lock | Owner and lifetime | Purpose |
|---|---|---|
| Project lock | CLI run/resume, for the workflow | Serialize project production commands |
| Job `.lock` | CLI run/resume, for the workflow | Own the task and provide the token delegated to daemon operations |
| Job `.mutation.lock` | The process currently executing a mutation transaction | Exclude concurrent ledger/result writers, including an in-flight daemon operation whose CLI timed out |

The order is project → job ownership → mutation. The CLI **does not hold the mutation lock while awaiting a daemon RPC**. The daemon verifies the delegated job token and live owner PID, then acquires its own mutation lock. It does not reacquire the CLI's job ownership lock. Missing or incorrect ownership is rejected, including for `verify-restored`, which previously bypassed ownership checks.

`withJobMutation` acquires the lock before the callback reads the ledger. Persistent generation validation always rereads the current ledger inside that transaction, rather than accepting a pre-lock snapshot. `writeJobJson` verifies both ownership and the mutation lock before protected writes. The result-invalidation path and backup creation run inside the same transaction. Media operations hold that transaction across their complete read/modify/write operation; nested validation reuses the transaction. Standalone internal mutation helpers acquire task ownership themselves when no delegated owner is provided.

If the CLI exits or releases ownership while a daemon operation is still in flight, that operation retains its mutation lock until it unwinds. A second writer is rejected while the first remains active. The old operation also fails its ownership check before a later protected write. Reservations already recorded remain available for reconciliation. Contention is an error, not permission to delete locks, retry a generation or bypass parameter validation. A timing/error log may be unavailable if the mutation lock is still occupied; the CLI preserves the original operation error.

The 0.4.1 persistent parameter block is retained. Run/resume and completion acceptance persist the block under the transaction. A read-only status command only reports it.

## Regression evidence

`tests/concurrency.test.mjs` uses Promise barriers around the first completed ledger read. The writer commits a new reservation, acknowledgement or completion before the captured status snapshot is released. The schedule is explicit, with no random delay or timer choosing the interleaving. Test timeouts only bound hangs.

Nine initial cases failed on 0.4.1 before fixes: six CLI/operation overwrite schedules, two byte-preservation checks and the CLI browser-dispatch check. The expanded 19-test suite also exercises daemon dispatch with a synthetic transport, ownership validation, a delayed writer retaining its lock, fresh reads under both locks, locked run/resume invalidation and a separate Node writer process using the real lock module. All input is synthetic. No AIX connection, generation or Resolve render is involved in these tests.

These tests do not establish live 0.4.2 bridge acceptance, current native image-card compatibility, another-machine behavior or a new-account workflow. Use all source files from the same release; a still-running older bridge is reported by its actual process version, not renamed by a source update.
