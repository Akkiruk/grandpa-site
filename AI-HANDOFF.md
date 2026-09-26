# AI Agent Handoff

Last updated: 2026-09-26

## Project

Static business website and Clerk-authenticated AI website editor for Memories 2 DVD - USB.

- Production: https://memories2dvdorusb.com
- Editor: https://memories2dvdorusb.com/admin/
- Cloudflare Pages project: `memories-2-dvd-usb`
- Pages output: `dist/`
- Worker entry point: `_worker.js`
- Branch: `main`

## Current Live State

The editor's login system was fully migrated from a single shared password to **Clerk** (real accounts, invite-based signup). This replaced the entire previous password/session-cookie/login-throttle system, which has been deleted from the codebase — there is no fallback to it.

- Clerk is a test-mode instance (`pk_test_...` / `sk_test_...`), Frontend API domain `polite-mammoth-8157.clerk.accounts.dev`.
- Clerk's dashboard is configured for invitation-only signup (no public sign-ups) — the user who created the Clerk app is the first/primary user; they invite others (e.g. their grandpa) by email from the Clerk dashboard's Users/Invitations screen. There is no in-app invite UI; this is entirely a Clerk-dashboard action.
- `CLERK_SECRET_KEY` is a Cloudflare secret. `CLERK_PUBLISHABLE_KEY` is a plain `[vars]` entry in `wrangler.toml` (publishable keys are meant to be public — they ship in client-side JS) and is also hardcoded directly into `admin/index.html`'s Clerk script tags.
- The old `ADMIN_PASSWORD` and `SESSION_SECRET` secrets were deleted from Cloudflare and from `.env`. Do not recreate them — any future auth changes should go through Clerk (e.g. roles/organizations), not a reintroduced password system.
- Verified in production: an unauthenticated `/api/editor/status` request returns 401; the admin page serves with the Clerk script tags and an updated CSP that allows Clerk's domains.
- **Not yet verified by an agent**: the actual browser sign-in flow (Clerk's mounted `SignIn` UI, email OTP, session token attaches correctly to `/api/editor/*` calls). This requires a real browser and a human completing the email step — ask the user to confirm this works before considering the migration fully done.

Production AI provider (unchanged by this migration):

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

- `admin/index.html`: loads Clerk (`@clerk/ui` + `@clerk/clerk-js` script tags with the publishable key and Frontend API domain), mounts the sign-in UI into `#clerk-sign-in`, then chat/preview/publish/versions UI
- `admin/app.js`: Clerk client-side auth (`initAuth`, `mountSignIn`, `Clerk.addListener`), attaches `Authorization: Bearer <token>` from `Clerk.session.getToken()` to every `/api/editor/*` call, plus editor UI state
- `admin/admin.css`: editor styling
- `_worker.js`: Clerk session verification (`@clerk/backend`'s `createClerkClient(...).authenticateRequest()`), AI calls, guarded edits, drafts, preview, publish, undo, revisions, rollback

### Auth flow

1. `admin/index.html` loads Clerk's JS from the Frontend API domain.
2. `admin/app.js` calls `Clerk.load()`, then either mounts the sign-in UI (`Clerk.mountSignIn`) or, if already signed in, shows the editor.
3. Every authenticated `fetch` to `/api/editor/*` attaches `Authorization: Bearer <Clerk session token>`.
4. `_worker.js`'s `isAuthenticated()` calls `clerkClient.authenticateRequest(request, { authorizedParties: AUTHORIZED_PARTIES })` and checks `toAuth().userId`. `AUTHORIZED_PARTIES` in `_worker.js` lists the exact origins allowed to present a valid token (currently the production domain and the `*.pages.dev` project domain) — this is Clerk's CSRF protection; update it if the site's origin(s) ever change.
5. For tests, `_worker.js` exports `__setClerkClientFactory()` as a dependency-injection seam so tests can substitute a fake Clerk client instead of making real network/JWKS calls. Production code never calls it.

### Cloudflare bindings

Configured in `wrangler.toml`:

- `AI`: Workers AI fallback
- `SITE_CONTENT`: KV namespace
- `OPENROUTER_MODEL = "minimax/minimax-m2.5"`
- `CLERK_PUBLISHABLE_KEY` (plain var, not secret — this key is public by design)

Encrypted production secrets:

- `OPENROUTER_API_KEY`
- `CLERK_SECRET_KEY`

Local `.env` is ignored and currently contains non-empty values for `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_MANAGEMENT_API_TOKEN`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `CLERK_PUBLISHABLE_KEY`, and `CLERK_SECRET_KEY`. Never display `CLERK_SECRET_KEY`, `OPENROUTER_API_KEY`, or the Cloudflare tokens — `CLERK_PUBLISHABLE_KEY` is the one exception that's safe to read/echo since it's meant to be public. `.env.example` was intentionally removed permanently; do not recreate it.

## Security Already Implemented

- Clerk-issued, Clerk-verified session tokens (JWT) instead of a self-rolled password/HMAC session scheme
- `authorizedParties` check on every Clerk token verification (prevents tokens minted for other origins from being accepted — Clerk's CSRF protection)
- Same-origin (`Origin`/`Referer`) validation on mutating editor requests; requests with neither header are rejected outright
- Preview iframe uses `sandbox="allow-scripts"` without `allow-same-origin`
- Preview CSP blocks connections, forms, objects, and base URL changes
- Public/admin CSP and security headers; admin CSP additionally scoped to allow only Clerk's specific domains (Frontend API, `img.clerk.com`, `*.protect.clerk.com`, `challenges.cloudflare.com`, `clerk-telemetry.com`) — not a broad wildcard
- Optimistic conflict checks around draft/publish/rollback KV writes (`putDraftIfUnchanged`, `deleteDraftIfUnchanged`, `publishFilesIfUnchanged`) — returns 409 instead of silently clobbering concurrent edits
- Generated site validation blocks:
  - protected paths
  - oversized files
  - malformed HTML
  - `javascript:` URLs
  - `/api/editor` references
  - remote script sources
- User and AI text is rendered with `textContent`; `innerHTML` is used only for static literals
- `.env` and secret-like files are ignored; no real secrets are tracked
- API keys are not returned by APIs, embedded in HTML/JS, or visible through Inspect Element (the one intentional exception is the Clerk *publishable* key, which is meant to be public)
- Raw upstream OpenAI/OpenRouter error bodies are never echoed to the client; sanitized to stable messages, raw error logged server-side only

Cloudflare's optional analytics beacon is intentionally blocked by CSP and may create a harmless browser-console CSP warning — this is pre-existing and unrelated to the Clerk migration.

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
- Clear integrity error (not silent empty content) if a published asset is missing from both KV and deployed assets

## Tests

Run:

```powershell
npm test
npm run build
```

Latest result: 16/16 tests passing, including:

- guarded edits and validation
- malformed AI response retry
- OpenRouter model selection
- stacked undo
- cross-site mutation blocking (including no-Origin-or-Referer case)
- Clerk-authenticated vs. unauthenticated request handling (via the `__setClerkClientFactory` test seam — no real network calls)
- draft write conflict detection (409)

## Deployment

```powershell
npm run build
npx wrangler pages deploy dist --project-name memories-2-dvd-usb --branch main
```

Default expectation from the user: validate, commit, push, and deploy without asking first. Never remove Cloudflare token permissions; only add permissions if necessary.

Do not overstate minor acceptable risks:

- OpenRouter necessarily receives the editable public site source and user prompts.
- AI changes remain drafts until the user explicitly publishes them.
- Clerk is currently in test mode (`pk_test`/`sk_test`); this is fine for personal/family use but has Clerk's test-mode limits (e.g. email sending) — mention switching to a production Clerk instance only if the user hits those limits or wants a custom email domain.

## Key Code Symbols

In `_worker.js`:

- `validateFiles`
- `applyOperations`
- `extractJson`
- `askOpenRouter`
- `askWorkersAI`
- `requestEdits`
- `isTrustedMutation`
- `isAuthenticated` (Clerk-based)
- `clerkClientFor` / `__setClerkClientFactory` (test seam)
- `handleApi`
- `servePreview`
- `servePublished`

In `admin/app.js`:

- `initAuth`, `mountSignIn` (Clerk sign-in lifecycle)
- `api` (attaches the Clerk bearer token to every editor API call)

## Working Preferences / Memory Relevant Here

- Check whether an existing system can be extended before adding a new one.
- Prefer small, root-cause fixes consistent with current architecture.
- Use tests/build as the validation driver.
- Never echo `.env` contents or credentials (except the Clerk *publishable* key, which is public by design); validate other values only by presence/non-emptiness.
- For UI, keep on-screen wording minimal and intuitive.
- After local validation, deploy, commit, and push by default.
- Do not wait for GitHub Actions after pushing unless explicitly requested.
- Never remove token permissions; only add permissions.
- Preserve ignored `.env`. Do not recreate `.env.example`; the user intentionally removed it permanently.
- When official docs are needed for a third-party service integration (e.g. Clerk), fetch them live rather than relying on training-data memory of the API surface — these SDKs change versions frequently.

## Tool/Workflow Notes

- OS: Windows; shell: PowerShell.
- Use `npm test`, `npm run build`, and Wrangler for deployment.
- Use Git tools to commit/push; do not expose secrets in commit messages or diffs.
- Follow the repository-wide push-live instruction.

## Open Follow-Ups

1. **User should verify the real sign-in flow in a browser** (mount of Clerk's `SignIn` UI, email OTP round-trip, editor unlocking after sign-in, sign-out via the header button). This was deployed and unit-tested but not click-tested in an actual browser by an agent.
2. If a browser console shows CSP violations on `/admin/`, the CSP in `_headers` may need additional Clerk domains — check the blocked resource in the console error and add its origin to the relevant directive.
3. No role/permission distinction exists yet between the primary admin and invited users (e.g. grandpa) — anyone with a valid Clerk account for this app can fully use the editor. Add Clerk Organizations/roles if that ever needs to change.
4. Consider promoting the Clerk instance from test mode to a production instance if email deliverability or Clerk's test-mode limits become a problem.
