// ============================================================================
// admin-console — Jujube admin dashboard backend (Supabase Edge Function)
//
// WHY THIS EXISTS
//   The admin dashboard is a static, vanilla page served from the landing repo
//   and authenticated with the *publishable* key + a Supabase magic-link
//   session. That browser context can read RLS-exposed tables (profiles etc.
//   via the is_admin() admin-bypass policies), but it MUST NOT touch the
//   service-role-only spend ledger (`ai_usage_events`) or `auth.users` emails,
//   and it MUST NOT hold the service-role/secret key.
//
//   This function is the one secure bridge. It:
//     1. Verifies the caller's magic-link JWT.
//     2. Confirms the caller is an admin (profiles.is_admin) using the service
//        client — server-side only.
//     3. Fans out to the *existing* service-role-only RPCs shipped in migration
//        20260721050000 (ai_admin_overview, ai_usage_cost_report,
//        admin_set_subscription_tier, admin_set_user_deleted) plus a couple of
//        direct service-role reads, and returns plain JSON.
//
//   The service role key never leaves the server. The browser only ever sends
//   its own user access token.
//
// DEPLOY (see admin/backend/DEPLOY.md for the full runbook):
//   supabase functions deploy admin-console --project-ref rhhaojpsqfbapltcvsbz
//   (verify_jwt can stay ON — we also re-check admin in-body as defense in depth)
//
// PREREQUISITE MIGRATIONS (must be applied to the project first):
//   - 20260411000000_admin_bypass_policies.sql   (is_admin(), admin bypass)
//   - 20260718130000_ai_usage_events.sql          (spend ledger)
//   - 20260721050000_ai_model_pricing_and_admin.sql (pricing + admin RPCs)  <-- currently on
//     branch feat/admin-cost-backend in the mobile repo; NOT yet applied to prod.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Supabase injects SUPABASE_SERVICE_ROLE_KEY into the Edge runtime automatically.
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Origins allowed to call this function from a browser. Add your admin origin.
const ALLOWED_ORIGINS = [
  "https://myjujube.app",
  "https://fridgenie.app",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:5500",
];

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const todayUTC = () => new Date().toISOString().slice(0, 10);
const daysAgoUTC = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // ---- 1. Authenticate the caller from their magic-link access token --------
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing_token" }, 401, origin);

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: "invalid_token" }, 401, origin);
  const callerId = userData.user.id;

  // ---- 2. Authorize: caller must be an admin --------------------------------
  const { data: prof, error: profErr } = await admin
    .from("profiles")
    .select("is_admin")
    .eq("id", callerId)
    .maybeSingle();
  if (profErr) return json({ error: "profile_lookup_failed", detail: profErr.message }, 500, origin);
  if (!prof?.is_admin) return json({ error: "not_authorized" }, 403, origin);

  // ---- 3. Route -------------------------------------------------------------
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "overview";

  try {
    switch (action) {
      case "overview":
        return json(await overview(), 200, origin);
      case "signups":
        return json(await signups(), 200, origin);
      case "cost":
        return json(await cost(url), 200, origin);
      case "top_users":
        return json(await topUsers(), 200, origin);
      case "users":
        return json(await users(url), 200, origin);
      case "set_tier":
        return json(await setTier(req, callerId), 200, origin);
      case "set_deleted":
        return json(await setDeleted(req, callerId), 200, origin);
      default:
        return json({ error: "unknown_action", action }, 400, origin);
    }
  } catch (e) {
    return json({ error: "handler_failed", action, detail: String(e?.message ?? e) }, 500, origin);
  }
});

// ── Headline numbers (reuses ai_admin_overview RPC) ─────────────────────────
async function overview() {
  const { data, error } = await admin.rpc("ai_admin_overview");
  if (error) throw error;
  // RPC returns a single-row table.
  return { overview: Array.isArray(data) ? data[0] ?? null : data };
}

// ── Signups: per-day new users over the last 30 days ────────────────────────
async function signups() {
  const from = daysAgoUTC(29);
  const { data, error } = await admin
    .from("profiles")
    .select("created_at")
    .gte("created_at", `${from}T00:00:00Z`)
    .order("created_at", { ascending: true })
    .limit(100000);
  if (error) throw error;

  const buckets = new Map<string, number>();
  for (let i = 0; i < 30; i++) buckets.set(daysAgoUTC(29 - i), 0);
  for (const r of data ?? []) {
    const d = String(r.created_at).slice(0, 10);
    if (buckets.has(d)) buckets.set(d, (buckets.get(d) ?? 0) + 1);
  }
  const daily = [...buckets.entries()].map(([date, count]) => ({ date, count }));

  const { count: total } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true });

  return { total: total ?? 0, window_new: data?.length ?? 0, daily };
}

