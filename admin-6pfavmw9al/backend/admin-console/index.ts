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
//     3. Fans out to the existing service-role-only RPCs shipped in migration
//        20260721050000 (ai_admin_overview, ai_usage_cost_report,
//        admin_set_subscription_tier, admin_set_user_deleted, get_ai_quota)
//        plus a few direct service-role reads, and returns plain JSON.
//
//   The service role key never leaves the server. The browser only ever sends
//   its own user access token.
//
// v2 ADDITIONS (no new migration required — all reuse existing tables/RPCs):
//   Reads:  cost_by_function, cost_by_model, quota_events, regeneration_rate,
//           signup_sources, user_pantry, user_usage_log, activity_log
//   Write:  reset_quota  (zeroes today's ai_usage_daily counters for a user,
//                         audited to admin_activity_logs)
//   The `users` action now also returns provider (sign-in method), the
//   private-relay flag, and each user's rolling 30d AI $ cost.
//
// DEPLOY (see admin/backend/DEPLOY.md for the full runbook):
//   supabase functions deploy admin-console --project-ref rhhaojpsqfbapltcvsbz
//   (verify_jwt can stay ON — we also re-check admin in-body as defense in depth)
//
// PREREQUISITE MIGRATIONS (must be applied to the project first):
//   - 20260411000000_admin_bypass_policies.sql   (is_admin(), admin bypass)
//   - 20260714000000_ai_usage_limits.sql          (ai_usage_daily, get_ai_quota)
//   - 20260718130000_ai_usage_events.sql          (spend ledger)
//   - 20260721050000_ai_model_pricing_and_admin.sql (pricing + admin RPCs)
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

