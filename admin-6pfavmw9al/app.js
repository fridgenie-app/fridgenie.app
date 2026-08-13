// Jujube admin — client app. Vanilla ES module + supabase-js (publishable key).
// All privileged data flows through the is_admin()-gated `admin-console` edge
// function; the browser only ever holds the user's own magic-link session.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CFG = window.JUJUBE_ADMIN_CONFIG;
const FN_BASE = `${CFG.SUPABASE_URL}/functions/v1/${CFG.FUNCTION_NAME}`;
const LOGIN_FN_URL = `${CFG.SUPABASE_URL}/functions/v1/admin-login`;

const sb = createClient(CFG.SUPABASE_URL, CFG.PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// ── tiny DOM helpers ────────────────────────────────────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const views = ["loading", "signin", "denied", "dash"];
function show(name) {
  views.forEach((v) => $(`#view-${v}`).classList.toggle("hidden", v !== name));
}
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 3200);
}
const fmtInt = (n) => (n == null ? "–" : Number(n).toLocaleString("en-US"));
const fmtUSD = (n) =>
  n == null ? "–" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
function relTime(s) {
  if (!s) return "never";
  const d = (Date.now() - new Date(s).getTime()) / 86400000;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 30) return `${Math.floor(d)}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}
// Dollar formatter that keeps precision for the small per-user/per-call amounts.
const fmtUSDsmall = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return "$0";
  if (v < 1) return `$${v.toFixed(4)}`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const daysSince = (s) => (s ? Math.max(0, Math.floor((Date.now() - new Date(s).getTime()) / 86400000)) : null);
const fmtFull = (s) => (s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for contexts without the async clipboard API (older mobile Safari).
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch { /* best-effort */ }
    ta.remove();
  }
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = "✓"; btn.classList.add("copied");
    setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); }, 1100);
  }
}
function copyBtn(text, label = "Copy") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "copy-btn";
  b.textContent = "⧉";
  b.title = `${label} (click to copy)`;
  b.addEventListener("click", (ev) => { ev.stopPropagation(); copyToClipboard(text, b); });
  return b;
}
const PROVIDER_LABEL = { apple: "Apple", google: "Google", email: "Email", other: "—" };
function providerBadge(p) {
  const key = PROVIDER_LABEL[p] ? p : "other";
  return `<span class="method method-${key}">${PROVIDER_LABEL[key]}</span>`;
}
// Visible tier badge per user row/card (Free / Pro / Founding) — makes it hard
// to misread a row's tier before a grant/revoke. Unknown tiers fall back to Free.
const TIER_META = {
  pro: { label: "Pro", cls: "pro" },
  founding: { label: "Founding", cls: "founding" },
  free: { label: "Free", cls: "free" },
};
function tierBadge(tier) {
  const t = TIER_META[tier] || TIER_META.free;
  return `<span class="pill tier-pill ${t.cls}">${t.label}</span>`;
}
// Inline percentage bar used by the cost-breakdown tables.
function shareBar(frac) {
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
  return `<span class="sharebar"><span class="sharebar-fill" style="width:${pct}%"></span></span><span class="sharebar-pct">${pct}%</span>`;
}

// ── edge function client ────────────────────────────────────────────────────
async function callFn(action, { method = "GET", body, params } = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("no_session");
  const url = new URL(FN_BASE);
  url.searchParams.set("action", action);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: CFG.PUBLISHABLE_KEY,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error || `http_${res.status}`);
    err.status = res.status;
    err.detail = payload.detail;
    throw err;
  }
  return payload;
}

// ── minimal SVG bar chart ───────────────────────────────────────────────────
function barChart(el, data, { valueKey, labelKey, fmt = fmtInt }) {
  el.innerHTML = "";
  if (!data || !data.length) { el.innerHTML = `<p class="muted small">No data.</p>`; return; }
  const W = el.clientWidth || 480, H = el.clientHeight || 190;
  const padB = 22, padL = 6, padT = 14, padR = 6;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(...data.map((d) => Number(d[valueKey]) || 0), 1);
  const bw = iw / data.length;
  const svgns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");

  // gridlines + max label
  [0, 0.5, 1].forEach((f) => {
    const y = padT + ih * (1 - f);
    const ln = document.createElementNS(svgns, "line");
    ln.setAttribute("x1", padL); ln.setAttribute("x2", W - padR);
    ln.setAttribute("y1", y); ln.setAttribute("y2", y);
    ln.setAttribute("class", "gridline");
    svg.appendChild(ln);
  });
  const maxLbl = document.createElementNS(svgns, "text");
  maxLbl.setAttribute("x", padL + 2); maxLbl.setAttribute("y", padT - 3);
  maxLbl.setAttribute("class", "axis-lbl"); maxLbl.textContent = fmt(max);
  svg.appendChild(maxLbl);

  data.forEach((d, i) => {
    const v = Number(d[valueKey]) || 0;
    const h = (v / max) * ih;
    const x = padL + i * bw;
    const rect = document.createElementNS(svgns, "rect");
    rect.setAttribute("x", x + bw * 0.16);
    rect.setAttribute("y", padT + ih - h);
    rect.setAttribute("width", bw * 0.68);
    rect.setAttribute("height", Math.max(h, v > 0 ? 1.5 : 0));
    rect.setAttribute("rx", Math.min(3, bw * 0.3));
    rect.setAttribute("class", "bar");
    const title = document.createElementNS(svgns, "title");
    title.textContent = `${d[labelKey]}: ${fmt(v)}`;
    rect.appendChild(title);
    svg.appendChild(rect);
    // sparse x labels (~6)
    if (i % Math.ceil(data.length / 6) === 0) {
      const tx = document.createElementNS(svgns, "text");
      tx.setAttribute("x", x + bw / 2); tx.setAttribute("y", H - 6);
      tx.setAttribute("text-anchor", "middle"); tx.setAttribute("class", "axis-lbl");
      tx.textContent = new Date(d[labelKey]).toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
      svg.appendChild(tx);
    }
  });
  el.appendChild(svg);
}

// ── section loaders ─────────────────────────────────────────────────────────
async function loadOverview() {
  const { overview: o } = await callFn("overview");
  if (!o) return;
  const setTile = (k, val) => { const t = $(`.tile[data-k="${k}"] .tile-val`); if (t) t.textContent = val; };
  setTile("total_users", fmtInt(o.total_users));
  setTile("pro_users", fmtInt(o.pro_users));
  setTile("dau", fmtInt(o.dau));
  setTile("wau", fmtInt(o.wau));
  setTile("mau", fmtInt(o.mau));
  setTile("cost_30d_usd", fmtUSD(o.cost_30d_usd));
  const setMini = (k, val) => { const t = $(`.mini-val[data-k="${k}"]`); if (t) t.textContent = val; };
  setMini("households", fmtInt(o.households));
  setMini("pantry_items", fmtInt(o.pantry_items));
  setMini("recipes_cooked", fmtInt(o.recipes_cooked));
  setMini("ai_recipes", fmtInt(o.ai_recipes));
}

async function loadSignups() {
  const state = $("#signups-state");
  try {
    const r = await callFn("signups");
    $("#signups-note").textContent = `${fmtInt(r.total)} total · ${fmtInt(r.window_new)} in 30d`;
    barChart($("#signups-chart"), r.daily, { valueKey: "count", labelKey: "date", fmt: fmtInt });
    state.textContent = "";
  } catch (e) { sectionErr(state, e); }
}

// ── v3: DAU/WAU/MAU from app_open_events (v2.4.3+, separate from the
// AI-usage-driven dau/wau/mau tiles in the overview() headline). ────────────
async function loadActiveUsersTrend() {
  const state = $("#dau-trend-state");
  try {
    const r = await callFn("active_users_trend");
    if (r.sparse) {
      $("#dau-trend-note").textContent = r.since
        ? `Tracking since ${fmtDate(r.since)} — still filling in`
        : "No app-open data yet";
    } else {
      $("#dau-trend-note").textContent = `DAU ${fmtInt(r.dau)} · WAU ${fmtInt(r.wau)} · MAU ${fmtInt(r.mau)}`;
    }
    barChart($("#dau-trend-chart"), r.daily, { valueKey: "dau", labelKey: "date", fmt: fmtInt });
    state.textContent = r.sparse
      ? `App-open tracking is new (since ${fmtDate(r.since)}) — DAU ${fmtInt(r.dau)} · WAU ${fmtInt(r.wau)} · MAU ${fmtInt(r.mau)} so far.`
      : "";
  } catch (e) { sectionErr(state, e); }
}

// ── Onboarding funnel (v2.5.0, onboarding_events) — per-step user counts for
// the post-signup `/setup` chain. Two steps (sub_purchase_started/succeeded
// and continue_free) are parallel branches off sub_screen_reached, not a
// strict line — see the `comparedTo` field the edge function already
// resolved server-side; drop-off here is always "vs its own funnel parent."
const FUNNEL_STEP_LABEL = {
  signup_done: "Signed up",
  name_done: "Entered name",
  preferences_done: "Set taste preferences",
  household_done: "Set up household",
  quick_stock_reached: "Reached fill-kitchen",
  sub_screen_reached: "Reached subscription screen",
  sub_purchase_started: "Started purchase",
  sub_purchase_succeeded: "Purchase succeeded",
  continue_free: "Continued free",
  onboarding_finished: "Finished onboarding",
};
async function loadOnboardingFunnel() {
  const state = $("#funnel-state");
  const tb = $("#funnel-tbl tbody");
  const params = {};
  const fromVal = $("#funnel-from").value;
  const toVal = $("#funnel-to").value;
  if (fromVal) params.from = fromVal;
  if (toVal) params.to = toVal;
  try {
    const r = await callFn("onboarding_funnel", { params });
    $("#funnel-from").value = r.from;
    $("#funnel-to").value = r.to;
    $("#funnel-note").textContent = `${fmtInt(r.signup_done)} signed up · ${r.from} → ${r.to}`;
    tb.innerHTML = "";
    if (!r.rows.length) { state.textContent = "No onboarding events in this range."; return; }
    for (const row of r.rows) {
      const tr = document.createElement("tr");
      const dropoffCell = row.compared_to
        ? `<span class="${row.dropoff_pct >= 30 ? "text-warn" : ""}">${row.dropoff_pct}%</span>`
        : `<span class="muted small">—</span>`;
      tr.innerHTML = `<td class="mono-lbl">${escapeHtml(FUNNEL_STEP_LABEL[row.step] || row.step)}</td>
        <td class="num">${fmtInt(row.count)}</td>
        <td>${shareBar((row.pct_of_signup || 0) / 100)}</td>
        <td>${dropoffCell}</td>
        <td class="num">${fmtInt(row.ios_count)}</td>
        <td class="num">${fmtInt(row.android_count)}</td>`;
      tb.appendChild(tr);
    }
    state.textContent = "";
  } catch (e) { sectionErr(state, e); }
}

// ── Promo Codes (admin-generated, v2.6.0) ───────────────────────────────────
// UI-copy semantics kept explicit here so this stays legible without the
// backend comment alongside it: max_uses = how many DIFFERENT people can
// redeem; expires_at = deadline to REDEEM (not how long Pro lasts);
// grant_duration = how long the granted Pro access lasts once redeemed.
const GRANT_DURATION_LABEL = {
  daily: "1 day", three_day: "3 days", weekly: "1 week", monthly: "1 month",
  two_month: "2 months", three_month: "3 months", six_month: "6 months",
  yearly: "12 months", lifetime: "Lifetime",
};
let PROMO_CACHE = [];
const PROMO_PAGE_SIZE = 10;
let promoPage = 0;

async function loadPromoCodes() {
  const state = $("#promo-state");
  const tb = $("#promo-tbl tbody");
  try {
    const r = await callFn("promo_codes");
    PROMO_CACHE = r.rows;
    promoPage = 0;
    renderPromoCodes();
    $("#promo-note").textContent = `${fmtInt(r.rows.length)} code${r.rows.length === 1 ? "" : "s"}`;
    state.textContent = "";
  } catch (e) { tb.innerHTML = ""; sectionErr(state, e); }
}

function renderPromoCodes() {
  const tb = $("#promo-tbl tbody");
  tb.innerHTML = "";
  const rows = PROMO_CACHE;
  const totalPages = Math.max(1, Math.ceil(rows.length / PROMO_PAGE_SIZE));
  promoPage = Math.min(promoPage, totalPages - 1);
  const start = promoPage * PROMO_PAGE_SIZE;
  const pageRows = rows.slice(start, start + PROMO_PAGE_SIZE);

  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="7" class="muted small">No promo codes yet.</td></tr>`;
  } else {
    for (const row of pageRows) {
      const tr = document.createElement("tr");
      const usesLabel = row.max_uses == null ? `${fmtInt(row.redemption_count)} / ∞` : `${fmtInt(row.redemption_count)} / ${fmtInt(row.max_uses)}`;
      const expiresLabel = row.expires_at ? fmtDate(row.expires_at) : "Never";
      tr.innerHTML = `
        <td class="promo-code-cell">${escapeHtml(row.code)}</td>
        <td class="muted small">${escapeHtml(row.description || "—")}</td>
        <td class="num">${usesLabel}</td>
        <td>${escapeHtml(GRANT_DURATION_LABEL[row.grant_duration] || row.grant_duration)}</td>
        <td>${expiresLabel}</td>
        <td></td>
        <td></td>`;
      const statusTd = tr.children[5];
      const statusBtn = document.createElement("button");
      statusBtn.type = "button";
      statusBtn.className = `promo-status-btn ${row.is_active ? "active" : "inactive"}`;
      statusBtn.textContent = row.is_active ? "Active" : "Inactive";
      statusBtn.addEventListener("click", () => togglePromoActive(row, statusBtn));
      statusTd.appendChild(statusBtn);

      const actionsTd = tr.children[6];
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "promo-delete-btn";
      delBtn.textContent = "🗑";
      delBtn.title = "Delete code";
      delBtn.addEventListener("click", () => deletePromoCode(row, delBtn));
      actionsTd.appendChild(delBtn);

      tb.appendChild(tr);
    }
  }

  $("#promo-page-info").textContent = rows.length ? `Page ${promoPage + 1} of ${totalPages}` : "";
  $("#promo-prev").disabled = promoPage === 0;
  $("#promo-next").disabled = promoPage >= totalPages - 1;
}

