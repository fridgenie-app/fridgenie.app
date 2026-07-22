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
   ├─ ai_usage_cost_report(from,to)  → daily AI $ spend, cost by function/model (RPC)
   ├─ profiles                       → signups per day, user list
   ├─ ai_usage_events                → top users, per-user cost, quota hits, regen rate
   ├─ ai_usage_daily + get_ai_quota  → reset a user's daily quota (support action)
   ├─ ai_model_pricing               → price book for per-user / per-call cost
   ├─ pantry_items                   → a user's current pantry (modal)
   ├─ admin_activity_logs            → audit trail read + writes
   ├─ auth.users                     → email + sign-in provider lookup
   ├─ admin_set_subscription_tier()  → grant/revoke pro (audited RPC)
   └─ admin_set_user_deleted()       → reversible soft-delete (audited RPC)
```

### Actions (query param `?action=`)

| Action | Method | Purpose |
|---|---|---|
| `overview` | GET | KPI tiles + content counts (doubles as the admin gate) |
| `signups` | GET | New users per day, 30d |
| `cost` | GET | Daily AI $ spend, 30d |
| `top_users` | GET | Top 10 users by tokens, 30d |
| `users` | GET | User list — name, sign-in method, private-relay tag, days since signup/active, 30d AI $ cost |
| `cost_by_function` | GET | AI $ grouped by edge function, 30d |
| `cost_by_model` | GET | AI $ grouped by provider/model, 30d (Sonnet↔Haiku migration signal) |
| `quota_events` | GET | Daily-limit hits (`status='rate_limited'`) by feature: events + unique users |
| `regeneration_rate` | GET | `recipe-suggest` calls regenerated within 60s (first-result quality signal) |
| `signup_sources` | GET | New signups by Apple / Google / Email + private-relay count |
| `user_pantry` | GET | `?user_id=` → that user's current pantry items |
| `user_usage_log` | GET | `?user_id=&days=` → that user's AI calls with per-call cost |
| `activity_log` | GET | Last 20 rows of `admin_activity_logs` |
| `set_tier` | POST | Grant/revoke pro (audited RPC) |
| `set_deleted` | POST | Soft-delete/restore (audited RPC) |
| `reset_quota` | POST | `{user_id[, feature]}` → zero today's `ai_usage_daily` for the user's **local** day; audited |

Every action re-checks `profiles.is_admin` on the caller before doing anything.
The v2 actions add **no new migration** — they reuse the existing tables/RPCs.

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