const PRIVATE_RELAY_DOMAIN = "@privaterelay.appleid.com";

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
      // ── v2 read actions ──────────────────────────────────────────────────
      case "cost_by_function":
        return json(await costBreakdown("function"), 200, origin);
      case "cost_by_model":
        return json(await costBreakdown("model"), 200, origin);
      case "quota_events":
        return json(await quotaEvents(), 200, origin);
      case "regeneration_rate":
        return json(await regenerationRate(), 200, origin);
      case "signup_sources":
        return json(await signupSources(), 200, origin);
      case "user_pantry":
        return json(await userPantry(url), 200, origin);
      case "user_usage_log":
        return json(await userUsageLog(url), 200, origin);
      case "activity_log":
        return json(await activityLog(), 200, origin);
      // ── v2 write action ──────────────────────────────────────────────────
      case "reset_quota":
        return json(await resetQuota(req, callerId), 200, origin);
      default:
        return json({ error: "unknown_action", action }, 400, origin);
    }
  } catch (e) {
    return json({ error: "handler_failed", action, detail: String((e as { message?: unknown })?.message ?? e) }, 500, origin);
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

// ── AI cost breakdown by function OR by model (last 30d) ────────────────────
// Reuses the priced ai_usage_cost_report RPC (which already joins the price
// book per row) and re-aggregates its rows in-function by the requested key.
async function costBreakdown(key: "function" | "model") {
  const from = daysAgoUTC(29);
  const to = todayUTC();
  const { data, error } = await admin.rpc("ai_usage_cost_report", { p_from: from, p_to: to });
  if (error) throw error;

  const agg = new Map<string, { label: string; cost: number; calls: number; in: number; out: number }>();
  let total = 0;
  let unpriced = false;
  for (const r of data ?? []) {
    const label =
      key === "function"
        ? String(r.function ?? "unknown")
        : `${r.provider ?? "?"}/${r.model ?? "unknown"}`;
    const cur = agg.get(label) ?? { label, cost: 0, calls: 0, in: 0, out: 0 };
    cur.cost += Number(r.cost_usd) || 0;
    cur.calls += Number(r.calls) || 0;
    cur.in += Number(r.input_tokens) || 0;
    cur.out += Number(r.output_tokens) || 0;
    agg.set(label, cur);
    total += Number(r.cost_usd) || 0;
    if (r.unpriced) unpriced = true;
  }
  const rows = [...agg.values()]
    .map((v) => ({
      label: v.label,
      cost_usd: Math.round(v.cost * 1e6) / 1e6,
      calls: v.calls,
      input_tokens: v.in,
      output_tokens: v.out,
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
  return { from, to, key, total_usd: Math.round(total * 1e6) / 1e6, unpriced, rows };
}

// ── Quota-reached events (last 30d) ─────────────────────────────────────────
// A user hitting their daily allowance surfaces in the ledger as a
// status='rate_limited' attempt. Group by function: total events + unique
// users affected.
async function quotaEvents() {
  const from = daysAgoUTC(29);
  const { data, error } = await admin
    .from("ai_usage_events")
    .select("function,user_id")
    .eq("status", "rate_limited")
    .gte("created_at", `${from}T00:00:00Z`)
    .limit(200000);
  if (error) throw error;

  const agg = new Map<string, { fn: string; events: number; users: Set<string> }>();
  for (const r of data ?? []) {
    const fn = String(r.function ?? "unknown");
    const cur = agg.get(fn) ?? { fn, events: 0, users: new Set<string>() };
    cur.events += 1;
    if (r.user_id) cur.users.add(r.user_id as string);
    agg.set(fn, cur);
  }
  const rows = [...agg.values()]
    .map((v) => ({ fn: v.fn, events: v.events, unique_users: v.users.size }))
    .sort((a, b) => b.events - a.events);
  const total_events = rows.reduce((s, r) => s + r.events, 0);
  return { from, total_events, rows };
}

// ── Recipe-suggestion quality: regenerations within 60s (last 30d) ──────────
// Heuristic: two successful recipe-suggest calls by the same user inside 60s
// signal the first result was unsatisfying and got regenerated. Counts the
// second (and later) call in each tight cluster.
async function regenerationRate() {
  const from = daysAgoUTC(29);
  const { data, error } = await admin
    .from("ai_usage_events")
    .select("user_id,created_at")
    .eq("function", "recipe-suggest")
    .eq("charged", true)
    .not("user_id", "is", null)
    .gte("created_at", `${from}T00:00:00Z`)
    .order("created_at", { ascending: true })
    .limit(300000);
  if (error) throw error;

  const byUser = new Map<string, number[]>();
  for (const r of data ?? []) {
    const id = r.user_id as string;
    const t = Date.parse(String(r.created_at));
    if (!byUser.has(id)) byUser.set(id, []);
    byUser.get(id)!.push(t);
  }
  const WINDOW = 60000;
  let total = 0;
  let regen = 0;
  const regenUsers = new Set<string>();
  for (const [id, times] of byUser) {
    times.sort((a, b) => a - b);
    total += times.length;
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] <= WINDOW) {
        regen += 1;
        regenUsers.add(id);
      }
    }
  }
  const rate = total > 0 ? Math.round((regen / total) * 1000) / 10 : 0;
  return {
    from,
    generated: total,
    regenerated: regen,
    regen_users: regenUsers.size,
    rate_pct: rate,
  };
}

// ── Signups by sign-in source (last 30d) ────────────────────────────────────
// Provider comes from auth.users app_metadata (server-side only).
async function signupSources() {
  const from = daysAgoUTC(29);
  const { data: profs, error } = await admin
    .from("profiles")
    .select("id")
    .gte("created_at", `${from}T00:00:00Z`)
    .limit(100000);
  if (error) throw error;

  const meta = await userMetaMap((profs ?? []).map((p) => p.id));
  const counts: Record<string, number> = { apple: 0, google: 0, email: 0, other: 0 };
  let privateRelay = 0;
  for (const p of profs ?? []) {
    const m = meta.get(p.id);
    const prov = normalizeProvider(m?.provider, m?.email);
    counts[prov] = (counts[prov] ?? 0) + 1;
    if (m?.email && m.email.toLowerCase().endsWith(PRIVATE_RELAY_DOMAIN)) privateRelay += 1;
  }
  return { from, total: profs?.length ?? 0, counts, private_relay: privateRelay };
}

// ── Recent admin activity (last 20 audited actions) ─────────────────────────
async function activityLog() {
  const { data, error } = await admin
    .from("admin_activity_logs")
    .select("id,created_at,admin_id,action,target_user_id,details")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;

  const ids = new Set<string>();
  for (const r of data ?? []) {
    if (r.admin_id) ids.add(r.admin_id as string);
    if (r.target_user_id) ids.add(r.target_user_id as string);
  }
  const meta = await userMetaMap([...ids]);
  const rows = (data ?? []).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    action: r.action,
    admin_email: r.admin_id ? meta.get(r.admin_id as string)?.email ?? "—" : "—",
    target_email: r.target_user_id ? meta.get(r.target_user_id as string)?.email ?? "—" : "—",
    details: r.details ?? null,
  }));
  return { rows };
}