$("#promo-prev").addEventListener("click", () => { promoPage = Math.max(0, promoPage - 1); renderPromoCodes(); });
$("#promo-next").addEventListener("click", () => { promoPage += 1; renderPromoCodes(); });

async function togglePromoActive(row, btn) {
  const nextActive = !row.is_active;
  btn.disabled = true;
  try {
    const r = await callFn("set_promo_active", { method: "POST", body: { code: row.code, is_active: nextActive } });
    row.is_active = r.is_active;
    btn.className = `promo-status-btn ${row.is_active ? "active" : "inactive"}`;
    btn.textContent = row.is_active ? "Active" : "Inactive";
    toast(`${row.code} → ${row.is_active ? "active" : "inactive"}`);
  } catch (e) { toast(`Failed: ${e.message}`, true); }
  finally { btn.disabled = false; }
}

async function deletePromoCode(row, btn) {
  const hasRedemptions = row.redemption_count > 0;
  const ok = await confirmDialog({
    title: "Delete promo code?",
    icon: "⚠",
    bodyHtml: hasRedemptions
      ? `<p class="confirm-lead">Delete <b>${escapeHtml(row.code)}</b>?</p>
         <p class="confirm-note">This code has <b>${fmtInt(row.redemption_count)}</b> redemption${row.redemption_count === 1 ? "" : "s"} — deleting removes those users' promo access. Deactivate instead to keep their access while stopping new redemptions.</p>`
      : `<p class="confirm-lead">Delete <b>${escapeHtml(row.code)}</b>?</p>
         <p class="confirm-note">This code has no redemptions yet. This cannot be undone.</p>`,
    confirmLabel: hasRedemptions ? "Delete anyway" : "Delete",
    variant: "danger",
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await callFn("delete_promo_code", { method: "POST", body: { code: row.code } });
    PROMO_CACHE = PROMO_CACHE.filter((r) => r.code !== row.code);
    renderPromoCodes();
    $("#promo-note").textContent = `${fmtInt(PROMO_CACHE.length)} code${PROMO_CACHE.length === 1 ? "" : "s"}`;
    toast(`Deleted ${row.code}`);
    loadActivity();
  } catch (e) {
    toast(`Failed: ${e.message}`, true);
    btn.disabled = false;
  }
}

$("#promo-code").addEventListener("input", (ev) => {
  const cleaned = ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned !== ev.target.value) ev.target.value = cleaned;
  $("#promo-code-err").classList.add("hidden");
});

