# Admin console — deploy runbook

Everything the admin dashboard needs, in order. All commands target the Jujube
Supabase project **`rhhaojpsqfbapltcvsbz`**. There are **no secrets for you to
set** — the Edge Function uses the service role that Supabase injects at runtime.

## 0. Prerequisites (one-time)

The dashboard depends on three migrations from the **mobile** repo
(`feedmiyo6/fridgenie`). Two are already live; **one is not yet applied**:

| Migration | State | Provides |
|---|---|---|
| `20260411000000_admin_bypass_policies.sql` | live | `is_admin()`, admin RLS bypass |
| `20260718130000_ai_usage_events.sql` | live | spend ledger (service-role only) |
| `20260721050000_ai_model_pricing_and_admin.sql` | **NOT applied** — on branch `feat/admin-cost-backend` | pricing table, `ai_admin_overview()`, `ai_usage_cost_report()`, `admin_set_subscription_tier()`, `admin_set_user_deleted()`, `profiles.deleted_at`, audit log |

### Apply the pricing/admin migration
```bash
cd ~/Projects/fridgenie
git checkout feat/admin-cost-backend -- supabase/migrations/20260721050000_ai_model_pricing_and_admin.sql
supabase link --project-ref rhhaojpsqfbapltcvsbz
supabase db push        # or paste the file into the Supabase SQL editor
```
It is additive and idempotent — safe to run once, safe to re-run.

> **Verify the seeded model prices** in `ai_model_pricing` against current provider
> pricing (they are 2026-07-21 estimates). Fixing a price is a single `UPDATE`;
> cost is computed on read, so no backfill is needed. Current reference rates:
> Sonnet 5 $3/$15 · Haiku 4.5 $0.80/$4 · Sonnet 4.6 $3/$15 · GPT-4o-mini $0.15/$0.60
> per 1M in/out tokens; Whisper $0.006/min; gpt-image HD ~$0.19/image.

## 1. Deploy the Edge Function
```bash
cd ~/Projects/fridgenie                     # the Supabase-linked repo
mkdir -p supabase/functions/admin-console
cp <landing-repo>/admin/backend/admin-console/index.ts supabase/functions/admin-console/index.ts
supabase functions deploy admin-console --project-ref rhhaojpsqfbapltcvsbz
```
`verify_jwt` may stay **on** (default) — the function also re-checks admin in-body.

## 2. Allow the admin origin(s)
- **Auth redirect allow-list** (Supabase → Authentication → URL Configuration →
  Redirect URLs): add `https://myjujube.app/admin` and, if serving from the
  current domain, `https://fridgenie.app/admin` (+ `http://localhost:8000/admin/`
  for local dev). The magic link redirects back here.
- **CORS**: origins are allow-listed in `admin-console/index.ts` (`ALLOWED_ORIGINS`).
  Edit that array if the admin is served from a different origin.

## 3. Grant yourself admin
Run **`seed_admin_minjun.sql`** (delivered separately — kept out of this public
repo) in the Supabase SQL editor, or the one-liner:
```sql
UPDATE public.profiles SET is_admin = true
WHERE id = (SELECT id FROM auth.users WHERE email = 'rexford1011@gmail.com');
```

## 4. Ship the frontend
Merge this PR to `main`. GitHub Pages serves `/admin` automatically. Visit
`https://<domain>/admin`, request a magic link, and you're in.

---

### Optional — true `admin.myjujube.app` subdomain (Option B)
v1 ships at the **`/admin` path** (Option A) — zero DNS work, one Pages site.
For a dedicated subdomain: create repo `fridgenie-app/admin.myjujube.app`, move
these files to its root, add a `CNAME` file containing `admin.myjujube.app`, and
add a DNS `CNAME admin → fridgenie-app.github.io`. Then add that origin to
`ALLOWED_ORIGINS` and the Auth redirect list. Nothing else changes.