// ── A single user's current pantry (via their household) ────────────────────
async function userPantry(url: URL) {
  const userId = url.searchParams.get("user_id");
  if (!userId) throw new Error("bad_params");
  const { data: prof, error: pe } = await admin
    .from("profiles")
    .select("household_id")
    .eq("id", userId)
    .maybeSingle();
  if (pe) throw pe;
  const householdId = prof?.household_id as string | null;
  if (!householdId) return { user_id: userId, household_id: null, count: 0, items: [] };

  const { data: items, error } = await admin
    .from("pantry_items")
    .select("name,category,status,expiry_estimate,added_at")
    .eq("household_id", householdId)
    .order("added_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  return {
    user_id: userId,
    household_id: householdId,
    count: items?.length ?? 0,
    items: items ?? [],
  };
}

// ── A single user's recent AI calls (default last 7d) with per-call cost ────
async function userUsageLog(url: URL) {
  const userId = url.searchParams.get("user_id");
  if (!userId) throw new Error("bad_params");
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 7), 1), 30);
  const from = daysAgoUTC(days - 1);

  const { data, error } = await admin
    .from("ai_usage_events")
    .select("created_at,function,operation,provider,model,status,charged,input_tokens,output_tokens,total_tokens")
    .eq("user_id", userId)
    .gte("created_at", `${from}T00:00:00Z`)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw error;

  const priceMap = await pricingMap();
  let total = 0;
  const rows = (data ?? []).map((r) => {
    const c = rowCost(r, priceMap);
    total += c;
    return {
      created_at: r.created_at,
      fn: r.function,
      operation: r.operation,
      model: r.model ? `${r.provider}/${r.model}` : r.provider,
      status: r.status,
      charged: r.charged,
      total_tokens: r.total_tokens,
      cost_usd: Math.round(c * 1e6) / 1e6,
    };
  });
  return { user_id: userId, days, count: rows.length, total_usd: Math.round(total * 1e6) / 1e6, rows };
}

// ── Reset a user's daily quota (support action) ─────────────────────────────
// Zeroes today's ai_usage_daily counters for the user, on their *local* usage
// day (derived server-side via get_ai_quota → fg_quota_window). If a feature is
// given, only that feature is reset; otherwise every feature for today. Audited.
async function resetQuota(req: Request, callerId: string) {
  const body = await req.json().catch(() => ({}));
  const userId = body.user_id as string | undefined;
  const feature = (body.feature as string | undefined) || null;
  if (!userId) throw new Error("bad_params");

  // Derive the user's *local* usage_date the same way the quota system does.
  // get_ai_quota computes it from fg_quota_window(fg_effective_timezone(user));
  // the feature passed here only affects unrelated fields we ignore.
  const { data: q, error: qe } = await admin.rpc("get_ai_quota", {
    p_feature: feature ?? "recipe-suggest",
    p_user_id: userId,
  });
  if (qe) throw qe;
  const usageDate = (q && (q as Record<string, unknown>).usage_date) as string | undefined;
  if (!usageDate) throw new Error("could_not_resolve_usage_date");

  let query = admin
    .from("ai_usage_daily")
    .update({ used: 0, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("usage_date", usageDate)
    .gt("used", 0);
  if (feature) query = query.eq("feature", feature);
  const { data: updated, error } = await query.select("feature,used");
  if (error) throw error;

  // Audit trail (mirrors the RPC-audited admin actions).
  await admin.from("admin_activity_logs").insert({
    admin_id: callerId,
    action: "reset_daily_quota",
    target_user_id: userId,
    details: { feature: feature ?? "all", usage_date: usageDate, reset_count: updated?.length ?? 0 },
  });

  return {
    ok: true,
    user_id: userId,
    feature: feature ?? "all",
    usage_date: usageDate,
    reset_features: (updated ?? []).map((u) => u.feature),
  };
}

// ── Top 10 users by tokens (last 30d) ───────────────────────────────────────
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

  const meta = await userMetaMap(top.map(([id]) => id));
  return {
    from,
    top: top.map(([id, v]) => ({
      user_id: id,
      email: meta.get(id)?.email ?? "—",
      total_tokens: v.tokens,
      input_tokens: v.input,
      output_tokens: v.output,
      calls: v.calls,
    })),
  };
}

// ── User list (identity, activity, tier, item count, 30d AI cost) ───────────
async function users(url: URL) {
  const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 500), 2000);

  const { data: profs, error } = await admin
    .from("profiles")
    .select("id,created_at,last_active_at,household_id,subscription_tier,deleted_at,display_name")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const meta = await userMetaMap((profs ?? []).map((p) => p.id));

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

  // Per-user 30d AI $ cost (single ledger scan + local price book).
  const costByUser = await userCost30d();

  let rows = (profs ?? []).map((p) => {
    const m = meta.get(p.id);
    const email = m?.email ?? "—";
    return {
      id: p.id,
      email,
      display_name: p.display_name ?? null,
      provider: normalizeProvider(m?.provider, email),
      private_relay: email.toLowerCase().endsWith(PRIVATE_RELAY_DOMAIN),
      created_at: p.created_at,
      last_active_at: p.last_active_at,
      household_id: p.household_id,
      tier: p.subscription_tier ?? "free",
      is_deleted: !!p.deleted_at,
      item_count: p.household_id ? itemCounts.get(p.household_id) ?? 0 : 0,
      cost_30d_usd: Math.round((costByUser.get(p.id) ?? 0) * 1e6) / 1e6,
    };
  });

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