$("#promo-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = $("#promo-generate-btn");
  const msg = $("#promo-form-msg");
  msg.className = "msg";
  msg.textContent = "";

  const codeVal = $("#promo-code").value.trim().toUpperCase();
  const descVal = $("#promo-desc").value.trim();
  const maxUsesVal = $("#promo-max-uses").value.trim();
  const expiresVal = $("#promo-expires").value;
  const durationVal = $("#promo-duration").value;

  const codeErr = $("#promo-code-err");
  codeErr.classList.add("hidden");
  codeErr.textContent = "";
  if (codeVal && (codeVal.length < 6 || codeVal.length > 16)) {
    codeErr.textContent = "Code must be 6-16 characters.";
    codeErr.classList.remove("hidden");
    return;
  }
  if (codeVal && !/^[A-Z0-9]+$/.test(codeVal)) {
    codeErr.textContent = "Code must be letters and numbers only.";
    codeErr.classList.remove("hidden");
    return;
  }

  const body = {
    code: codeVal || undefined,
    description: descVal || undefined,
    max_uses: maxUsesVal ? Number(maxUsesVal) : null,
    expires_at: expiresVal ? `${expiresVal}T23:59:59Z` : null,
    grant_duration: durationVal,
  };

  btn.disabled = true; btn.textContent = "Generating…";
  try {
    const r = await callFn("create_promo_code", { method: "POST", body });
    const created = r.promo_code;
    const result = $("#promo-result");
    result.classList.remove("hidden");
    result.innerHTML = `
      <span class="promo-result-code">${escapeHtml(created.code)}</span>
      <span class="promo-result-note">Created · ${GRANT_DURATION_LABEL[created.grant_duration] || created.grant_duration} · ${created.max_uses == null ? "unlimited uses" : `max ${created.max_uses} uses`}</span>`;
    result.appendChild(copyBtn(created.code, "Code"));
    $("#promo-form").reset();
    $("#promo-duration").value = "lifetime";
    toast(`Created ${created.code}`);
    loadPromoCodes();
    loadActivity();
  } catch (e) {
    msg.classList.add("err");
    msg.textContent = `Failed: ${e.message}${e.detail ? " · " + e.detail : ""}`;
  } finally {
    btn.disabled = false; btn.textContent = "Generate Code";
  }
});

