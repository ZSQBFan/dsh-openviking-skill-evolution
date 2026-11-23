# Native OpenViking memory server probe

This probe tests the OpenViking 0.5.5 server directly. The server uses a disposable loopback process, temporary account and storage, and scripted loopback inference. It does not exercise the live DSH profile, real skills, or real credentials.

## Reproduce

Run from the repository root with the Python interpreter and `openviking-server` from a disposable environment containing `openviking==0.5.5`:

```sh
/path/to/venv/bin/python -B test/memory-server-probe.py \
  --server-bin /path/to/venv/bin/openviking-server
```

## Findings

- The native commit endpoint returned `accepted` with an archive URI and a task ID; polling that task yielded `completed`. With the synthetic case enabled, the task reported three memory writes: profile, preference, and case.
- Both fresh actor-scoped workspace sessions returned the exact preference and the same canonical Experience URI with `origin: self`; exact Experience readback returned HTTP 200 with the expected procedure. This verifies user-owned Experience recall in two workspace contexts, not workspace-exclusive isolation. Both actors also read the global fact through `profile.md`; this is direct profile readback, not a semantic context-search hit.
- Agent Evolution was disabled by default for the disposable account, even when enabled in server configuration. Account-level opt-in was required. A scripted case alone triggered the trajectory stage but produced no Experience (`404 NOT_FOUND`). A matching successful `trajectories` output with `related_case_ids: ["c1"]` advanced training to the `experiences` operations and produced the file. The task's three `memory_write` items describe the initial user-memory pass; exact readback and recall establish the Experience outcome independently.
- Exit zero covers archive/task completion, scripted training stages, exact readback for all three expected markers, and fresh-session recall. A bounded retry allows the index to become visible after the task completes; an immediate one-shot search did miss the Experience in one run. Scripted inference exercises server orchestration, storage and retrieval, not live model quality or production DSH injection.
