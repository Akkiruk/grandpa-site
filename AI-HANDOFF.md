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

- Clerk is a test-mode instance (`pk_test_...` / `sk_test_...`), Frontend API domain `polite-mammoth-8157.clerk.accounts.dev`. Instance ID: `ins_3JqgqrkSa1SR4mnum39MKnTwA7G`.
- **Google OAuth is disabled** and **sign-up mode is "restricted" (invite-only)** — both confirmed live via the API (see "Checking Clerk config" below), not just assumed from dashboard clicks. Only `email_code`/`email_link`/`password`/`reset_password_email_code` remain as sign-in first factors.
- **Why Google OAuth is off**: it requires a full-page redirect away to Google and back. This Clerk instance is a *development* instance running on a real custom domain (not `localhost`), which forces Clerk to sync sessions via a URL-based handshake (`__clerk_db_jwt`) instead of a normal cookie. That combination is a documented, known-flaky failure mode — we hit both a wrong post-redirect landing page and then a genuine infinite reload loop trying to fix it with `forceRedirectUrl`/`signInForceRedirectUrl`. **Do not re-enable Google OAuth (or any OAuth social connection) on this instance without first promoting to a production Clerk instance with a verified custom domain** (which also requires registering a dedicated Google Cloud OAuth app — production instances can't use Clerk's shared dev OAuth credentials). Email code sign-in has no such redirect and is not affected by this.
- The primary admin account already exists in Clerk (`user_3JqjmYtD64PIns43R4ffctqqwXd`, email `rboone98s5@gmail.com`, originally created via the now-disabled Google sign-in). Restricted mode only blocks *new* sign-ups; this existing user can still sign in via email code to the same address.
- `CLERK_SECRET_KEY` is a Cloudflare secret. `CLERK_PUBLISHABLE_KEY` is a plain `[vars]` entry in `wrangler.toml` (publishable keys are meant to be public — they ship in client-side JS) and is also hardcoded directly into `admin/index.html`'s Clerk script tags.
- The old `ADMIN_PASSWORD` and `SESSION_SECRET` secrets were deleted from Cloudflare and from `.env`. Do not recreate them — any future auth changes should go through Clerk (e.g. roles/organizations), not a reintroduced password system.
- Verified in production: an unauthenticated `/api/editor/status` request returns 401; the admin page serves with the Clerk script tags and a CSP scoped to Clerk's domains.
- **Not yet verified by an agent**: the actual browser sign-in flow end to end (entering an email, receiving the code, submitting it, landing in the editor). This requires a human with access to the inbox — ask the user to confirm this works if it hasn't been confirmed since the Google-OAuth-disable change.

## Checking/Changing Clerk Config

Two ways to inspect or change the live Clerk instance from a terminal, both using `CLERK_SECRET_KEY` from `.env` (no interactive browser login needed for read-mostly operations):

1. **Clerk CLI** (`npm install -g clerk`, real official package despite the generic name). Run non-interactively by exporting the key: `CLERK_SECRET_KEY=<key> clerk users list`, `clerk doctor`, `clerk config pull`, etc. `clerk auth login` (full account claim, needed for `config schema`/`config patch`/`deploy`) requires an interactive browser OAuth flow — an agent cannot complete this without the user.
2. **Raw API calls**: `GET https://polite-mammoth-8157.clerk.accounts.dev/v1/environment` (public Frontend API, no auth needed) returns `user_settings.sign_up.mode` and `user_settings.social.oauth_google.enabled` — the two settings that mattered here. `GET/PATCH https://api.clerk.com/v1/instance` and `/v1/instance/restrictions` (Bearer `CLERK_SECRET_KEY`) cover a different, narrower set of instance settings (allowlist/blocklist, session syncing, etc.) — **neither the Backend API nor the CLI's `config` command exposes a field to toggle sign-up mode or individual social connections programmatically; these are dashboard-only** (Configure → Restrictions → Sign-up mode; Configure → SSO Connections). Confirmed by directly probing the endpoints, not just reading docs.

