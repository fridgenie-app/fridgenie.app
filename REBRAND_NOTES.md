# Fridgenie → Jujube rebrand — landing site cutover notes

This repo's content has been rebranded to **Jujube**. All copy, meta tags
(`<title>`, `og:*`, `twitter:*`, canonical), and internal links now point to
the new primary domain **getjujube.app**.

## What was NOT changed automatically (and why)

- **`CNAME` still contains `fridgenie.app`.** It was left as-is on purpose:
  `getjujube.app` is not registered/pointed yet, and GitHub Pages binds one
  custom domain per repo. Flipping `CNAME` before `getjujube.app` DNS resolves
  would take the live site down. Change it during the cutover (below).
- **Deep-link scheme `com.fridgenie.app://callback`** is unchanged everywhere
  (index.html, 404.html, auth/confirmed/index.html). It is derived from the iOS
  bundle id `com.fridgenie.app`, which is intentionally NOT changing (preserves
  TestFlight/App Store continuity). Do not touch it.

## Cutover checklist (do in order)

1. **Register `getjujube.app`** and add DNS records pointing at GitHub Pages
   (A records `185.199.108–111.153`, plus `www` CNAME → `<user>.github.io`),
   or move to Cloudflare Pages / Netlify.
2. **Point this repo at the new domain:** set repo **Settings → Pages → Custom
   domain** to `getjujube.app`, and update the `CNAME` file to `getjujube.app`.
   Enable "Enforce HTTPS".
3. **Redirect the old domain `fridgenie.app` → `getjujube.app` (301).**
   GitHub Pages cannot emit a true 301, so pick one:
   - **Registrar/Cloudflare URL forwarding (recommended, real 301):** add a
     301 forward rule `fridgenie.app/* → https://getjujube.app/$1` at the DNS
     provider (Cloudflare "Bulk Redirects" or a Page Rule).
   - **Netlify / Cloudflare Pages:** the included `_redirects` file already
     encodes the rules; just serve the old domain from that host.
   - **Static fallback (last resort):** deploy a tiny site on `fridgenie.app`
     whose `index.html` is a `<meta http-equiv="refresh">` + JS redirect +
     `<link rel="canonical" href="https://getjujube.app/...">`.
4. **Verify:** `curl -sI https://fridgenie.app/` returns `301` → `getjujube.app`,
   and `https://getjujube.app` serves the Jujube site over HTTPS.

## Supabase (must be updated in the dashboard before shipping the app)

The mobile app now sends users to `https://getjujube.app/auth/confirmed`. For
email confirmation / OAuth to work:
- **Auth → URL Configuration → Site URL** → `https://getjujube.app`
- **Auth → URL Configuration → Redirect URLs** → add
  `https://getjujube.app/**` and `com.fridgenie.app://callback` (keep the old
  `https://fridgenie.app/**` until the 301 is live).
- **Auth → Email Templates** → update any hardcoded `fridgenie.app` links and
  the "Fridgenie" wording to "Jujube" / `getjujube.app`.

## Contact email

Pages now show `hello@getjujube.app`. Set up a mailbox or forwarder (MX records)
for `getjujube.app` so this address does not bounce — it appears in the privacy
policy and terms.
