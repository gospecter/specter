# Architecture

SpecterSync is split into a thin desktop shell and a Node.js daemon. The shell owns the tray, dashboard, settings, and onboarding experience. The daemon owns the sync workflow and is the only layer that reads local markdown, talks to CMS adapters, and writes sync state.

## Runtime Shape

```text
Desktop shell
  - Tray / menu bar UI
  - Dashboard window
  - Settings / onboarding
        |
        | spawns daemon commands
        v
Node.js daemon
  - Watches local markdown
  - Polls CMS targets
  - Runs pull / push / sync
  - Talks through one CmsAdapter per target
        |
        | writes state
        v
~/.local/state/ghost-sync/state.json
```

The shell and daemon communicate through `state.json`. One-shot CLI commands such as `pull`, `push`, and `sync` spawn a daemon process for that operation. The long-running watcher is supervised separately.

## Sync Layers

- CLI and desktop commands resolve a target config and start a sync operation.
- The sync engine works with platform-neutral `RemotePost` values and local markdown files.
- Each CMS implementation maps its native API shape to and from the shared `CmsAdapter` interface.
- The vault layer reads and writes markdown/frontmatter on disk.
- Conflict handling compares local frontmatter state with remote timestamps or adapter-specific update semantics.

Engine code should stay platform-agnostic. Platform-specific API calls, auth details, pagination, and body-format conversion belong inside the adapter implementation.

## Adapter Boundary

All CMS platforms implement the same adapter surface from `src/cms/adapter.ts`. Existing adapters live under `src/ghost/`, `src/shopify/`, and `src/wordpress/`.

The adapter boundary keeps the engine from depending on CMS-native body formats. `RemotePost.body` is always markdown; adapters convert between markdown and the platform-native body format before data reaches the engine.

New adapter work should also wire into the shared contract tests described in [`adding-a-cms.md`](adding-a-cms.md).
