# AI Agent Handoff

Last updated: 2026-09-25

## Project

Static business website and password-protected AI website editor for Memories 2 DVD - USB.

- Production: https://memories2dvdorusb.com
- Editor: https://memories2dvdorusb.com/admin/
- Cloudflare Pages project: `memories-2-dvd-usb`
- Pages output: `dist/`
- Worker entry point: `_worker.js`
- Branch: `main`

## Current Live State

The site and editor are deployed with all previously-pending work complete:

- The rotated `ADMIN_PASSWORD` from local `.env` was uploaded to Cloudflare as a secret.
- A new random `SESSION_SECRET` was generated and uploaded to Cloudflare, decoupling session signing from the admin password (see Audit Findings item 7, now resolved).
- All seven previously-open audit findings below were fixed, covered by regression tests, and deployed to production.
- Verified in production: an old/garbage session cookie gets 401, login with the new password succeeds, `/api/editor/status` reports OpenRouter and `minimax/minimax-m2.5`, and a real chat edit + undo round-trip left no residual draft.

Production was verified to use:

- Provider: OpenRouter
- Primary model: `minimax/minimax-m2.5`
- Cloudflare Workers AI is an explicitly labeled fallback

## Architecture

### Public site

Root files:

- `index.html`
- `about.html`
- `services.html`
- `process.html`
- `pricing.html`
- `styles.css`
- `script.js`

Published AI changes are stored in Cloudflare KV and served ahead of deployed static assets.

### Editor

- `admin/index.html`: login, chat, preview, publish, versions UI
- `admin/app.js`: authenticated API client and UI state
- `admin/admin.css`: editor styling
- `_worker.js`: authentication, AI calls, guarded edits, drafts, preview, publish, undo, revisions, rollback

### Cloudflare bindings

Configured in `wrangler.toml`:

- `AI`: Workers AI fallback
- `SITE_CONTENT`: KV namespace
- `OPENROUTER_MODEL = "minimax/minimax-m2.5"`

Encrypted production secrets:

- `ADMIN_PASSWORD`
- `OPENROUTER_API_KEY`
- `SESSION_SECRET` (optional; session signing falls back to `ADMIN_PASSWORD` if absent, but production now has a dedicated value)

Local `.env` is ignored and currently contains non-empty values for `ADMIN_PASSWORD`, `OPENROUTER_API_KEY`, and `OPENROUTER_MODEL`. Never display those values. `.env.example` was intentionally removed permanently; do not recreate it.

## Security Already Implemented

- HttpOnly, Secure, SameSite=Strict session cookie
- Expiring HMAC-signed session token derived from the admin password
- Constant-time hash/signature comparisons
- Per-IP failed-login throttling: 8 failures, 10-minute TTL
- Same-origin validation on mutating editor requests
- Preview iframe uses `sandbox="allow-scripts"` without `allow-same-origin`
- Preview CSP blocks connections, forms, objects, and base URL changes
- Public/admin CSP and security headers
- Generated site validation blocks:
  - protected paths
  - oversized files
  - malformed HTML
  - `javascript:` URLs
  - `/api/editor` references
  - remote script sources
- User and AI text is rendered with `textContent`; `innerHTML` is used only for static literals
- `.env` and secret-like files are ignored; no real secrets are tracked
- Passwords and API keys are not returned by APIs, embedded in HTML/JS, or visible through Inspect Element

Cloudflare’s optional analytics beacon is intentionally blocked by CSP and may create a harmless browser-console CSP warning.

## Reliability Already Implemented

- OpenRouter JSON mode and one malformed-output retry
- Explicit model reporting in editor status/UI and edit receipts
- Labeled Cloudflare AI fallback instead of silent model substitution
- Workers AI model fallback and quota-friendly errors
- Exact guarded find/replace operations
- No-op and ambiguous-edit rejection
- File validation before draft/publish
- Structured change receipts
- Eight-level draft undo stack
- Published revision history and rollback
- Desktop/phone preview

## Tests

Run:

```powershell
npm test
npm run build
```

Latest result: 14/14 tests passing, including:

