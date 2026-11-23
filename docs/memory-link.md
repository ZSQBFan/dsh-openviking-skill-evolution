# OpenViking memory linkage

`memoryLinkProjection` folds the current session's committed DSH events. `memoryLinkStatus(session, state, runtime)` reads the existing native `openvikingMemory` entry, when available, without initializing it or calling OpenViking. The module registers no independent capture or recall hooks and makes no uploads. OpenViking's normal lifecycle continues to own replay, recall, capture and commit.

The status reports the native session ID and effective peer ID, the configured recall scope, and the most recent committed recall/profile injection and commit boundary. The peer ID reflects the native resolution for that session, not the profile's startup directory. A boundary does not establish a remote commit, and the native pending flag is not a delivery receipt. `remoteCommit` therefore stays `unverified`; the native runtime's `states` map is a version-sensitive observation rather than a public status API. An unavailable or not-yet-observed runtime does not cause a query, fallback write, or synthesized ID.

Experience evidence is limited to exact canonical Markdown URIs in the configured user's Experience directory. Scoped successful `find`, `search`, or `list` hits record recall; a successful full single `read` or `multi_read` records injection. Inherited events, incomplete or failed results, and ambiguous batches are ignored. Missing result provenance is not inferred from prose. Only the URI, tool and committed event sequence numbers appear in the audit, not queries, review text or bodies. Evidence does not establish that the model followed an Experience or that OpenViking extracted a new one.

## Isolated verification

```sh
node --test test/memory-link.test.js
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" \
  test/memory-link-native.mjs "$OV_MEMORY_PLUGIN_DIR"
```

`DSH_INSTALL_DIR` must point to the matching installed CLI package root; `OV_MEMORY_PLUGIN_DIR` must point to the installed OpenViking memory plugin package root. The native fixture runs the installed runtime with a synthetic client in memory, no profile mutation, no real skills and no live server. It verifies two effective workspace peers, one normal recall/capture/commit sequence in the first session, and zero requests initiated by the audit. The event fixture separately proves the Experience metadata and exclusion rules; it does not validate an OpenViking server's Experience extraction or persistence.
