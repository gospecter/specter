# Contributing to Specter

Thank you for considering a contribution. Specter is built and maintained by one person; the easier you make it for me to review your work, the faster it lands.

## Before you start

- **Bug reports**: open an issue. Include OS + version, Specter version (`Specter → About`), reproduction steps, and any relevant log lines from `~/Library/Logs/ghost-sync.log` (macOS) or `%APPDATA%\ghost-sync\logs\` (Windows).
- **Feature requests**: open an issue describing the workflow you're trying to support. "I want feature X" → "Here's the problem X solves" is more useful.
- **Larger changes**: open an issue first to discuss. Architectural changes (the `CmsAdapter` seam, the frontmatter shape, the sync engine, the state.json schema) ripple through every adapter — please don't sink a weekend into a PR for one of those without a quick design conversation first.
- **New CMS adapters**: see the section below.

## Development setup

### Daemon (TypeScript / Node)

```bash
git clone https://github.com/gospecter/specter.git
cd specter
npm install
npm run build          # tsc → dist/
node esbuild.config.mjs  # single bundle for the .app
npx tsc --noEmit       # typecheck
npm test               # vitest, 230+ tests
npm link               # exposes `ghost-sync` CLI globally (dev only)
```

### Mac shell (SwiftUI)

```bash
cd mac
# One-time:
bash fetch-node.sh     # vendors Node 22 into mac/vendor/node (universal arm64+x64)
# Builds + runs:
swift build            # checked build
bash build-app.sh      # full .app build (needs $SU_PUB_KEY exported — see mac/sparkle/README.md)
open .build/Specter.app
```

Targets macOS 13+. The Sparkle public key in `mac/build-app.sh` is the production key; contributors don't need their own unless they're forking for a separate distribution.

### Electron shell (Windows + Linux)

```bash
cd desktop
npm install
npm run build          # compiles main + preload + renderer
npx electron .         # runs against the daemon bundle in ../dist/
npx electron-builder --linux   # AppImage + .deb
npx electron-builder --win     # NSIS installer (Windows host only)
```

The Linux build runs in CI on Ubuntu; the Windows build requires a Windows host because Authenticode signing is Windows-only.

## Conventions

A few non-obvious ones worth knowing:

- **Test before the build.** `npm test` (root) must be green before any push. CI runs on Linux + macOS + Windows × Node 20 + 22.
- **Don't reach into `fs/promises` from `src/sync/`.** All disk IO goes through `src/vault.ts` so the engine stays vault-adapter-agnostic.
- **`CmsAdapter` is the seam.** Engine code never touches platform-specific clients. When a platform exceeds CRUD, add a capability flag (`adapter.capabilities.optimisticLock` etc.), don't widen the interface.
- **Body is always markdown.** Adapters convert HTML ↔ markdown at their boundary; the rest of the codebase only sees markdown strings.
- **Sanitize HTML by default.** When generating HTML to push to a CMS, run it through `sanitize-html` with an explicit safe-tag allowlist. The merchant's vault is user input — treat it that way.
- **Mac and Electron should mirror each other.** If you add a Settings field or a Dashboard action on Mac, the Electron renderer needs the same affordance (or vice versa). Cross-platform consistency matters more than feature velocity.
- **No new dependencies without justification.** The daemon is bundled with esbuild and ships in every desktop binary; every dep is bytes the user downloads.

Full conventions: [`docs/conventions.md`](docs/conventions.md).

## Adding a new CMS adapter

The contract every adapter must pass:

```ts
// tests/contract/<your-cms>.contract.test.ts
import { runCmsAdapterContract } from '../contract/cmsAdapter.contract.js';

runCmsAdapterContract('YourCms', () => new YourAdapter(fakeApi), {
  optimisticLock: false,  // does the API support If-Unmodified-Since-style writes?
  containers: 'flat',     // 'flat' = no containers; 'multi' = blogs/sections/etc.
});
```

That suite is 15 behavioral scenarios. Pass them and your adapter behaves consistently with Ghost and Shopify. Reference: `src/ghost/adapter.ts` (~120 lines) or `src/shopify/adapter.ts` (~250 lines, more complex because of containers + rate-limit handling).

You also need:
- A `RemotePost`-shaped output from `listPosts()` / `getPost()`. Body must be markdown.
- HTML → markdown conversion if the platform stores HTML (turndown is already a dep).
- Error translation: wrap your platform's errors in `CmsApiError` with the right `errorType` (`conflict` / `notFound` / `rateLimited` / `authError` / `unknown`).
- Auth handling: OAuth where possible, BYO-token as a fallback for self-hosted platforms.

When in doubt, read how Ghost does it.

## Pull request checklist

- [ ] Issue exists describing the change (if larger than a typo / docs fix).
- [ ] Tests added or updated.
- [ ] `npm test` green locally.
- [ ] Cross-platform parity considered (Mac + Electron + daemon).
- [ ] No new dependencies without justification.
- [ ] Commit messages are descriptive — see `git log` for the existing style.
- [ ] No accidental secrets committed (gitleaks should catch this; double-check anyway).

## Security

See [`SECURITY.md`](SECURITY.md). For vulnerabilities, please email `hello@spectersync.com` instead of opening a public issue.

## Code of Conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Be respectful. Specter is a small project; we want it to stay welcoming to people who are new to OSS or new to building on top of CMS APIs.