// ── AI cost: daily USD spend over a window (reuses ai_usage_cost_report) ─────
async function cost(url: URL) {
  const from = url.searchParams.get("from") ?? daysAgoUTC(29);
  const to = url.searchParams.get("to") ?? todayUTC();
  const { data, error } = await admin.rpc("ai_usage_cost_report", { p_from: from, p_to: to });
  if (error) throw error;

  const buckets = new Map<string, number>();
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  for (let i = 0; i <= days; i++) buckets.set(daysAgoFrom(from, i), 0);

  let total = 0;
  let unpriced = false;
  for (const r of data ?? []) {
    const d = String(r.usage_date).slice(0, 10);
    const c = Number(r.cost_usd) || 0;
    buckets.set(d, (buckets.get(d) ?? 0) + c);
    total += c;
    if (r.unpriced) unpriced = true;
  }
  const daily = [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, usd]) => ({ date, usd: Math.round(usd * 1e6) / 1e6 }));
  return { from, to, total_usd: Math.round(total * 1e6) / 1e6, unpriced, daily };
}
function daysAgoFrom(from: string, i: number) {
  return new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10);
}

// ── Top 10 users by tokens (last 30d) ───────────────────────────────────────
// Aggregated in-function over the service-role-only ledger, then mapped to
// emails via the auth admin API. Volume is small for v1; capped defensively.
async function topUsers() {
  const from = daysAgoUTC(29);
  const { data, error } = await admin
    .from("ai_usage_events")
    .select("user_id,total_tokens,input_tokens,output_tokens")
    .gte("created_at", `${from}T00:00:00Z`)
    .not("user_id", "is", null)
    .limit(200000);
  if (error) throw error;

  const agg = new Map<string, { tokens: number; input: number; output: number; calls: number }>();
  for (const r of data ?? []) {
    const id = r.user_id as string;
    const cur = agg.get(id) ?? { tokens: 0, input: 0, output: 0, calls: 0 };
    cur.tokens += Number(r.total_tokens) || 0;
    cur.input += Number(r.input_tokens) || 0;
    cur.output += Number(r.output_tokens) || 0;
    cur.calls += 1;
    agg.set(id, cur);
  }
  const top = [...agg.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, 10);

  const emails = await emailMap(top.map(([id]) => id));
  return {
    from,
    top: top.map(([id, v]) => ({
      user_id: id,
      email: emails.get(id) ?? "—",
      total_tokens: v.tokens,
      input_tokens: v.input,
      output_tokens: v.output,
      calls: v.calls,
    })),
  };
}

// ── User list (email, signup, last active, household, tier, item count) ─────
async function users(url: URL) {
  const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 500), 2000);

  const { data: profs, error } = await admin
    .from("profiles")
    .select("id,created_at,last_active_at,household_id,subscription_tier,deleted_at,display_name")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const emails = await emailMap((profs ?? []).map((p) => p.id));

  // Per-household pantry item counts (single scan, aggregated in JS).
  const itemCounts = new Map<string, number>();
  const { data: items } = await admin
    .from("pantry_items")
    .select("household_id")
    .limit(500000);
  for (const it of items ?? []) {
    const h = it.household_id as string | null;
    if (h) itemCounts.set(h, (itemCounts.get(h) ?? 0) + 1);
  }

  let rows = (profs ?? []).map((p) => ({
    id: p.id,
    email: emails.get(p.id) ?? "—",
    display_name: p.display_name ?? null,
    created_at: p.created_at,
    last_active_at: p.last_active_at,
    household_id: p.household_id,
    tier: p.subscription_tier ?? "free",
    is_deleted: !!p.deleted_at,
    item_count: p.household_id ? itemCounts.get(p.household_id) ?? 0 : 0,
  }));

  if (search) {
    rows = rows.filter(
      (r) =>
        r.email.toLowerCase().includes(search) ||
        (r.display_name ?? "").toLowerCase().includes(search) ||
        (r.household_id ?? "").toLowerCase().includes(search),
    );
  }
  return { count: rows.length, users: rows };
}

// ── Admin actions (reuse the audited RPCs; caller id passed as acting admin) ─
async function setTier(req: Request, callerId: string) {
  const body = await req.json().catch(() => ({}));
  const p_user = body.user_id;
  const p_tier = body.tier;
  if (!p_user || !["free", "pro"].includes(p_tier)) throw new Error("bad_params");
  const { error } = await admin.rpc("admin_set_subscription_tier", {
    p_admin: callerId,
    p_user,
    p_tier,
  });
  if (error) throw error;
  return { ok: true, user_id: p_user, tier: p_tier };
}

async function setDeleted(req: Request, callerId: string) {
  const body = await req.json().catch(() => ({}));
  const p_user = body.user_id;
  const p_deleted = !!body.deleted;
  if (!p_user) throw new Error("bad_params");
  const { error } = await admin.rpc("admin_set_user_deleted", {
    p_admin: callerId,
    p_user,
    p_deleted,
  });
  if (error) throw error;
  return { ok: true, user_id: p_user, deleted: p_deleted };
}

// ── Helper: map a set of user ids -> email via the auth admin API ────────────
async function emailMap(ids: string[]): Promise<Map<string, string>> {
  const want = new Set(ids);
  const out = new Map<string, string>();
  if (want.size === 0) return out;
  // listUsers is paginated; scan until we've resolved everyone or run out.
  let page = 1;
  const perPage = 1000;
  while (out.size < want.size && page <= 50) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data?.users?.length) break;
    for (const u of data.users) {
      if (want.has(u.id) && u.email) out.set(u.id, u.email);
    }
    if (data.users.length < perPage) break;
    page++;
  }
  return out;
}