async function loadCost() {
  const state = $("#cost-state");
  try {
    const r = await callFn("cost");
    $("#cost-note").textContent =
      `${fmtUSD(r.total_usd)} · 30d${r.unpriced ? " · ⚠ unpriced models present" : ""}`;
    barChart($("#cost-chart"), r.daily, { valueKey: "usd", labelKey: "date", fmt: fmtUSD });
    state.textContent = "";
  } catch (e) { sectionErr(state, e); }
}

async function loadTopUsers() {
  const state = $("#top-users-state");
  const tb = $("#top-users-tbl tbody");
  const cards = $("#top-users-cards");
  try {
    const r = await callFn("top_users");
    tb.innerHTML = "";
    if (cards) cards.innerHTML = "";
    if (!r.top.length) { state.textContent = "No AI usage in the last 30 days."; return; }
    for (const u of r.top) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td title="${u.user_id}">${escapeHtml(u.email)}</td>
        <td class="num">${fmtInt(u.total_tokens)}</td>
        <td class="num">${fmtInt(u.calls)}</td>`;
      tb.appendChild(tr);

      if (cards) {
        const card = document.createElement("div");
        card.className = "top-user-card";
        card.innerHTML = `
          <span class="top-user-card-label" title="${escapeHtml(u.email)}">${escapeHtml(u.email)}</span>
          <span class="top-user-card-stats">
            <span><span class="top-user-card-num">${fmtInt(u.total_tokens)}</span><span class="ucf-label">tokens</span></span>
            <span><span class="top-user-card-num">${fmtInt(u.calls)}</span><span class="ucf-label">calls</span></span>
          </span>`;
        cards.appendChild(card);
      }
    }
    state.textContent = "";
  } catch (e) { sectionErr(state, e); }
}

// ── v2: cost breakdowns (function / model) ──────────────────────────────────
async function loadCostBreakdown(action, ids) {
  const state = $(`#${ids.state}`);
  const tb = $(`#${ids.tbl} tbody`);
  try {
    const r = await callFn(action);
    tb.innerHTML = "";
    $(`#${ids.note}`).textContent = `${fmtUSDsmall(r.total_usd)} · 30d${r.unpriced ? " · ⚠ unpriced" : ""}`;
    if (!r.rows.length) { state.textContent = "No AI spend in the last 30 days."; return; }
    const max = r.total_usd || 1;
    for (const row of r.rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="mono-lbl">${escapeHtml(row.label)}</td>
        <td class="num">${fmtUSDsmall(row.cost_usd)}</td>
        <td class="num">${fmtInt(row.calls)}</td>
        <td class="share">${shareBar(row.cost_usd / max)}</td>`;
      tb.appendChild(tr);
    }
    state.textContent = "";
  } catch (e) { sectionErr(state, e); }
}
const loadCostByFunction = () => loadCostBreakdown("cost_by_function", { state: "cbf-state", tbl: "cbf-tbl", note: "cbf-note" });
const loadCostByModel = () => loadCostBreakdown("cost_by_model", { state: "cbm-state", tbl: "cbm-tbl", note: "cbm-note" });

// ── v2: quota-reached events ────────────────────────────────────────────────
async function loadQuotaEvents() {
  const state = $("#quota-state");
  const tb = $("#quota-tbl tbody");
  try {
    const r = await callFn("quota_events");
    tb.innerHTML = "";
    $("#quota-note").textContent = `${fmtInt(r.total_events)} limit hits · 30d`;
    if (!r.rows.length) { state.textContent = "No users hit their daily limit in the last 30 days. 🎉"; return; }
    for (const row of r.rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="mono-lbl">${escapeHtml(row.fn)}</td>
        <td class="num">${fmtInt(row.events)}</td>
        <td class="num">${fmtInt(row.unique_users)}</td>`;
      tb.appendChild(tr);
    }
    state.textContent = "";
  } catch (e) { sectionErr(state, e); }
}

// ── v2: recipe regeneration rate ────────────────────────────────────────────
async function loadRegeneration() {
  const state = $("#regen-state");
  try {
    const r = await callFn("regeneration_rate");
    $("#regen-rate").textContent = `${r.rate_pct}%`;
    $("#regen-gen").textContent = fmtInt(r.generated);
    $("#regen-cnt").textContent = fmtInt(r.regenerated);
    $("#regen-users").textContent = fmtInt(r.regen_users);
    const rateEl = $("#regen-rate");
    rateEl.classList.toggle("warn", r.rate_pct >= 20);
    $("#regen-note").textContent = r.generated ? `${fmtInt(r.generated)} suggestions` : "";
    state.textContent = "";
  } catch (e) { sectionErr(state, e); }
}

// ── v2: signup sources ──────────────────────────────────────────────────────
async function loadSignupSources() {
  const state = $("#src-state");
  try {
    const r = await callFn("signup_sources");
    const set = (k, v) => { const el = $(`#src-tiles .mini-val[data-k="${k}"]`); if (el) el.textContent = fmtInt(v); };
    set("apple", r.counts.apple);
    set("google", r.counts.google);
    set("email", r.counts.email);
    set("private_relay", r.private_relay);
    $("#src-note").textContent = `${fmtInt(r.total)} new · 30d`;
    state.textContent = "";
  } catch (e) { sectionErr(state, e); }
}

// ── v2: recent admin activity ───────────────────────────────────────────────
const ACTION_LABEL = {
  set_subscription_tier: "Set tier",
  soft_delete_user: "Soft-delete",
  restore_user: "Restore",
  reset_daily_quota: "Reset quota",
};
async function loadActivity() {
  const state = $("#activity-state");
  const tb = $("#activity-tbl tbody");
  try {
    const r = await callFn("activity_log");
    tb.innerHTML = "";
    if (!r.rows.length) { state.textContent = "No admin actions recorded yet."; return; }
    for (const row of r.rows) {
      const label = ACTION_LABEL[row.action] || row.action;
      const details = row.details ? Object.entries(row.details).map(([k, v]) => `${k}=${v}`).join(", ") : "";
      const tr = document.createElement("tr");
      tr.innerHTML = `<td title="${row.created_at ?? ""}">${relTime(row.created_at)}</td>
        <td><span class="pill neutral">${escapeHtml(label)}</span></td>
        <td>${escapeHtml(row.admin_email)}</td>
        <td>${escapeHtml(row.target_email)}</td>
        <td class="muted small">${escapeHtml(details)}</td>`;
      tb.appendChild(tr);
    }
    state.textContent = "";
  } catch (e) { sectionErr(state, e); }
}

// ── v2: modals (pantry / usage log) ─────────────────────────────────────────
function openModal(title) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = `<div class="spinner modal-spinner"></div>`;
  $("#modal").classList.remove("hidden");
}
function closeModal() { $("#modal").classList.add("hidden"); }

