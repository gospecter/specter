# Security Policy

## Supported versions

Only the **latest minor release** of Specter Core receives security updates. Currently: **v0.6.x**.

When a new minor lands (e.g. v0.7.0), security fixes for the previous minor (v0.6.x) continue for 90 days; after that, you'll need to upgrade.

## Reporting a vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

Email instead: **`hello@spectersync.com`**, subject prefix `[SECURITY]`.

Please include:

- A description of the vulnerability.
- Steps to reproduce.
- The affected Specter version (`Specter → About` or `ghost-sync --version` from the CLI).
- Your OS and version.
- Whether the vulnerability has been disclosed elsewhere (no judgment — just so we can coordinate).

We'll acknowledge receipt within **48 hours** and provide a fix or mitigation timeline within **7 days**. Critical issues (remote code execution, credential exfiltration) get a fix in days; lower-severity issues may take weeks.

## What's in scope

- **Specter Core** — the desktop app and daemon in this repo.
- **The Specter URL scheme** (`specter://`) — anything that could be triggered remotely by malicious URLs.
- **OAuth flows** — the Shopify OAuth broker at `web/src/pages/api/oauth/shopify/*.ts` (if you're auditing the server side too).
- **Credential storage** — how access tokens are written to disk, file permissions, etc.
- **HTML / Markdown sanitization** — XSS in `markdownToHtml` or related paths.

## What's out of scope

- **Specter Cloud** — separate codebase, separate security policy. Report Cloud issues via the dashboard at `app.spectersync.com`.
- **Third-party services we connect to** (Shopify, Ghost, GitHub Releases, etc.) — report to the respective vendors.
- **Issues that require local user privileges** beyond what Specter would normally have (e.g. "if an attacker has root, they can read your config.json" — yes, that's how root works).
- **Outdated Sparkle / dependency advisories that don't affect the way we use them** — we triage these but treat them as low-priority unless the exposure is real.

## Security-relevant design choices worth knowing

- Configuration lives at `~/.config/ghost-sync/config.json` with `chmod 600`. The Mac and Electron config writers both use atomic `tempfile + rename` writes (chmod 600 reapplied post-rename) so an interrupted save can't leave a half-written or world-readable file.
- The Shopify OAuth broker exchanges the merchant's authorization code for an access token **server-side** (Cloudflare Worker). The merchant's browser is then redirected to `specter://oauth/complete?code=<short-lived-exchange-code>` — the access token never appears in any URL. The desktop app POSTs the exchange code back to the Worker over HTTPS to retrieve the token, then writes it to local config. Exchange codes are single-use with a 5-minute TTL.
- HTML emitted to a remote CMS (Shopify push, etc.) runs through `sanitize-html` with an explicit safe-tag allowlist. `<script>`, `<iframe>`, event handlers, and `javascript:` URLs are stripped. `trustVaultContent: true` is the documented opt-out for users who fully control their vault.
- All GDPR / lifecycle webhooks (`customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled`) verify the Shopify HMAC-SHA256 signature against `SHOPIFY_CLIENT_SECRET` and return HTTP 401 on invalid or missing signatures.

## Disclosure timeline (responsible disclosure)

Once a fix lands, we'll:

1. Release a patched version (typically within 7 days for confirmed issues).
2. Acknowledge the reporter in the changelog (unless you ask to stay anonymous).
3. Open a public GitHub Security Advisory at https://github.com/gospecter/specter/security/advisories with a CVE if the issue meets the criteria.

Thank you for helping keep Specter merchants safe.
