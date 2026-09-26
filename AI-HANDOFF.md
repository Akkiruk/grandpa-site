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

The site and editor are deployed. The last completed commit is `029ad39` (`Harden editor security and model reliability`). It was pushed to `origin/main`, and the worktree was clean immediately afterward.

Production was verified to use:

- Provider: OpenRouter
- Primary model: `minimax/minimax-m2.5`
- Cloudflare Workers AI is an explicitly labeled fallback
- A real production edit, preview, and undo completed successfully using MiniMax with no fallback

The user subsequently changed `ADMIN_PASSWORD` in the local ignored `.env`. That new value has **not yet been uploaded to Cloudflare** in the current unfinished task. Never print or log it.

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

Local `.env` is ignored and currently contains non-empty values for `ADMIN_PASSWORD`, `OPENROUTER_API_KEY`, and `OPENROUTER_MODEL`. Never display those values. `.env.example` was deleted by the user or another process after this handoff was first written; that deletion is an unrelated uncommitted change and must not be reverted without instruction.

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

## Immediate Pending Task

The interrupted task was: fix all remaining audit findings and upload the newly changed admin password.

First, securely upload `ADMIN_PASSWORD` from `.env` without printing it:

```powershell
$lines = [System.IO.File]::ReadAllLines((Join-Path $PWD '.env'))
$line = $lines | Where-Object { $_ -match '^ADMIN_PASSWORD=' } | Select-Object -First 1
$password = $line.Substring($line.IndexOf('=') + 1).Trim()
try {
  $password | npx wrangler pages secret put ADMIN_PASSWORD --project-name memories-2-dvd-usb
} finally {
  $password = $null
}
```

Then redeploy. Changing the password automatically invalidates all old HMAC sessions. Verify:

1. An old session cookie receives 401.
2. Login with the new local password succeeds.
3. `/api/editor/status` reports OpenRouter and `minimax/minimax-m2.5`.
4. Never expose the password in command output or API responses.

## Remaining Audit Findings To Address

These were discovered after commit `029ad39` but were not yet edited:

1. `isTrustedMutation()` currently allows mutation requests when both `Origin` and `Referer` are absent. Change this to deny missing provenance for browser mutations, then update tests and production verification commands to include `Origin`.
2. Draft/chat/publish/rollback operations can race because KV has no transaction or lock. Add optimistic draft version checks or a Cloudflare Durable Object if stronger serialization is required. For this single-admin site, optimistic version checks are the conservative next step.
3. Multi-key KV publish is not atomic. Write file blobs first and the manifest last; retain the previous revision before switching the manifest. Consider versioned published keys if fully atomic publication is required.
4. Raw upstream AI/provider errors are currently returned via `error.message` in some API paths. Sanitize provider/internal errors into stable user messages; never echo response bodies, headers, keys, or stack traces.
5. `loadPublishedFiles()` fails the entire editor if a manifest asset is missing from both KV and deployed assets. Prefer a clear integrity error or resilient recovery that never silently publishes empty content.
6. Login throttling uses KV read-then-write and is not atomic under concurrency. For strict rate limiting, use Cloudflare Rate Limiting or a Durable Object. Do not pretend retries make KV increments atomic.
7. Password-derived session signing works and password rotation revokes sessions, but a separate `SESSION_SECRET` would decouple password changes from signing. This is optional; introducing it requires securely configuring another secret.

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
- Preserve unrelated user changes, especially ignored `.env` and the current uncommitted deletion of `.env.example`.

## Tool/Workflow Notes

- OS: Windows; shell: PowerShell.
- Use `apply_patch` for edits.
- Use `npm test`, `npm run build`, and Wrangler for deployment.
- Use browser/Playwright tools for live UI checks.
- Use Git tools to commit/push; do not expose secrets in commit messages or diffs.
- Follow the repository-wide push-live instruction.

## Recommended Next Sequence

1. Confirm Git status and current `.env` variable presence without printing values.
2. Fix missing-Origin mutation behavior and sanitize provider errors.
3. Add optimistic draft/version checks around chat, undo, publish, discard, and rollback.
4. Add focused regression tests.
5. Run `npm test` and `npm run build`.
6. Upload the new `ADMIN_PASSWORD` secret securely.
7. Deploy production.
8. Verify old-session rejection and new-password login.
9. Verify exact model and one reversible edit/undo.
10. Commit and push all tracked changes.
