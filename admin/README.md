# Jujube Admin Console

A static, vanilla HTML/CSS/JS admin dashboard served from the landing repo at
**`/admin`** (e.g. `https://myjujube.app/admin`). No build step, no framework —
same stack as the rest of this repo.

## Architecture

```
Browser (publishable key + magic-link session)
   │  Supabase Auth (magic link)  ── sign in / gate on is_admin()
   │
   │  fetch(<project>/functions/v1/admin-console?action=…)   Authorization: Bearer <user JWT>
   ▼
Edge Function `admin-console`  (verifies caller is admin, then uses the
   │                            server-side SERVICE ROLE — never in the browser)
   ├─ ai_admin_overview()            → KPI tiles + content counts (RPC)
   ├─ ai_usage_cost_report(from,to)  → daily AI $ spend (RPC)
   ├─ profiles                       → signups per day, user list
   ├─ ai_usage_events                → top users by tokens (service-role ledger)
   ├─ auth.users                     → email lookup
   ├─ admin_set_subscription_tier()  → grant/revoke pro (audited RPC)
   └─ admin_set_user_deleted()       → reversible soft-delete (audited RPC)
```

**Security posture**
- The browser only ever holds the **publishable** key + the signed-in user's own
  session. RLS is always enforced.
- The **service-role key never appears in this repo or the browser.** It lives
  only in the Supabase Edge runtime (auto-injected as `SUPABASE_SERVICE_ROLE_KEY`).
- Every privileged read (spend ledger, emails) and write (pro/soft-delete) is
  gated by an in-function `profiles.is_admin` check on the caller, and the write
  RPCs additionally re-verify the acting admin and write an `admin_activity_logs`
  audit row.

## Files
- `index.html` — the single page (loading / sign-in / not-authorized / dashboard).
- `styles.css` — Jujube brand tokens (warm paper, coral, Shippori Mincho / Inter).
- `app.js` — ES module: auth, edge-function client, SVG charts, tables, actions.
- `config.js` — public Supabase URL + publishable key (safe to expose).
- `backend/admin-console/index.ts` — the Edge Function source (deploy to Supabase).
- `backend/DEPLOY.md` — the full deploy runbook.

## Local dev
```bash
# from the repo root
python3 -m http.server 8000
open http://localhost:8000/admin/
```
Add your local origin to the Edge Function `ALLOWED_ORIGINS` and to the Supabase
Auth redirect allow-list while developing.
