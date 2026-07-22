// Jujube admin — client app. Vanilla ES module + supabase-js (publishable key).
// All privileged data flows through the is_admin()-gated `admin-console` edge
// function; the browser only ever holds the user's own magic-link session.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CFG = window.JUJUBE_ADMIN_CONFIG;
const FN_BASE = `${CFG.SUPABASE_URL}/functions/v1/${CFG.FUNCTION_NAME}`;

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
const PROVIDER_LABEL = { apple: "Apple", google: "Google", email: "Email", other: "—" };
function providerBadge(p) {
  const key = PROVIDER_LABEL[p] ? p : "other";
  return `<span class="method method-${key}">${PROVIDER_LABEL[key]}</span>`;
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
  try {
    const r = await callFn("top_users");
    tb.innerHTML = "";
    if (!r.top.length) { state.textContent = "No AI usage in the last 30 days."; return; }
    for (const u of r.top) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td title="${u.user_id}">${escapeHtml(u.email)}</td>
        <td class="num">${fmtInt(u.total_tokens)}</td>
        <td class="num">${fmtInt(u.calls)}</td>`;
      tb.appendChild(tr);
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
  if (!confirm(`Reset today's AI quota (all features) for ${u.email}?`)) return;
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

function renderUsers(list) {
  const tb = $("#users-tbl tbody");
  tb.innerHTML = "";
  if (!list.length) { tb.innerHTML = `<tr><td colspan="8" class="muted small">No matching users.</td></tr>`; return; }
  for (const u of list) {
    const tr = document.createElement("tr");
    if (u.is_deleted) tr.classList.add("deleted");
    const proPill = u.tier === "pro"
      ? `<span class="pill pro">pro</span>` : `<span class="pill free">free</span>`;
    // Display name if set; else email; else the Apple private-relay ids get a tag.
    const relay = u.private_relay ? ` <span class="tag-relay" title="Apple Private Relay address">relay</span>` : "";
    const primary = u.display_name
      ? `${escapeHtml(u.display_name)} <span class="muted small">· ${escapeHtml(u.email)}</span>`
      : escapeHtml(u.email);
    const dSignup = daysSince(u.created_at);
    tr.innerHTML = `
      <td>${primary}${relay}</td>
      <td>${providerBadge(u.provider)}</td>
      <td title="${u.created_at ?? ""}">${fmtDate(u.created_at)}${dSignup != null ? ` <span class="muted small">· ${dSignup}d</span>` : ""}</td>
      <td title="${u.last_active_at ?? ""}">${relTime(u.last_active_at)}</td>
      <td class="num">${fmtInt(u.item_count)}</td>
      <td class="num">${fmtUSDsmall(u.cost_30d_usd)}</td>
      <td>${proPill}</td>
      <td></td>`;
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const proBtn = document.createElement("button");
    proBtn.className = "btn btn-ghost btn-mini";
    proBtn.textContent = u.tier === "pro" ? "Revoke pro" : "Grant pro";
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
    actions.append(proBtn, delBtn, pantryBtn, logBtn, resetBtn);
    tr.lastElementChild.appendChild(actions);
    tb.appendChild(tr);
  }
}

async function setTier(u, tier, btn) {
  if (!confirm(`${tier === "pro" ? "Grant" : "Revoke"} pro for ${u.email}?`)) return;
  btn.disabled = true;
  try {
    await callFn("set_tier", { method: "POST", body: { user_id: u.id, tier } });
    u.tier = tier;
    renderUsers(filterUsers());
    toast(`${u.email} → ${tier}`);
  } catch (e) { toast(`Failed: ${e.message}`, true); btn.disabled = false; }
}

async function setDeleted(u, deleted, btn) {
  if (!confirm(`${deleted ? "Soft-delete" : "Restore"} ${u.email}?`)) return;
  btn.disabled = true;
  try {
    await callFn("set_deleted", { method: "POST", body: { user_id: u.id, deleted } });
    u.is_deleted = deleted;
    renderUsers(filterUsers());
    toast(`${u.email} ${deleted ? "soft-deleted" : "restored"}`);
  } catch (e) { toast(`Failed: ${e.message}`, true); btn.disabled = false; }
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
  loadRegeneration, loadSignupSources, loadActivity,
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
     "#cbf-state", "#cbm-state", "#quota-state", "#regen-state", "#src-state", "#activity-state"]
      .forEach((s) => sectionErr($(s), e));
    toast(`Backend error: ${e.message}`, true);
  }
}

// ── wire up events ──────────────────────────────────────────────────────────
$("#signin-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = $("#email").value.trim();
  const btn = $("#signin-btn");
  const msg = $("#signin-msg");
  msg.className = "msg";
  btn.disabled = true; btn.textContent = "Sending…";
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split("#")[0] },
  });
  btn.disabled = false; btn.textContent = "Email me a magic link";
  if (error) { msg.classList.add("err"); msg.textContent = error.message; }
  else { msg.classList.add("ok"); msg.textContent = "Check your inbox for the sign-in link."; }
});

$("#signout-btn").addEventListener("click", async () => { await sb.auth.signOut(); show("signin"); });
$("#denied-signout").addEventListener("click", async () => { await sb.auth.signOut(); show("signin"); });
$("#refresh-btn").addEventListener("click", () => { toast("Refreshing…"); loadDashboard(); });
$("#user-search").addEventListener("input", () => renderUsers(filterUsers()));

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
