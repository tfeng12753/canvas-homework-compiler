# LLM Proxy (for providers that block direct browser calls)

Some LLM APIs (IFM included) reject requests whose `Origin` header isn't an approved web
domain, as a security measure against API keys being called directly from browser
JavaScript. A Chrome extension is exactly that kind of context, so calls straight from
the extension to a provider like this get rejected even with a valid key and model.

This is a minimal Cloudflare Worker that sits in between: the extension calls this proxy,
the proxy calls the real provider **server-side** (no browser origin involved, so the
provider's restriction doesn't apply), and returns the response. Your real provider API
key lives only in this Worker's encrypted secrets — it never touches the browser or
`chrome.storage.local`.

The extension authenticates to *this proxy* with a separate shared secret you make up
yourself — not your real provider API key.

## One-time setup

You'll need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) (no credit
card required for this).

```bash
cd proxy
npm install
npx wrangler login          # opens a browser tab to authorize your Cloudflare account
```

Set your two secrets (you'll be prompted to paste each one after running the command —
they're stored encrypted by Cloudflare, never written to a file):

```bash
npx wrangler secret put PROVIDER_API_KEY
# paste your real IFM (or other provider) API key when prompted

npx wrangler secret put PROXY_SHARED_SECRET
# paste a random string you generate yourself, e.g. from: openssl rand -hex 32
```

If your provider's base URL isn't `https://api.ifm.ai/v1`, edit `PROVIDER_BASE_URL` in
`wrangler.toml` first.

Deploy:

```bash
npm run deploy
```

This prints a URL like `https://canvas-homework-compiler-llm-proxy.<your-subdomain>.workers.dev`.

## Configuring the extension

In the extension's Settings → LLM Provider section:

- **Base URL:** the Workers URL from the deploy output above
- **API Key:** the `PROXY_SHARED_SECRET` you made up (NOT your real provider key)
- **Model:** the model ID your provider account has access to (e.g. `IFM/K2-Think-v2` —
  check with `curl https://your-worker-url.workers.dev/models -H "Authorization: Bearer YOUR_PROXY_SHARED_SECRET"`)

Click **Test LLM** in the extension options — it should now succeed, since the request to
the real provider is happening from Cloudflare's servers, not your browser.

## Locking it down further (optional)

By default the proxy accepts requests from any origin as long as they present the correct
`PROXY_SHARED_SECRET`. To also restrict it to your specific extension, uncomment
`ALLOWED_ORIGIN` in `wrangler.toml`, set it to `chrome-extension://<your-extension-id>`
(visible in `chrome://extensions`), and redeploy with `npm run deploy`.
