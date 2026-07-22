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
  if (!list.length) { tb.innerHTML = `<tr><td colspan="7" class="muted small">No matching users.</td></tr>`; return; }
  for (const u of list) {
    const tr = document.createElement("tr");
    if (u.is_deleted) tr.classList.add("deleted");
    const proPill = u.tier === "pro"
      ? `<span class="pill pro">pro</span>` : `<span class="pill free">free</span>`;
    tr.innerHTML = `
      <td>${escapeHtml(u.email)}${u.display_name ? ` <span class="muted small">· ${escapeHtml(u.display_name)}</span>` : ""}</td>
      <td>${fmtDate(u.created_at)}</td>
      <td title="${u.last_active_at ?? ""}">${relTime(u.last_active_at)}</td>
      <td class="num">${fmtInt(u.item_count)}</td>
      <td><span class="mono">${u.household_id ? u.household_id.slice(0, 8) : "—"}</span></td>
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
    actions.append(proBtn, delBtn);
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

async function loadDashboard() {
  await Promise.allSettled([loadOverview(), loadSignups(), loadCost(), loadTopUsers(), loadUsers()]);
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
    Promise.allSettled([loadSignups(), loadCost(), loadTopUsers(), loadUsers()]);
  } catch (e) {
    if (e.status === 403 || e.message === "not_authorized") { show("denied"); return; }
    // Backend not deployed / other error: still show the dashboard shell so the
    // admin sees per-section diagnostics instead of a dead page.
    show("dash");
    ["#signups-state", "#cost-state", "#top-users-state", "#users-state"].forEach((s) => sectionErr($(s), e));
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

// React to sign-in completing via the magic-link redirect. Only re-gate when we
// are not already showing the dashboard, so a token refresh doesn't reload it.
sb.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_IN" && session && $("#view-dash").classList.contains("hidden")) {
    gateAndShow(session);
  }
});

boot();
