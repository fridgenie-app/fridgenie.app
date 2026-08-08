# fridgenie.app
Jujube landing page — your magical kitchen companion 🌿

Static site served from GitHub Pages at **myjujube.app** (deploy = the
`.github/workflows/pages.yml` Actions workflow; `build_type=workflow`, **not**
the legacy Jekyll pipeline). No build step — plain HTML/CSS/JS.

## Pages
- `/` — landing page
- `/get` — smart store link (platform-detecting)
- `/invite/` — **invite rich card + deep link** (see below)
- `/admin` — admin console (see `admin/README.md`)
- `/privacy`, `/terms`, `/account-deletion`, `/auth/confirmed` — legal / auth
- `404.html` — client-side router for shared-recipe (`/r/{id}`) and invite path links

## Invite links (`/invite/`)

Pasting an invite link into KakaoTalk / iMessage / SMS renders a branded Jujube
preview card (Open Graph + Twitter Card), and tapping it deep-links into the app
if installed, else the App Store / Play Store.

### Recommended link format (the app should generate this)

```
https://myjujube.app/invite/?c=<CODE>
```

Optional personalization params the card will display if present:

```
https://myjujube.app/invite/?c=<CODE>&n=<InviterName>&h=<HouseholdName>
```

**Why `?c=` and not `/invite/<CODE>`:** GitHub Pages is static and has no
per-code file, so only `/invite/` (and `/invite/?c=…`) returns **HTTP 200**.
Messaging crawlers don't run JavaScript and must read the OG tags from a 200
response, so the rich preview requires the `?c=` (or bare `/invite/`) form. A
literal `/invite/<CODE>` path still **works for users** — `404.html` client-side
redirects it to `/invite/?c=<CODE>` — but a path-form link pasted into a chat
previews as a generic 404, not the invite card. Prefer `?c=`.

The invite code is read client-side (from `?c=`, `?code=`, a bare `?CODE`, a
`#CODE` hash, or a trailing path segment) and used only for the deep link — the
OG card itself is brand-generic and static, so previews always render.

### Deep-link behavior
`invite/index.html` tries `com.fridgenie.app://invite/<CODE>` and falls back to
the store after ~1.6 s if the app doesn't take over (cancelled if the page is
backgrounded, i.e. the app opened). On mobile it auto-attempts once on load;
desktop just shows the card + buttons.

### Universal Links / App Links association
- `/.well-known/apple-app-site-association` — Apple, `applinks` for
  `7373NYW784.com.fridgenie.app`, path `/invite/*`. Served extensionless.
- `/.well-known/assetlinks.json` — Android, `com.fridgenie.app` + the Play
  App Signing SHA-256 fingerprint.

> ⚠️ **Web side is done; the app side is required to activate Universal/App
> Links.** iOS won't honor the AASA until the mobile app adds the
> `com.apple.developer.associated-domains` entitlement
> (`applinks:myjujube.app`) — its `Runner.entitlements` currently only declares
> Apple Sign-In. Android needs `android:autoVerify="true"` intent filters for
> `myjujube.app`. Until then, invites still work via the JS scheme + store
> fallback above. **Owner: mobile repo.**

## Placeholders to finish with Minjun

- **`assets/invite-og.png`** — `TODO(minjun): swap in the final designed
  invite share image.` This is an **interim, code-generated** 1200×630 card
  (real brand art: app icon + wordmark + sparkle, warm palette) — good enough
  to ship, but replaceable. To swap: drop a final **1200×630 PNG** at the same
  path `assets/invite-og.png` (keep the name so the meta tags in
  `invite/index.html` need no change), then redeploy. If you rename it, update
  the four `og:image` / `twitter:image` URLs in `invite/index.html`.

## Local dev
```bash
python3 -m http.server 8000
open http://localhost:8000/invite/?c=DEMO123
open http://localhost:8000/admin/
```
