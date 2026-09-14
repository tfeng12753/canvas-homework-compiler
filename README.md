# Canvas Homework Compiler

A Chrome extension with two features:

1. **Practice Doc** — scans your Canvas courses over a chosen date range, uses an LLM to
   figure out which items are actual homework/practice material (as opposed to syllabi,
   announcements, rubrics, etc. — homework can live under Assignments, Modules, or Files),
   and compiles the extracted questions into a single Markdown document you can export to
   PDF.
2. **Calendar Sync** — pulls every due date from your Canvas *and* Gradescope courses over
   a date range and syncs them into a dedicated "Homework Compiler" Google Calendar.

## How it works

- **Canvas access (hybrid):** if you provide a personal access token in Settings, it uses
  Canvas's REST API directly. If no token is set, or the token doesn't work, it falls back
  to running requests from inside an actual Canvas tab you're logged into (using your
  normal browser session) — so it still works at schools that block API tokens.
- **Gradescope access:** Gradescope has no public API or access-token option, so this
  always uses the same in-tab, logged-in-session technique, parsing the HTML it returns.
  This is the most likely part of the extension to need a fix if Gradescope changes its
  page markup.
- **Classification (Practice Doc only):** every candidate item's title, type, module, and
  description snippet is sent to an LLM you configure, which decides what's genuinely
  homework/practice. Calendar Sync skips this step — it includes every dated item.
- **Extraction (Practice Doc only):** for items classified as homework, it pulls the
  description text and, for PDF/docx attachments, extracts the file text (via pdf.js /
  mammoth) and asks the LLM to pull out just the actual questions — skipping instructions,
  rubrics, and point values.
- **Google Calendar sync:** uses `chrome.identity` (OAuth) to create/update events in a
  calendar named "Homework Compiler" in your Google account — it doesn't touch your other
  calendars, and re-running a sync updates existing events instead of duplicating them.

## Setup

1. Install dependencies and build:

   ```bash
   npm install
   npm run build
   ```

2. Load the extension in Chrome:
   - Go to `chrome://extensions`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked" and select the `dist/` folder produced by `npm run build`

3. Open the extension's Settings (gear icon in the popup, or right-click the extension icon
   → Options) and configure:
   - **Canvas URL** — e.g. `https://yourschool.instructure.com`
   - **API Token** (optional) — Canvas → Account → Settings → "New Access Token". Leave
     blank to use your logged-in browser session instead.
   - **LLM Provider** (for Practice Doc) — any OpenAI-compatible chat-completions endpoint:
     base URL (without `/chat/completions`), API key, and model name. If your provider
     rejects direct browser calls (some do, as a security measure — you'll see an error
     like `model_origin_not_allowed`), see [`proxy/README.md`](proxy/README.md) for a small
     server-side forwarder that fixes it.
   - **Gradescope** — click **Grant Access to Gradescope**, then **Test Connection** (make
     sure you're logged into Gradescope in this browser first).
   - **Google Calendar** — click **Connect Google Calendar** (one-time Google sign-in
     prompt). Requires a Google OAuth client ID — see "Google Calendar OAuth setup" below.
   - Click **Grant Access to This Canvas Site**, then **Test Connection** / **Test LLM** to
     confirm Canvas and your LLM provider are working.

4. Open the popup:
   - **Practice Doc tab** — select courses and a date range, click **Compile Homework**.
   - **Calendar Sync tab** — select Canvas/Gradescope courses and a date range, click
     **Sync to Google Calendar**.

## Google Calendar OAuth setup (one-time)

Google requires every app to register its own OAuth client:

1. Create a project at [Google Cloud Console](https://console.cloud.google.com/), enable
   the **Google Calendar API**, and configure the OAuth consent screen (External, in
   Testing mode — add your own Google account as a test user; no verification needed for
   personal use).
2. Create an OAuth client ID of type **Chrome Extension**, using this extension's ID:
   `niphcnbcjlikccdadddgloadakfbkanc` (this stays fixed because `manifest.json` pins a
   `key` field — don't regenerate that key, or the ID will change and break the OAuth
   client).
3. Copy the generated client ID into `manifest.json`'s `oauth2.client_id` field, replacing
   the placeholder, then `npm run build` and reload the extension.

## Rebuilding after code changes

```bash
npm run build
```

Then in `chrome://extensions`, click the reload icon on this extension.

## Privacy

Your Canvas token and LLM API key are stored only in this browser
(`chrome.storage.local`) and are sent only to the exact Canvas domain and LLM base URL you
configure. Google Calendar access uses a token managed by Chrome itself
(`chrome.identity`), scoped to the dedicated "Homework Compiler" calendar's contents.
There is no third-party backend involved, unless you choose to deploy the optional LLM
proxy in `proxy/` for a provider that blocks direct browser calls — in that case your real
provider API key lives only in that proxy's encrypted server-side secrets, not in the
browser.