// ── confirmation dialog ──────────────────────────────────────────────────────
// A styled, deliberate replacement for window.confirm() for consequential user
// actions (grant/revoke pro, soft-delete). Shows exactly WHO is affected — name,
// email, and current tier — so a click can't silently land on the wrong user.
// Returns a Promise<boolean>.
function confirmDialog({ title, icon = "", bodyHtml = "", confirmLabel = "Confirm", variant = "primary" }) {
  return new Promise((resolve) => {
    const overlay = $("#confirm");
    const okBtn = $("#confirm-ok");
    const cancelBtn = $("#confirm-cancel");
    $("#confirm-title").textContent = title;
    $("#confirm-icon").textContent = icon;
    $("#confirm-icon").style.display = icon ? "" : "none";
    $("#confirm-body").innerHTML = bodyHtml;
    okBtn.textContent = confirmLabel;
    okBtn.className = "btn btn-" + variant; // btn-primary | btn-good | btn-danger
    overlay.classList.remove("hidden");
    okBtn.focus();

    let done = false;
    const cleanup = () => {
      overlay.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey, true);
    };
    const finish = (val) => { if (done) return; done = true; cleanup(); resolve(val); };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (ev) => { if (ev.target === overlay) finish(false); };
    const onKey = (ev) => {
      if (ev.key === "Escape") { ev.stopPropagation(); finish(false); }
      else if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onBackdrop);
    // Capture-phase so Escape resolves the dialog before the page-level handler.
    document.addEventListener("keydown", onKey, true);
  });
}

