# Release Model

SpecterSync uses a two-repo model.

## Private Repo

The private repo is canonical. It contains:

- Full product source.
- Website, billing, and business infrastructure.
- Website and Cloudflare Worker code.
- Production release workflows.
- Code signing and notarization configuration.
- Sparkle update-feed generation.
- Internal planning and strategy documents.

## Public Repo

The public repo is a sanitized source mirror. It contains:

- Sync daemon source.
- Desktop shell source.
- Local build scripts.
- Schemas.
- Tests suitable for public contributors.
- Public docs and community files.

It does not contain the production release pipeline or private business infrastructure.

## Versioning

Public source tags should match official binary versions:

```text
official binary: v0.7.0
public source:   v0.7.0
```

The exported source tree is the corresponding open-source snapshot for that release. Official binaries remain the supported paid convenience distribution channel.
