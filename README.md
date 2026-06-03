# SpecterSync DIY

**Open-source local sync for CMS content.** SpecterSync DIY syncs Ghost, WordPress, and Shopify content down to a folder of plain markdown files on your hard drive. Run your own editor or AI tools over those files. Push changes back through direct local CMS connections with dry-run preview and conflict detection.

SpecterSync has two editions:

- **SpecterSync DIY** (`spectersync.diy`) is the AGPLv3 Community edition for developers and technical operators who want to inspect, self-build, modify, and run direct local sync.
- **SpecterSync Pro** (`spectersync.com`) is the official commercial product with signed installers, license activation, automatic updates, managed connectors, hosted AI transformation workflows, and support.

| | SpecterSync DIY |
|---|---|
| Mac | ✅ macOS 13+ (Intel + Apple Silicon) |
| Windows | 🟡 in progress (build packaged; signing not yet live) |
| Linux | ✅ AppImage + .deb |
| Ghost | ✅ |
| Shopify | ✅ |
| WordPress | ✅ |
| AI tools | bring your own — any tool that reads markdown on disk |
| Source | Open source under GNU AGPLv3 |
| Pricing | Free to self-build under AGPLv3. Pro is the paid supported product. |

> Want the official supported app? SpecterSync Pro lives at [spectersync.com](https://spectersync.com). Pro adds signed binaries, automatic updates, managed OAuth/token refresh, support, and AI transformation workflows.

## Install

### Official app

Download the latest signed SpecterSync Pro binary from [spectersync.com/download](https://spectersync.com/download). Official binaries are the paid, supported distribution channel and include signing, notarization, installers, QA, automatic updates, managed services, and support.

DIY does not ship official signed binaries or use the Pro update feed.

### Build DIY from source

```bash
git clone https://github.com/spectersync/spectersync-diy.git
cd spectersync-diy
npm install
npm run build          # bundles the daemon
bash mac/build-app.sh  # local unsigned macOS .app — needs Xcode
cd desktop && npm install && npm run build                 # local Electron build
```

Production packaging, code signing, notarization, official update feeds, license activation, billing, managed connector backends, and hosted AI transforms are maintained as part of SpecterSync Pro and are not part of the DIY source distribution. See [`docs/local-builds.md`](docs/local-builds.md).

## Connect a CMS

### Ghost
Settings → Connect Ghost → paste Admin API URL + Admin API key.

### Shopify
DIY supports direct local connector flows where available. SpecterSync Pro includes the managed Shopify OAuth/token-refresh flow through `spectersync.com`, because Shopify client secrets must not ship in a desktop app.

> **Why split this?** DIY should remain self-buildable and inspectable. Pro can provide managed OAuth, refresh, support, and connector reliability without embedding commercial secrets in the AGPL repo.

## Community vs Pro

| Capability | DIY / Community | Pro / Official |
|---|---:|---:|
| Source available | ✅ | Open-source components only |
| Self-build | ✅ | Not needed |
| Direct local sync | ✅ | ✅ |
| Signed installers | — | ✅ |
| Automatic updates | Manual rebuild | ✅ |
| License activation | — | ✅ |
| Managed Shopify OAuth/refresh | — | ✅ |
| Hosted AI transforms | — | ✅ |
| Official support | Community/best effort | ✅ |
| Commercial invoices/refunds | — | ✅ |

Community is for transparency, self-building, and contribution. Pro is for people and teams who want SpecterSync maintained, signed, updated, supported, and ready for production work.

## How it works

```
┌─────────────────────────────────┐
│ Specter (Mac / Win / Linux)     │
│ ┌─────────────────────────────┐ │
│ │ Tray / menu bar UI          │ │
│ │ Dashboard window            │ │
│ │ Settings / Onboarding       │ │
│ └─────────────┬───────────────┘ │
│               │ spawns          │
│               ▼                 │
│ ┌─────────────────────────────┐ │
│ │ Daemon (Node.js child)      │ │
│ │ - Watches local markdown    │ │
│ │ - Polls CMS every 10 min    │ │
│ │ - Runs pull / push / sync   │ │
│ │ - One CmsAdapter per target │ │
│ └─────────────┬───────────────┘ │
│               │ writes          │
│               ▼                 │
│   ~/.local/state/ghost-sync/    │
│   state.json (UI polls this)    │
└─────────────────────────────────┘
```

The Mac shell and the daemon communicate only via `state.json`. One-shot CLI commands (`pull`, `push`, `sync`) spawn a fresh daemon process; the long-running watcher is a separate supervised process. Architecture details: [`docs/architecture.md`](docs/architecture.md).

## The `CmsAdapter` seam

Every CMS plugs in through one interface:

```ts
interface CmsAdapter {
  platform: 'ghost' | 'shopify' | 'wordpress' | ...;
  listPosts(): Promise<RemotePost[]>;
  getPost(id: string): Promise<RemotePost>;
  createPost(input: CreatePostInput): Promise<RemotePost>;
  updatePost(id: string, input: UpdatePostInput): Promise<RemotePost>;
  deletePost(id: string): Promise<void>;
  listContainers?(): Promise<RemoteContainer[]>;  // blogs, sections, etc.
  testConnection(): Promise<void>;
  capabilities: {
    supportsContainers: boolean;
    optimisticLock: boolean;
  };
}
```

`RemotePost.body` is always **markdown**. Adapters convert HTML ↔ markdown at the seam — engine code never touches platform-native body formats. See [`docs/adding-a-cms.md`](docs/adding-a-cms.md) for the contract test suite that every new adapter must pass.

## Contributing

Bug reports, feature requests, and pull requests welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

SpecterSync has both an AGPLv3 Community edition and a commercial Pro edition. Contributions require agreement to the project contribution terms/CLA so accepted changes can be used in both the open-source and commercial editions.

**Architectural changes** that touch the `CmsAdapter` seam, the frontmatter shape, or the sync engine: please open an issue first — those changes affect every adapter and we'd rather discuss the shape before you sink a weekend into a PR.

**New CMS adapters**: open an issue describing the target platform + your use case. Roughly: list its REST/GraphQL endpoints, its native body format (HTML / blocks / mobiledoc / something else), its auth mechanism, and whether it supports optimistic concurrency. Then write the adapter + wire it through `runCmsAdapterContract(...)`. Reference implementations: [`src/ghost/adapter.ts`](src/ghost/adapter.ts), [`src/shopify/adapter.ts`](src/shopify/adapter.ts).

See [`docs/contribution-flow.md`](docs/contribution-flow.md) for how public PRs are reviewed and mirrored back into the private canonical release repo.

## License

[GNU Affero General Public License v3.0 only](LICENSE.md).

SpecterSync DIY is open source under AGPLv3.

You can use, study, modify, and redistribute the source under AGPLv3. If you distribute modified versions or offer modified networked versions, you must provide the corresponding source under the same license.

SpecterSync Pro is a separate commercial product and service offering. Pro is paid for signed installers, license activation, automatic updates, managed connector infrastructure, hosted AI transformation workflows, support, and commercial operations.

The SpecterSync name, logo, app icons, release assets, and official branding are covered by [`TRADEMARK.md`](TRADEMARK.md). Forks are welcome under the license terms, but compiled redistributions must use their own name and branding unless written permission is granted.

## Who built this

[Axel Antas-Bergkvist](https://github.com/aabergkvist) under [aabergkvist AB](https://aabergkvist.com) (Sweden). Specter started as a local Obsidian plugin in May 2026 to scratch the "edit Ghost in Obsidian without going through their web editor" itch; it's grown into a CMS-agnostic sync tool because the workflow turned out to apply far beyond Ghost.

If SpecterSync DIY saves you time and you want the supported production lane, use [SpecterSync Pro](https://spectersync.com).

---

**Status**: SpecterSync DIY is preparing for public preview. v0.6.x. Production-stable Pro releases exist for Ghost, Shopify, and WordPress single-store setups; deeper per-platform content coverage is in flight.