Production AI provider:

- Provider: OpenRouter, model `openai/gpt-4o-mini` (as of 2026-09-26)
- **No fallback provider of any kind.** There was previously a Cloudflare Workers AI fallback on OpenRouter failure; it was removed deliberately (explicit user instruction: "either OpenRouter works or it doesn't"). It was also actively harmful: it masked real OpenRouter failures behind Workers AI's own unrelated "free daily allowance used" error, making the actual problem impossible to diagnose from the error message alone.
- **Why the model changed from `minimax/minimax-m2.5`**: diagnosed live (direct curl tests against OpenRouter, not guessed) that this model mandates internal chain-of-thought reasoning it cannot disable (`reasoning: {enabled: false}` returns a 400: "Reasoning is mandatory for this endpoint"), and for some ordinary requests (e.g. "make the header icons more mobile friendly") it spiraled into 16,000+ reasoning tokens and hit `finish_reason: "length"` with `content: null` — a complete non-answer, not just a slow one, costing real money for nothing. `openai/gpt-4o-mini` was tested the same way and reliably returns valid, well-formed JSON in ~2 seconds. If this model is ever swapped again, verify the replacement the same way: a real curl request against `https://openrouter.ai/api/v1/chat/completions` with an actual file + edit request, checking `finish_reason` and that `content` is non-null valid JSON — don't just trust a model's marketing.

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

- `SITE_CONTENT`: KV namespace
- `OPENROUTER_MODEL = "openai/gpt-4o-mini"`
- `CLERK_PUBLISHABLE_KEY` (plain var, not secret — this key is public by design)

There is deliberately no `[ai]` binding anymore (Workers AI fallback removed, see above).

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
- Server-side error logging (`console.error`, viewable live via `npx wrangler pages deployment tail <deployment-id> --project-name memories-2-dvd-usb`, needs the specific deployment ID from `wrangler pages deployment list` — `--environment production` alone fails in non-interactive mode on this wrangler version) for chat failures and any unhandled error
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

1. **Confirmed working end to end by the user**: email code sign-in, chat, undo, and the editor UI all function correctly in production as of 2026-09-26.
2. If a browser console shows CSP violations on `/admin/`, the CSP in `_headers` may need additional Clerk domains — check the blocked resource in the console error and add its origin to the relevant directive.
3. No role/permission distinction exists yet between the primary admin and invited users (e.g. grandpa) — anyone with a valid Clerk account for this app can fully use the editor. Add Clerk Organizations/roles if that ever needs to change.
4. Grandpa has not been invited yet — that's a Clerk Dashboard action (Users → Invitations) or `clerk` CLI once his email address is known. No code involved.
5. Do not re-enable Google (or any OAuth) sign-in on this dev instance without promoting to a production Clerk instance with a verified custom domain first — see "Why Google OAuth is off" above. This is not a temporary workaround to casually revert; it's a real architectural constraint of dev-instance-on-a-real-domain.
6. **Never mount a Clerk component (`mountSignIn`, etc.) unconditionally on every page load/auth-state event.** Two separate production incidents (an infinite reload loop, and a background-token-refresh wiping in-flight chat messages) both traced back to code reacting to *every* Clerk `addListener` firing — which happens repeatedly in the background (session refresh), not just on real sign-in/out transitions. Always gate on an actual state transition (track "was this already true" and compare), never on the listener firing at all. See the comments in `admin/app.js`'s `initAuth()`/`mountSignInIfNeeded()`/`loadStatus()` for the specifics of both fixes.
7. If the AI editor starts failing edits again, don't assume it's a system bug before checking `finish_reason` and `content` on a direct OpenRouter test call (see the AI provider section above) — a model silently failing to produce output looks identical, from the chat UI's perspective, to almost any other failure.