- guarded edits and validation
- malformed AI response retry
- OpenRouter model selection
- stacked undo
- cross-site mutation blocking
- login throttling
- tampered-session rejection

## Deployment

```powershell
npm run build
npx wrangler pages deploy dist --project-name memories-2-dvd-usb --branch main
```

Default expectation from the user: validate, commit, push, and deploy without asking first. Never remove Cloudflare token permissions; only add permissions if necessary.

## Audit Findings (Resolved)

These were discovered after commit `029ad39` and are now fixed, tested, and deployed:

1. **Fixed.** `isTrustedMutation()` now denies mutation requests when both `Origin` and `Referer` are absent, instead of allowing them. Covered by a regression test; production verification commands now send `Origin`.
2. **Fixed (optimistic checks, not a Durable Object).** Chat, undo, discard, publish, and rollback now read the raw KV value for `draft:current` (and, for publish/rollback, `published:manifest`) up front and re-check it hasn't changed before writing (`putDraftIfUnchanged`, `deleteDraftIfUnchanged`, `publishFilesIfUnchanged`). A detected conflict returns `409` with a "changed elsewhere, refresh and try again" message instead of silently clobbering concurrent work. This is a conservative mitigation, not full serialization — a Durable Object would still be the option if stronger guarantees are ever required.
3. **Fixed.** `publishFilesIfUnchanged()` writes all file blobs first and the `published:manifest` key last, so a mid-write failure can't leave the manifest pointing at a partially-written publish.
4. **Fixed.** `askOpenAI` and `askOpenRouter` no longer return raw `result.error.message` from the upstream provider to the client. The raw message is logged server-side via `console.error`; the client gets a stable, generic message.
5. **Fixed.** `loadPublishedFiles()` now catches a missing asset (absent from both KV and deployed assets) and throws one clear, stable error naming the file, rather than an opaque failure. It still refuses to synthesize empty content for a missing file.
6. **Documented, not "fixed."** Login throttling is still KV read-then-write and is not atomic under concurrency; a comment in `_worker.js` next to `ConflictError` records this explicitly. It remains an acceptable best-effort throttle for this single-admin, low-traffic site. If stronger guarantees are ever needed, use Cloudflare Rate Limiting or a Durable Object — do not attempt to fake atomicity with retries.
7. **Fixed.** A dedicated `SESSION_SECRET` was generated and uploaded to Cloudflare. `sessionSignature()` now uses `env.SESSION_SECRET || env.ADMIN_PASSWORD`, so session signing is decoupled from the admin password going forward while staying backward compatible if the secret is ever absent (e.g. local dev).

Do not overstate minor acceptable risks:

- OpenRouter necessarily receives the editable public site source and user prompts.
- The site has one shared admin password by design.
- AI changes remain drafts until the user explicitly publishes them.

## Key Code Symbols

In `_worker.js`:

- `validateFiles`
- `applyOperations`
- `extractJson`
- `askOpenRouter`
- `askWorkersAI`
- `requestEdits`
- `isTrustedMutation`
- `isAuthenticated`
- `createSession`
- `handleApi`
- `servePreview`
- `servePublished`

## Working Preferences / Memory Relevant Here

- Check whether an existing system can be extended before adding a new one.
- Prefer small, root-cause fixes consistent with current architecture.
- Use tests/build as the validation driver.
- Never echo `.env` contents or credentials; validate only presence/non-emptiness.
- For UI, keep on-screen wording minimal and intuitive.
- After local validation, deploy, commit, and push by default.
- Do not wait for GitHub Actions after pushing unless explicitly requested.
- Never remove token permissions; only add permissions.
- Preserve ignored `.env`. Do not recreate `.env.example`; the user intentionally removed it permanently.

## Tool/Workflow Notes

- OS: Windows; shell: PowerShell.
- Use `apply_patch` for edits.
- Use `npm test`, `npm run build`, and Wrangler for deployment.
- Use browser/Playwright tools for live UI checks.
- Use Git tools to commit/push; do not expose secrets in commit messages or diffs.
- Follow the repository-wide push-live instruction.

## No Open Task

There is no known unfinished work as of this update. If a future audit finds something new, add it under "Audit Findings" above rather than starting a new section.