async function openPantry(u) {
  openModal(`Pantry · ${u.display_name || u.email}`);
  try {
    const r = await callFn("user_pantry", { params: { user_id: u.id } });
    if (!r.items.length) { $("#modal-body").innerHTML = `<p class="muted small">Empty pantry (no items).</p>`; return; }
    const rows = r.items.map((it) => `<tr>
      <td>${escapeHtml(it.name)}</td>
      <td>${escapeHtml(it.category ?? "")}</td>
      <td>${escapeHtml(it.status ?? "")}</td>
      <td class="muted small">${escapeHtml(it.expiry_estimate ?? "")}</td></tr>`).join("");
    $("#modal-body").innerHTML = `<p class="muted small modal-sub">${fmtInt(r.count)} items</p>
      <div class="scroll"><table class="tbl"><thead><tr><th>Item</th><th>Where</th><th>Status</th><th>Expiry</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch (e) { $("#modal-body").innerHTML = `<p class="panel-state err">Error: ${escapeHtml(e.message)}</p>`; }
}

async function openUsageLog(u) {
  openModal(`Usage log · ${u.display_name || u.email}`);
  try {
    const r = await callFn("user_usage_log", { params: { user_id: u.id, days: "7" } });
    if (!r.rows.length) { $("#modal-body").innerHTML = `<p class="muted small">No AI calls in the last 7 days.</p>`; return; }
    const rows = r.rows.map((c) => `<tr class="${c.status !== "ok" ? "log-err" : ""}">
      <td class="muted small" title="${c.created_at}">${new Date(c.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
      <td class="mono-lbl">${escapeHtml(c.fn ?? "")}</td>
      <td class="muted small">${escapeHtml(c.model ?? "")}</td>
      <td>${escapeHtml(c.status ?? "")}</td>
      <td class="num">${fmtInt(c.total_tokens)}</td>
      <td class="num">${fmtUSDsmall(c.cost_usd)}</td></tr>`).join("");
    $("#modal-body").innerHTML = `<p class="muted small modal-sub">${fmtInt(r.count)} calls · ${fmtUSDsmall(r.total_usd)} · 7d</p>
      <div class="scroll"><table class="tbl"><thead><tr><th>When</th><th>Function</th><th>Model</th><th>Status</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch (e) { $("#modal-body").innerHTML = `<p class="panel-state err">Error: ${escapeHtml(e.message)}</p>`; }
}

async function resetQuota(u, btn) {
  const name = u.display_name || "(no display name)";
  const ok = await confirmDialog({
    title: "Reset daily quota?",
    icon: "↺",
    bodyHtml: `
      <p class="confirm-lead">Reset today's AI quota (all features) for <b>${escapeHtml(name)}</b>?</p>
      <div class="confirm-user">
        <span class="confirm-email">${escapeHtml(u.email)}</span>
        <span class="confirm-tier">Current tier: ${tierBadge(u.tier)}</span>
      </div>
      <p class="confirm-note">Their daily AI limits reset to zero for the rest of today.</p>`,
    confirmLabel: "Reset quota",
    variant: "primary",
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    const r = await callFn("reset_quota", { method: "POST", body: { user_id: u.id } });
    const n = r.reset_features?.length ?? 0;
    toast(n ? `Reset ${n} feature${n === 1 ? "" : "s"} for ${u.email}` : `Nothing to reset for ${u.email}`);
    loadActivity();
  } catch (e) { toast(`Failed: ${e.message}`, true); }
  finally { btn.disabled = false; }
}

let USERS_CACHE = [];
async function loadUsers() {
  const state = $("#users-state");
  try {
    const r = await callFn("users");
    USERS_CACHE = r.users;
    renderUsers(USERS_CACHE);
    state.textContent = `${fmtInt(r.count)} users`;
  } catch (e) { sectionErr(state, e); }
}

// Action buttons shared between the (now-removed) inline actions column and
// the expanded per-user detail panel — built fresh each time so `u`/button
// state (disabled while a request is in flight) stays correct per row.
function buildUserActions(u) {
  const wrap = document.createElement("div");
  wrap.className = "row-actions user-detail-actions";
  const proBtn = document.createElement("button");
  proBtn.className = "btn btn-ghost btn-mini";
  proBtn.textContent = u.tier === "pro" ? "Revoke Pro" : "Grant Pro";
  proBtn.onclick = () => setTier(u, u.tier === "pro" ? "free" : "pro", proBtn);
  const delBtn = document.createElement("button");
  delBtn.className = "btn btn-ghost btn-mini";
  delBtn.textContent = u.is_deleted ? "Restore" : "Soft-delete";
  delBtn.onclick = () => setDeleted(u, !u.is_deleted, delBtn);
  const pantryBtn = document.createElement("button");
  pantryBtn.className = "btn btn-ghost btn-mini";
  pantryBtn.textContent = "Pantry";
  pantryBtn.onclick = () => openPantry(u);
  const logBtn = document.createElement("button");
  logBtn.className = "btn btn-ghost btn-mini";
  logBtn.textContent = "Usage";
  logBtn.onclick = () => openUsageLog(u);
  const resetBtn = document.createElement("button");
  resetBtn.className = "btn btn-ghost btn-mini";
  resetBtn.textContent = "Reset quota";
  resetBtn.onclick = () => resetQuota(u, resetBtn);
  wrap.append(proBtn, delBtn, pantryBtn, logBtn, resetBtn);
  return wrap;
}

function detailField(label, value, copyText) {
  const f = document.createElement("div");
  f.className = "user-detail-field";
  const l = document.createElement("span");
  l.className = "mini-label"; l.textContent = label;
  const v = document.createElement("div");
  v.className = "user-detail-value";
  const span = document.createElement("span");
  span.textContent = value;
  span.title = value;
  v.appendChild(span);
  if (copyText) v.appendChild(copyBtn(copyText, label));
  f.append(l, v);
  return f;
}

function buildDetailRow(u, colCount) {
  const tr = document.createElement("tr");
  tr.className = "detail-row hidden";
  const td = document.createElement("td");
  td.colSpan = colCount;
  const box = document.createElement("div");
  box.className = "user-detail";
  const grid = document.createElement("div");
  grid.className = "user-detail-grid";
  grid.append(
    detailField("Email", u.email, u.email),
    detailField("User ID", u.id, u.id),
    detailField("Household", u.household_id || "—", u.household_id || undefined),
    detailField("Signed up", `${fmtFull(u.created_at)}`),
    detailField("Last active", fmtFull(u.last_active_at)),
    detailField("Pantry items", fmtInt(u.item_count)),
    detailField("AI cost · 30d", fmtUSDsmall(u.cost_30d_usd)),
    detailField("Method", u.provider),
  );
  box.appendChild(grid);
  box.appendChild(buildUserActions(u));
  td.appendChild(box);
  tr.appendChild(td);
  return tr;
}

// ── v4: mobile card list for the users panel (same data as renderUsers,
// laid out as tappable cards instead of a horizontally-scrolling table). ────
function userCardFieldsHTML(u) {
  const dSignup = daysSince(u.created_at);
  return `
    <div class="ucf" data-col="signup"><span class="ucf-label">Signup date</span><span class="ucf-val" title="${u.created_at ?? ""}">${fmtDate(u.created_at)}${dSignup != null ? ` · ${dSignup}d` : ""}</span></div>
    <div class="ucf" data-col="active"><span class="ucf-label">Last active</span><span class="ucf-val" title="${u.last_active_at ?? ""}">${relTime(u.last_active_at)}</span></div>
    <div class="ucf" data-col="items"><span class="ucf-label">Items</span><span class="ucf-val">${fmtInt(u.item_count)}</span></div>
    <div class="ucf" data-col="cost"><span class="ucf-label">AI spend · 30d</span><span class="ucf-val">${fmtUSDsmall(u.cost_30d_usd)}</span></div>
    <div class="ucf" data-col="method"><span class="ucf-label">Provider</span><span class="ucf-val">${providerBadge(u.provider)}</span></div>
  `;
}
function renderUserCards(list) {
  const wrap = $("#users-cards");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!list.length) { wrap.innerHTML = `<p class="muted small">No matching users.</p>`; return; }
  for (const u of list) {
    const card = document.createElement("div");
    card.className = "user-card" + (u.is_deleted ? " deleted" : "");
    const proPill = tierBadge(u.tier);
    const relay = u.private_relay ? `<span class="tag-relay" title="Apple Private Relay address">relay</span>` : "";
    card.innerHTML = `
      <div class="user-card-top">
        <div class="user-card-id">
          ${u.display_name ? `<div class="user-card-name">${escapeHtml(u.display_name)}</div>` : ""}
          <div class="user-card-email">
            <span class="user-card-email-text" title="${escapeHtml(u.email)}">${escapeHtml(u.email)}</span>
          </div>
          ${relay}
        </div>
        ${proPill}
      </div>
      <div class="user-card-fields">${userCardFieldsHTML(u)}</div>
      <button type="button" class="user-card-toggle" aria-expanded="false">
        <span class="user-card-toggle-label">Details &amp; actions</span><span class="user-card-toggle-icon">▾</span>
      </button>
      <div class="user-card-detail hidden"></div>`;

    $(".user-card-email", card).appendChild(copyBtn(u.email, "Email"));

    const detail = $(".user-card-detail", card);
    const idGrid = document.createElement("div");
    idGrid.className = "user-detail-grid user-card-detail-grid";
    idGrid.append(
      detailField("User ID", u.id, u.id),
      detailField("Household", u.household_id || "—", u.household_id || undefined),
    );
    detail.appendChild(idGrid);
    detail.appendChild(buildUserActions(u));

    const toggleBtn = $(".user-card-toggle", card);
    toggleBtn.addEventListener("click", () => {
      const willOpen = detail.classList.contains("hidden");
      detail.classList.toggle("hidden", !willOpen);
      toggleBtn.setAttribute("aria-expanded", String(willOpen));
      toggleBtn.classList.toggle("open", willOpen);
      card.classList.toggle("expanded", willOpen);
    });

    wrap.appendChild(card);
  }
}

const USER_COL_COUNT = 8;
function renderUsers(list) {
  const tb = $("#users-tbl tbody");
  tb.innerHTML = "";
  if (!list.length) { tb.innerHTML = `<tr><td colspan="${USER_COL_COUNT}" class="muted small">No matching users.</td></tr>`; renderUserCards(list); return; }
  for (const u of list) {
    const tr = document.createElement("tr");
    tr.className = "row-clickable";
    if (u.is_deleted) tr.classList.add("deleted");
    const proPill = tierBadge(u.tier);
    const relay = u.private_relay ? ` <span class="tag-relay" title="Apple Private Relay address">relay</span>` : "";
    const dSignup = daysSince(u.created_at);

    const userTd = document.createElement("td");
    userTd.className = "col-user sticky-col";
    const primary = document.createElement("div");
    primary.className = "user-primary";
    const textSpan = document.createElement("span");
    textSpan.className = "user-primary-text";
    textSpan.title = u.display_name ? `${u.display_name} · ${u.email}` : u.email;
    textSpan.innerHTML = u.display_name
      ? `<span class="user-name">${escapeHtml(u.display_name)}</span> <span class="muted small">${escapeHtml(u.email)}</span>`
      : escapeHtml(u.email);
    primary.appendChild(textSpan);
    primary.appendChild(copyBtn(u.email, "Email"));
    if (relay) primary.insertAdjacentHTML("beforeend", relay);
    userTd.appendChild(primary);

    tr.innerHTML = `
      <td data-col="method">${providerBadge(u.provider)}</td>
      <td data-col="signup" title="${u.created_at ?? ""}">${fmtDate(u.created_at)}${dSignup != null ? ` <span class="muted small">· ${dSignup}d</span>` : ""}</td>
      <td data-col="active" title="${u.last_active_at ?? ""}">${relTime(u.last_active_at)}</td>
      <td class="num" data-col="items">${fmtInt(u.item_count)}</td>
      <td class="num" data-col="cost">${fmtUSDsmall(u.cost_30d_usd)}</td>
      <td data-col="tier">${proPill}</td>
      <td class="col-expand"><button type="button" class="expand-btn" aria-label="Toggle detail">▸</button></td>`;
    tr.insertBefore(userTd, tr.firstChild);

    const detailTr = buildDetailRow(u, USER_COL_COUNT);
    const toggle = () => {
      const willOpen = detailTr.classList.contains("hidden");
      detailTr.classList.toggle("hidden", !willOpen);
      tr.classList.toggle("expanded", willOpen);
    };
    tr.addEventListener("click", toggle);

    tb.appendChild(tr);
    tb.appendChild(detailTr);
  }
  renderUserCards(list);
}

// ── v3: column show/hide, persisted locally per-browser ─────────────────────
const TOGGLEABLE_COLS = [
  { key: "method", label: "Method" },
  { key: "signup", label: "Signed up" },
  { key: "active", label: "Last active" },
  { key: "items", label: "Items" },
  { key: "cost", label: "AI cost 30d" },
  { key: "tier", label: "Tier" },
];
const COL_PREF_KEY = "jujube_admin_users_hidden_cols";
function loadHiddenCols() {
  try { return new Set(JSON.parse(localStorage.getItem(COL_PREF_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveHiddenCols(set) {
  try { localStorage.setItem(COL_PREF_KEY, JSON.stringify([...set])); } catch { /* private mode etc. */ }
}
function applyHiddenCols(hidden) {
  const tbl = $("#users-tbl");
  const cards = $("#users-cards");
  for (const { key } of TOGGLEABLE_COLS) {
    tbl.classList.toggle(`hide-${key}`, hidden.has(key));
    if (cards) cards.classList.toggle(`hide-${key}`, hidden.has(key));
  }
}
function initColumnToggle() {
  const hidden = loadHiddenCols();
  applyHiddenCols(hidden);
  const menu = $("#col-toggle-menu");
  menu.innerHTML = TOGGLEABLE_COLS.map(({ key, label }) => `
    <label><input type="checkbox" data-col-key="${key}" ${hidden.has(key) ? "" : "checked"} /> ${escapeHtml(label)}</label>
  `).join("");
  $$("input[type=checkbox]", menu).forEach((cb) => {
    cb.addEventListener("change", () => {
      const key = cb.dataset.colKey;
      if (cb.checked) hidden.delete(key); else hidden.add(key);
      applyHiddenCols(hidden);
      saveHiddenCols(hidden);
    });
  });
  $("#col-toggle-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.addEventListener("click", (ev) => {
    if (!menu.classList.contains("hidden") && !menu.contains(ev.target) && ev.target.id !== "col-toggle-btn") {
      menu.classList.add("hidden");
    }
  });
}

async function setTier(u, tier, btn) {
  const grant = tier === "pro";
  const name = u.display_name || "(no display name)";
  const ok = await confirmDialog({
    title: grant ? "Grant Pro?" : "Revoke Pro?",
    icon: grant ? "★" : "⚠",
    bodyHtml: `
      <p class="confirm-lead">${grant ? "Grant Pro to" : "Revoke Pro from"} <b>${escapeHtml(name)}</b>?</p>
      <div class="confirm-user">
        <span class="confirm-email">${escapeHtml(u.email)}</span>
        <span class="confirm-tier">Current tier: ${tierBadge(u.tier)}</span>
      </div>
      <p class="confirm-note">${grant
        ? "They'll be moved to <b>Pro</b> — unlimited AI recipes and Pro features."
        : "They'll return to the <b>Free</b> tier and its daily limits."}</p>`,
    confirmLabel: grant ? "Grant Pro" : "Revoke Pro",
    variant: grant ? "good" : "danger",
  });
  if (!ok) return;
  if (btn) btn.disabled = true;
  try {
    await callFn("set_tier", { method: "POST", body: { user_id: u.id, tier } });
    u.tier = tier;
    renderUsers(filterUsers());
    toast(`${u.email} → ${tier}`);
    loadActivity();
  } catch (e) { toast(`Failed: ${e.message}`, true); if (btn) btn.disabled = false; }
}

async function setDeleted(u, deleted, btn) {
  const name = u.display_name || "(no display name)";
  const ok = await confirmDialog({
    title: deleted ? "Soft-delete user?" : "Restore user?",
    icon: deleted ? "⚠" : "↺",
    bodyHtml: `
      <p class="confirm-lead">${deleted ? "Soft-delete" : "Restore"} <b>${escapeHtml(name)}</b>?</p>
      <div class="confirm-user">
        <span class="confirm-email">${escapeHtml(u.email)}</span>
        <span class="confirm-tier">Current tier: ${tierBadge(u.tier)}</span>
      </div>
      <p class="confirm-note">${deleted
        ? "Reversible — you can restore this account later."
        : "The account will be reactivated."}</p>`,
    confirmLabel: deleted ? "Soft-delete" : "Restore",
    variant: deleted ? "danger" : "primary",
  });
  if (!ok) return;
  if (btn) btn.disabled = true;
  try {
    await callFn("set_deleted", { method: "POST", body: { user_id: u.id, deleted } });
    u.is_deleted = deleted;
    renderUsers(filterUsers());
    toast(`${u.email} ${deleted ? "soft-deleted" : "restored"}`);
    loadActivity();
  } catch (e) { toast(`Failed: ${e.message}`, true); if (btn) btn.disabled = false; }
}

function filterUsers() {
  const q = $("#user-search").value.trim().toLowerCase();
  if (!q) return USERS_CACHE;
  return USERS_CACHE.filter(
    (u) =>
      u.email.toLowerCase().includes(q) ||
      (u.display_name ?? "").toLowerCase().includes(q) ||
      (u.household_id ?? "").toLowerCase().includes(q),
  );
}

function sectionErr(stateEl, e) {
  stateEl.classList.add("err");
  if (e.message === "not_authorized") stateEl.textContent = "Not authorized.";
  else if (/relation|does not exist|schema cache|function/.test(e.detail || e.message || ""))
    stateEl.textContent = "Backend not deployed yet (run migration 20260721050000 + deploy admin-console).";
  else stateEl.textContent = `Error: ${e.message}${e.detail ? " · " + e.detail : ""}`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const V2_LOADERS = [
  loadCostByFunction, loadCostByModel, loadQuotaEvents,
  loadRegeneration, loadSignupSources, loadActivity, loadActiveUsersTrend,
  loadOnboardingFunnel, loadPromoCodes,
];
async function loadDashboard() {
  await Promise.allSettled([
    loadOverview(), loadSignups(), loadCost(), loadTopUsers(), loadUsers(),
    ...V2_LOADERS.map((fn) => fn()),
  ]);
}

// ── auth flow ───────────────────────────────────────────────────────────────
async function boot() {
  // Handle magic-link redirect params, then read session.
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { show("signin"); return; }
  await gateAndShow(session);
}

async function gateAndShow(session) {
  show("loading");
  $("#who").textContent = session.user.email ?? "";
  $("#denied-email").textContent = session.user.email ?? "";
  try {
    // The overview call doubles as the admin gate: 403 => not admin.
    await loadOverview();
    show("dash");
    // Load the rest after showing the shell.
    Promise.allSettled([loadSignups(), loadCost(), loadTopUsers(), loadUsers(), ...V2_LOADERS.map((fn) => fn())]);
  } catch (e) {
    if (e.status === 403 || e.message === "not_authorized") { show("denied"); return; }
    // Backend not deployed / other error: still show the dashboard shell so the
    // admin sees per-section diagnostics instead of a dead page.
    show("dash");
    ["#signups-state", "#cost-state", "#top-users-state", "#users-state",
     "#cbf-state", "#cbm-state", "#quota-state", "#regen-state", "#src-state", "#activity-state",
     "#dau-trend-state", "#funnel-state", "#promo-state"]
      .forEach((s) => sectionErr($(s), e));
    toast(`Backend error: ${e.message}`, true);
  }
}

// ── wire up events ──────────────────────────────────────────────────────────
// Sign-in goes through the admin-login Edge Function, NOT
// supabase.auth.signInWithOtp() directly — that used to email a magic link
// to any address typed into this form. admin-login checks profiles.is_admin
// (service-role only) first and sends no email at all for a non-admin.
$("#signin-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = $("#email").value.trim();
  const btn = $("#signin-btn");
  const msg = $("#signin-msg");
  msg.className = "msg";
  btn.disabled = true; btn.textContent = "Sending…";
  try {
    const res = await fetch(LOGIN_FN_URL, {
      method: "POST",
      headers: { apikey: CFG.PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, redirect_to: window.location.href.split("#")[0] }),
    });
    const payload = await res.json().catch(() => ({}));
    if (res.status === 403) {
      msg.classList.add("err");
      msg.textContent = "Unauthorized — this email is not an admin.";
    } else if (res.status === 429) {
      msg.classList.add("err");
      msg.textContent = "Too many attempts — please wait a few minutes and try again.";
    } else if (!res.ok) {
      msg.classList.add("err");
      msg.textContent = `Error: ${payload.error || `http_${res.status}`}`;
    } else {
      msg.classList.add("ok");
      msg.textContent = "Check your email for the sign-in link.";
    }
  } catch {
    msg.classList.add("err");
    msg.textContent = "Network error — please try again.";
  } finally {
    btn.disabled = false; btn.textContent = "Email me a magic link";
  }
});

$("#signout-btn").addEventListener("click", async () => { await sb.auth.signOut(); show("signin"); });
$("#denied-signout").addEventListener("click", async () => { await sb.auth.signOut(); show("signin"); });
$("#refresh-btn").addEventListener("click", () => { toast("Refreshing…"); loadDashboard(); });
$("#user-search").addEventListener("input", () => renderUsers(filterUsers()));
$("#funnel-apply").addEventListener("click", () => { toast("Loading funnel…"); loadOnboardingFunnel(); });
initColumnToggle();

// Modal close: button, backdrop click, Escape.
$("#modal-close").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (ev) => { if (ev.target === $("#modal")) closeModal(); });
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeModal(); });

// React to sign-in completing via the magic-link redirect. Only re-gate when we
// are not already showing the dashboard, so a token refresh doesn't reload it.
sb.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_IN" && session && $("#view-dash").classList.contains("hidden")) {
    gateAndShow(session);
  }
});

boot();
