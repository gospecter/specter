# Self-hosting OAuth (DIY)

SpecterSync supports two ways to authenticate a CMS connection:

1. **Pasted API token** — works out of the box, no server required. For Webflow,
   paste a Site API token into the connect window. This is the simplest path and
   is recommended for most DIY users.
2. **OAuth** — the "Connect with Webflow" button authorizes in your browser and
   hands the token back to the app automatically.

The OAuth button is present in the DIY build, but **DIY ships no OAuth broker**.
OAuth uses a *confidential client*: trading the authorization code for an access
token requires a provider client secret, which must never live inside a desktop
binary. So OAuth needs a small server you control. If you don't want to run one,
use the pasted-token path instead — it does everything OAuth does, just without
the browser round-trip.

> SpecterSync Pro includes this as a hosted, turnkey service — no app
> registration and no server to run. DIY users who want OAuth host it themselves,
> as described below.

## What the app already does

The desktop shell handles its half of the flow:

- The connect window's **Connect with Webflow** button opens
  `<oauthBaseUrl>/api/oauth/webflow/start` in your browser.
- The app registers the `specter://` URL scheme and listens for the callback
  `specter://oauth/complete?provider=webflow&code=<exchangeCode>`.
- On that callback it POSTs the exchange code to
  `<oauthBaseUrl>/api/oauth/webflow/exchange`, receives the access token, and
  pre-fills the connect form so you can pick the site and collections.

`oauthBaseUrl` defaults to the hosted Pro broker. To self-host, point it at your
own server (see [Configuring Specter](#configuring-specter)).

## What you must host

Register your own OAuth app with the provider (e.g. a Webflow OAuth app) to get a
**client ID** and **client secret**, and set its redirect URI to your callback
endpoint below. Then deploy three endpoints under one origin. Specter only ever
talks to `start` (via the browser) and `exchange` (directly); `callback` is
called by the provider.

### `GET /api/oauth/webflow/start`

Begin the flow. Create a short-lived, single-use `state` value, store it
server-side, and 302-redirect the browser to the provider's authorize screen:

```
302 → https://webflow.com/oauth/authorize
        ?response_type=code
        &client_id=<your client id>
        &scope=<your scopes>
        &redirect_uri=<your callback URL>
        &state=<state>
```

### `GET /api/oauth/webflow/callback`

The provider redirects here with `code` and `state`. Verify `state` (reject if it
doesn't match a stored value — this is your CSRF guard), then exchange the
authorization code for an access token **server-side**, using your client secret:

```
POST https://api.webflow.com/oauth/access_token
{ "client_id", "client_secret", "code", "grant_type": "authorization_code", "redirect_uri" }
→ { "access_token", "scope", ... }
```

Do **not** put the access token in a redirect URL. Instead, store it behind a
fresh single-use, short-lived **exchange code**, then 302-redirect back to the
app:

```
302 → specter://oauth/complete?provider=webflow&code=<exchangeCode>
```

### `POST /api/oauth/webflow/exchange`

The app calls this with the exchange code to retrieve the token. The code is
single-use and should expire quickly. This is the only response that carries the
access token, and it travels over HTTPS straight to the app:

```
POST /api/oauth/webflow/exchange
{ "code": "<exchangeCode>" }

200 → { "provider": "webflow", "accessToken": "<token>", "scope": "<scopes>" }
```

Return `404` if the code is expired or already used, `400` for a missing code.

### Other providers

The shape is identical for Shopify; only the fields differ. Shopify's callback
also carries a `shop`, and its `exchange` response additionally returns
`shop`, `refreshToken`, `accessTokenExpiresAt`, and `refreshTokenExpiresAt`
(Webflow tokens are long-lived and carry no refresh token). The app sends the
matching `provider` value on the `specter://` callback either way.

## Configuring Specter

Point Specter at your broker's origin (scheme + host, no trailing path). Two
equivalent ways:

- **Settings → Advanced → OAuth server** — type your origin, e.g.
  `https://oauth.example.com`. Leave blank to use the hosted default.
- **`config.json`** — add a top-level `oauthBaseUrl`:

  ```json
  {
    "vaultPath": "/Users/you/Vault",
    "oauthBaseUrl": "https://oauth.example.com",
    "targets": []
  }
  ```

  The config file lives at `~/.config/ghost-sync/config.json`. The daemon ignores
  this field — only the desktop shell reads it — so it has no effect on
  command-line sync.

When `oauthBaseUrl` is set, both the start URL and the token exchange go to your
server. When it's blank, Specter falls back to the hosted broker.

## Security checklist

- Keep the client secret on the server only; never ship it in the app or commit it.
- Verify `state` on the callback; treat a mismatch as an attack and abort.
- Make exchange codes single-use and short-lived; the token must never appear in
  a browser URL.
- Serve every endpoint over HTTPS.