// ── Pricing helpers ─────────────────────────────────────────────────────────
type Price = { in: number; out: number; flat: number };
async function pricingMap(): Promise<Map<string, Price>> {
  const { data, error } = await admin
    .from("ai_model_pricing")
    .select("provider,model,input_usd_per_mtok,output_usd_per_mtok,flat_usd_per_call,effective_from")
    .order("effective_from", { ascending: true });
  if (error) throw error;
  // Latest effective_from ≤ today wins (rows are ordered ascending, so the last
  // write per key overwrites earlier ones).
  const today = todayUTC();
  const m = new Map<string, Price>();
  for (const r of data ?? []) {
    if (String(r.effective_from).slice(0, 10) > today) continue;
    m.set(`${r.provider}|${r.model}`, {
      in: Number(r.input_usd_per_mtok) || 0,
      out: Number(r.output_usd_per_mtok) || 0,
      flat: Number(r.flat_usd_per_call) || 0,
    });
  }
  return m;
}
function rowCost(
  r: { provider?: string | null; model?: string | null; input_tokens?: number | null; output_tokens?: number | null },
  prices: Map<string, Price>,
): number {
  const p = prices.get(`${r.provider}|${r.model}`);
  if (!p) return 0;
  return (
    ((Number(r.input_tokens) || 0) / 1e6) * p.in +
    ((Number(r.output_tokens) || 0) / 1e6) * p.out +
    p.flat
  );
}

// Per-user 30d cost, computed with one ledger scan against the price book.
async function userCost30d(): Promise<Map<string, number>> {
  const from = daysAgoUTC(29);
  const prices = await pricingMap();
  const { data, error } = await admin
    .from("ai_usage_events")
    .select("user_id,provider,model,input_tokens,output_tokens")
    .gte("created_at", `${from}T00:00:00Z`)
    .not("user_id", "is", null)
    .limit(300000);
  if (error) throw error;
  const out = new Map<string, number>();
  for (const r of data ?? []) {
    const id = r.user_id as string;
    out.set(id, (out.get(id) ?? 0) + rowCost(r, prices));
  }
  return out;
}

// ── Provider normalization ──────────────────────────────────────────────────
function normalizeProvider(provider?: string | null, email?: string | null): string {
  const p = (provider ?? "").toLowerCase();
  if (p.includes("apple")) return "apple";
  if (p.includes("google")) return "google";
  if (p === "email") return "email";
  // Fall back to email shape when metadata is absent.
  if (email && email.toLowerCase().endsWith(PRIVATE_RELAY_DOMAIN)) return "apple";
  if (email && email.toLowerCase().includes("gmail.com")) return "google";
  if (email && email.includes("@")) return "email";
  return "other";
}

// ── Helper: map user ids -> { email, provider } via the auth admin API ───────
type UserMeta = { email: string | null; provider: string | null };
async function userMetaMap(ids: string[]): Promise<Map<string, UserMeta>> {
  const want = new Set(ids);
  const out = new Map<string, UserMeta>();
  if (want.size === 0) return out;
  let page = 1;
  const perPage = 1000;
  while (out.size < want.size && page <= 50) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data?.users?.length) break;
    for (const u of data.users) {
      if (!want.has(u.id)) continue;
      const provider =
        (u.app_metadata?.provider as string | undefined) ??
        (Array.isArray(u.identities) ? (u.identities[0]?.provider as string | undefined) : undefined) ??
        null;
      out.set(u.id, { email: u.email ?? null, provider: provider ?? null });
    }
    if (data.users.length < perPage) break;
    page++;
  }
  return out;
}
