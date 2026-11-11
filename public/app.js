// SteadPal front end. Plain JS. Talks to the SteadPal server; PayPal buttons load only when keys exist.
const $ = (id) => document.getElementById(id);
const usd = (x) => "$" + Number(x).toLocaleString("en-US", { maximumFractionDigits: 0 });
const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
let S = null;

// ---------- Tabs ----------
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll("main > [data-tab]").forEach((c) => (c.hidden = c.dataset.tab !== name));
  if (name === "analysis" && grid && grid.sizeColumnsToFit) setTimeout(() => grid.sizeColumnsToFit(), 50);
}
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
const POT_NAMES = { tax: "Taxes (estimate)", salaryReserve: "Weekly pay reserve", emergency: "Emergency fund", laptop: "New laptop" };

function render(s, flash = []) {
  S = s;
  $("who").innerHTML = `<b>${s.user.name}</b><br>${s.user.city} · today ${s.user.today}<br>` +
    `<span class="small">${s.paypal.enabled ? "PayPal sandbox connected" : "Demo mode (no PayPal keys)"} · ` +
    `${s.ai.enabled ? "AI: " + s.ai.model : "AI: templates"}</span>`;

  const f = s.forecast;
  $("forecast").classList.toggle("weak", f.weak);
  $("forecastBody").innerHTML = `<div class="range">${usd(f.low)} – ${usd(f.high)}</div>
    <div class="muted">Expected about ${usd(f.expected)} vs your 6-month average of ${usd(f.historyMean)}</div>
    <p class="hint" id="forecastWhy"></p>`;
  api("GET", "/api/forecast").then((r) => ($("forecastWhy").textContent = r.explanation));
  // Weak-month alert: shows the core promise in one line
  const weeksCovered = s.settings.salaryEnabled && s.salary.weekly ? Math.floor(s.pots.salaryReserve / s.salary.weekly) : 0;
  $("weakAlert").hidden = !f.weak;
  if (f.weak) {
    const why = f.signals.map((x) => x.type === "contract_ended" ? `${x.payer}'s retainer ended` : `${x.payer} is ${x.daysLate} days late`).join(" and ");
    $("weakAlert").innerHTML = `<b>Heads up: next month may be low.</b> ${why ? why.charAt(0).toUpperCase() + why.slice(1) + ". " : ""}` +
      (s.settings.salaryEnabled ? `Your ${usd(s.salary.weekly)} weekly pay is protected: your reserve covers ${weeksCovered} week${weeksCovered === 1 ? "" : "s"}.` : "Turn on weekly pay to smooth it out.");
  }

  const goalsByPot = Object.fromEntries(s.goals.map((g) => [g.id, g]));
  const ORDER = ["emergency", "tax", "salaryReserve"];
  const potList = Object.entries(s.pots).sort((x, y) => (ORDER.indexOf(x[0]) + 1 || 99) - (ORDER.indexOf(y[0]) + 1 || 99));
  $("pots").innerHTML = potList.map(([k, v]) => {
    const g = goalsByPot[k];
    const pct = g ? Math.min(100, Math.round((v / g.target) * 100)) : null;
    const name = POT_NAMES[k] || (g ? g.name : k);
    return `<div class="pot ${flash.includes(k) ? "flash" : ""}"><div class="name">${name}</div>
      <div class="val">${usd(v)}</div>
      ${g ? `<div class="bar"><i style="width:${pct}%"></i></div><div class="muted small">${pct}% of ${usd(g.target)} · by ${g.deadline || "—"}</div>` : ""}
      ${k === "emergency" && pyusdRate ? `<div class="pyusd small" title="PYUSD rewards are variable, US only, and PYUSD is not FDIC-insured. Opt-in.">Opt in to hold it in PYUSD: about ${usd(v * pyusdRate)}/year at ${(pyusdRate * 100).toFixed(0)}%</div>` : ""}</div>`;
  }).join("");

  $("invoices").innerHTML = s.openInvoices.length
    ? s.openInvoices.map((i) => `<div class="invoice">${i.payerName} invoice ${i.id}: ${usd(i.amount)}, due ${i.dueDate}` +
        `${i.daysLate > 0 ? ` <b>(${i.daysLate} days late)</b>` : ""}` +
        `<div class="row">${i.remindedOn ? `<span class="pill ok">Reminder sent ${i.remindedOn}</span>` : `<button class="btn ghost small-btn" data-remind="${i.id}">✨ Draft a reminder</button>`}</div></div>`).join("")
    : `<div class="muted small">No open invoices.</div>`;
  $("simPay").style.display = s.openInvoices.length && !s.paypal.enabled ? "" : "none";

  $("salaryToggle").checked = s.settings.salaryEnabled;
  $("salaryBody").innerHTML = s.settings.salaryEnabled
    ? `<div class="range">${usd(s.salary.weekly)}<span class="muted small"> / week</span></div>
       <div class="muted small">From your own reserve. Covers your ${usd(s.settings.fixedMonthlyExpenses)} monthly expenses and leaves about ${usd(s.salary.surplusForGoals)}/month for goals.</div>`
    : `<p class="muted small">Off. You manage your own pay. Turn it on to get a steady weekly amount from your reserve.</p>`;
  $("paySalary").style.display = s.settings.salaryEnabled ? "" : "none";

  $("offers").innerHTML = s.offers.map((o) => `<div class="offer"><span>${o.merchant}</span><b>${Math.round(o.rate * 100)}%</b></div>`).join("");
  $("passportToggle").checked = s.settings.passportEnabled;
  $("ppBtn").disabled = !s.settings.passportEnabled;

  document.querySelectorAll("[data-remind]").forEach((b) => (b.onclick = () => draftReminder(b.dataset.remind)));
  if (!s.openInvoices.length) $("nudge").hidden = true;
  renderGrid(s.transactions);
  renderTax(s);
  renderProfile(s);

  $("activity").innerHTML = s.activity.length
    ? s.activity.map((a) => `<li><span class="kind">${a.kind}</span>${a.text}</li>`).join("")
    : `<li class="muted">Nothing yet. Try the late payment.</li>`;
}

let pyusdRate = 0.04; // updated from /api/rates

// ---------- 1. Payday pop-up ----------
let toastTimer;
function toast(title, lines = []) {
  const t = $("toast");
  t.innerHTML = `<div class="toast-title">${title}</div>` + lines.map(([k, v]) => `<div class="toast-line"><span>${k}</span><b>${v}</b></div>`).join("");
  t.hidden = false; t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("show"); setTimeout(() => (t.hidden = true), 400); }, 6000);
}
$("toast") && ($("toast").onclick = () => ($("toast").hidden = true));
function paydayToast(amount, alloc, from) {
  const lines = Object.entries(alloc || {}).filter(([, v]) => v > 0)
    .map(([k, v]) => [POT_NAMES[k] || (S.goals.find((g) => g.id === k) || {}).name || (k === "unassigned" ? "Free to spend" : k), "+" + usd(v)]);
  toast(`💸 Payday! ${usd(amount)} from ${from}`, lines);
}

function cashbackToast(r) {
  const goal = (r.state.goals.find((g) => g.id === r.route.goal) || {}).name || r.route.goal;
  const lines = [["Cashback → " + goal, "+$" + r.route.amount.toFixed(2)]];
  if (r.roundUp) lines.push(["Round-up → " + goal, "+$" + r.roundUp.toFixed(2)]);
  toast(`🎁 +$${(r.route.amount + (r.roundUp || 0)).toFixed(2)} to your future`, lines);
}

// ---------- 2. Late-invoice reminder ----------
let nudgeId = null;
async function draftReminder(id) {
  nudgeId = id;
  $("nudge").hidden = false;
  $("nudgeHead").textContent = "Drafting a polite reminder…";
  $("nudgeText").value = "";
  const r = await api("POST", "/api/invoice/reminder", { id });
  $("nudgeHead").textContent = `${r.ai ? "Drafted by AI" : "Draft"} · to ${r.invoice.clientName} · edit before sending`;
  $("nudgeText").value = r.text;
  return r;
}
$("nudgeSend").onclick = async () => {
  const r = await api("POST", "/api/invoice/remind", { id: nudgeId, text: $("nudgeText").value });
  $("nudge").hidden = true;
  toast("📨 Reminder sent", [["Invoice", nudgeId], ["Sent via", r.via === "paypal" ? "PayPal Invoicing" : "Demo"]].concat(r.paypalInvoiceId ? [["PayPal invoice", r.paypalInvoiceId]] : []));
  if (r.warning) $("payHint").textContent = r.warning;
  render(r.state);
};
$("nudgeCancel").onclick = () => ($("nudge").hidden = true);

// ---------- 4. Transactions table (AG Grid, with a plain-table fallback) ----------
let grid = null;
function renderGrid(rows) {
  const el = $("txGrid");
  const data = [...rows].sort((a, b) => b.date.localeCompare(a.date));
  if (window.agGrid && agGrid.createGrid) {
    if (grid) { grid.setGridOption("rowData", data); return; }
    el.style.height = "340px";
    grid = agGrid.createGrid(el, {
      rowData: data,
      columnDefs: [
        { field: "date", headerName: "Date", sort: "desc", width: 120 },
        { field: "client", headerName: "Client", flex: 1, minWidth: 130 },
        { field: "amount", headerName: "Amount", type: "rightAligned", width: 120, valueFormatter: (p) => usd(p.value) },
        { field: "channel", headerName: "Channel", width: 110 },
        { field: "type", headerName: "Type", width: 140, valueFormatter: (p) => String(p.value).replace("_", " ") },
        { field: "passport", headerName: "Counts for passport", width: 170, cellRenderer: (p) => (p.value ? "✅ Yes" : "— No") },
      ],
      defaultColDef: { sortable: true, filter: true, resizable: true },
      pagination: true, paginationPageSize: 10, paginationPageSizeSelector: [10, 20, 50],
      animateRows: true,
    });
  } else {
    el.style.height = "auto";
    el.innerHTML = `<table class="tx"><tr><th>Date</th><th>Client</th><th>Amount</th><th>Channel</th><th>Passport</th></tr>` +
      data.map((t) => `<tr><td>${t.date}</td><td>${t.client}</td><td>${usd(t.amount)}</td><td>${t.channel}</td><td>${t.passport ? "✅" : "—"}</td></tr>`).join("") + `</table>`;
  }
}

async function refresh(flash) { render(await api("GET", "/api/state"), flash); }
const flashFrom = (alloc) => Object.keys(alloc || {}).filter((k) => k !== "unassigned");

// ---------- actions ----------
$("simPay").onclick = async () => {
  const r = await api("POST", "/api/demo/payment", { amount: 1600, payer: "northwind" });
  $("payHint").textContent = r.explanation;
  render(r.state, flashFrom(r.plan.alloc));
  paydayToast(1600, r.plan.alloc, "Northwind Ltd");
};
// Channel3: real products, cashback into the pot that needs it most
async function buyProduct(id) {
  const r = await api("POST", "/api/shop/buy", { productId: id });
  $("shopSource").textContent = r.explanation;
  render(r.state, [r.route.goal]);
  cashbackToast(r);
  return r;
}
$("shopBtn").onclick = async () => {
  $("shopResults").innerHTML = `<p class="muted small">Searching…</p>`;
  try {
    const r = await api("POST", "/api/shop/search", { query: $("shopQuery").value });
    $("shopSource").textContent = r.source === "channel3"
      ? `Real products from Channel3. Cashback shown is an estimated ${Math.round(r.rate * 100)}% share of the store commission.`
      : `Demo products (Channel3 not connected). Cashback is an estimated ${Math.round(r.rate * 100)}%.`;
    $("shopResults").innerHTML = r.products.map((p) => `<div class="product">
        ${p.image ? `<img src="${p.image}" alt="">` : `<div class="noimg"></div>`}
        <div class="info"><div class="title" title="${p.title}">${p.title}</div>
        <div class="muted">${usd(p.price)} · ${p.merchant || p.brand}</div>
        <div class="cb">+${"$" + p.cashback.toFixed(2)} to your pots</div></div>
        <div class="pp" id="pp-${p.id}"><button class="btn ghost" data-buy="${p.id}">Buy</button></div></div>`).join("");
    document.querySelectorAll("[data-buy]").forEach((b) => {
      const p = r.products.find((x) => x.id === b.dataset.buy);
      if (S.paypal.enabled && window.paypal) {
        b.remove();
        mountButton(`#pp-${CSS.escape(p.id)}`, { amount: p.price, description: p.title.slice(0, 120), kind: "shop", productId: p.id });
      } else b.onclick = () => buyProduct(p.id);
    });
    return r;
  } catch (e) { $("shopResults").innerHTML = `<p class="muted small">${e.message}</p>`; }
};

$("simShop").onclick = async () => {
  const r = await api("POST", "/api/cashback", { merchant: "InkLine Store", amount: 120 });
  render(r.state, [r.route.goal]);
};
$("paySalary").onclick = async () => {
  try { const r = await api("POST", "/api/salary/pay"); render(r.state, ["salaryReserve"]); }
  catch (e) { alert(e.message); }
};
$("salaryToggle").onchange = async (e) => render(await api("POST", "/api/settings", { salaryEnabled: e.target.checked }));
$("passportToggle").onchange = async (e) => render(await api("POST", "/api/settings", { passportEnabled: e.target.checked }));
// ---------- New goal: I want $X by DATE for PURPOSE ----------
(() => { const d = new Date(); d.setMonth(d.getMonth() + 18); $("gDate").value = d.toISOString().slice(0, 10); })();
async function planGoal(save) {
  try {
    const r = await api("POST", "/api/goal/plan", { amount: Number($("gAmount").value), deadline: $("gDate").value, purpose: $("gPurpose").value, priority: $("gPriority").value, save });
    $("goalOut").innerHTML = `<span class="pill ${r.feasible ? "ok" : "warn"}">${r.feasible ? "Fits your budget" : "Tight"}</span> ${r.explanation}${r.saved ? " <b>Saved.</b>" : ""}`;
    if (r.saved) render(r.state, [r.state.goals.at(-1).id]);
  } catch (e) { $("goalOut").textContent = e.message; }
}
$("gCheck").onclick = () => planGoal(false);
$("gSave").onclick = () => planGoal(true);

// ---------- What if: spend / earn / invest at official rates ----------
let RATES = null;
api("GET", "/api/rates").then((r) => {
  RATES = r;
  const py = r.options.find((o) => o.id === "pyusd"); if (py) { pyusdRate = py.rate; if (S) render(S); }
  $("wiOption").innerHTML = r.options.map((o) => `<option value="${o.id}" ${o.id === "tbill" ? "selected" : ""}>${o.name} · ${(o.rate * 100).toFixed(2)}%</option>`).join("");
});
$("wiBtn").onclick = async () => {
  const r = await api("POST", "/api/whatif/plan", {
    spend: $("wiPrice").value, earn: $("wiEarn").value, invest: $("wiInvest").value, option: $("wiOption").value, months: $("wiMonths").value,
  });
  $("wiResult").innerHTML = `<div class="mini">
    <div><span>Free each month</span><b>${usd(r.freePerMonth)}</b></div>
    <div><span>After ${r.months} months</span><b>${usd(r.futureValue)}</b></div>
    <div><span>Interest</span><b>${usd(r.interestEarned)}</b></div>
    <div><span>Emergency fund in</span><b>${r.emergencyMonthsAfter} mo</b></div></div>`;
  $("wiOut").textContent = r.explanation;
  $("wiSource").innerHTML = r.sourceUrl ? `Rate: ${r.source}, as of ${r.asOf} (<a href="${r.sourceUrl}" target="_blank">source</a>). Illustration only, not advice.` : "Illustration only, not advice.";
  return r;
};

// ---------- Report + AI consultant ----------
const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
const table = (heads, rows) => `<table class="tx"><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;
const mini = (pairs) => `<div class="mini">${pairs.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>`;
$("repType").onchange = () => ($("repPeriod").disabled = ["taxes", "goals"].includes($("repType").value));
$("reportBtn").onclick = async () => {
  const r = await api("POST", "/api/reports", { type: $("repType").value, months: Number($("repPeriod").value) });
  let stats = "", tbl = "";
  if (r.type === "income") {
    stats = mini([["Income", usd(r.totalIncome)], ["Per month", usd(r.monthlyAverage)], ["Via PayPal", pct(r.payPalShare)], ["Top client", r.topClient ? `${r.topClient.name} ${pct(r.topClient.share)}` : "—"]]);
    tbl = r.months > 1 ? table(["", "Month", "Income"], [["Best", r.best.month, usd(r.best.amount)], ["Weakest", r.worst.month, usd(r.worst.amount)]]) : "";
  } else if (r.type === "clients") {
    stats = mini([["Income", usd(r.total)], ["Clients", r.rows.length], ["Biggest client", r.concentration ? pct(r.concentration.share) : "—"], ["Overdue now", usd(r.rows.reduce((a, x) => a + x.overdueNow, 0))]]);
    tbl = table(["Client", "Paid", "Share", "Avg days late", "On time", "Overdue", "PayPal"], r.rows.map((x) => [x.client, usd(x.paid), pct(x.share),
      x.avgDaysLate == null ? "—" : `<span class="pill ${x.avgDaysLate > 7 ? "warn" : "ok"}">${x.avgDaysLate} day${x.avgDaysLate === 1 ? "" : "s"}</span>`, pct(x.onTimeShare), x.overdueNow ? usd(x.overdueNow) : "—", x.viaPayPal ? "✅" : "—"]));
  } else if (r.type === "cashflow") {
    stats = mini([["Came in", usd(r.totalIn)], ["Left for goals", usd(r.totalNet)], ["Short months", r.negativeMonths]]);
    tbl = table(["Month", "Income", "Taxes", r.payLabel === "weekly pay" ? "Weekly pay" : "Expenses", "Left"], r.rows.map((x) => [x.month, usd(x.income), usd(x.taxes), usd(x.pay), `<b class="${x.net < 0 ? "neg" : "pos"}">${usd(x.net)}</b>`]));
  } else if (r.type === "taxes") {
    stats = r.enabled ? mini([["Set aside", usd(r.setAside)], ["Next due", r.nextDueDate || "—"], ["Paid this year", usd(r.paidYtd)], ["Not covered yet", usd(Math.max(0, r.gap))]]) : "";
    tbl = r.payments.length ? table(["Date", "Payment", "Note"], r.payments.map((x) => [x.date, usd(x.amount), x.note || ""])) : "";
  } else if (r.type === "goals") {
    tbl = table(["Goal", "Saved", "Target", "Progress", "Needed / month", "By"], r.goals.map((g) => [g.name, usd(g.saved), usd(g.target), pct(g.progress), usd(g.neededPerMonth), g.deadline]));
  }
  $("repStats").innerHTML = stats; $("repTable").innerHTML = tbl;
  $("reportOut").textContent = r.explanation;
  return r;
};
$("askBtn").onclick = async () => {
  const q = $("askText").value.trim();
  if (!q) return;
  $("askOut").textContent = "Thinking…";
  const r = await api("POST", "/api/consultant", { question: q });
  $("askOut").textContent = r.answer;
};

// ---------- Runway risk check ----------
function fanChart(band, start) {
  const W = 560, H = 180, P = 34;
  const pts = [{ month: 0, p10: start, p50: start, p90: start }, ...band];
  const max = Math.max(...pts.map((p) => p.p90)) * 1.05, min = Math.min(0, ...pts.map((p) => p.p10));
  const x = (m) => P + (m / (pts.length - 1)) * (W - P - 10), y = (v) => H - 22 - ((v - min) / (max - min)) * (H - 34);
  const line = (k) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.month).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
  const area = pts.map((p, i) => `${i ? "L" : "M"}${x(p.month)},${y(p.p90)}`).join("") + [...pts].reverse().map((p) => `L${x(p.month)},${y(p.p10)}`).join("") + "Z";
  return `<svg viewBox="0 0 ${W} ${H}" class="fan" role="img" aria-label="Reserve range over time">
    <line x1="${P}" x2="${W - 10}" y1="${y(0)}" y2="${y(0)}" class="zero"/><text x="2" y="${y(0) + 4}" class="ax">$0</text>
    <path d="${area}" class="band"/><path d="${line("p50")}" class="mid"/>
    ${pts.map((p) => `<text x="${x(p.month)}" y="${H - 6}" class="ax" text-anchor="middle">${p.month ? "M" + p.month : "now"}</text>`).join("")}
    <text x="${x(pts.length - 1) - 4}" y="${y(pts.at(-1).p50) - 6}" class="lbl" text-anchor="end">typical ${usd(pts.at(-1).p50)}</text>
    <text x="${x(pts.length - 1) - 4}" y="${y(pts.at(-1).p10) + 14}" class="lbl" text-anchor="end">bad case ${usd(pts.at(-1).p10)}</text></svg>`;
}
$("rwBtn").onclick = async () => {
  const r = await api("POST", "/api/runway", { months: Number($("rwMonths").value) });
  const p = Math.round(r.probSafe * 100);
  $("rwOut").innerHTML = `<div class="rw"><div class="gauge ${p >= 90 ? "ok" : p >= 75 ? "mid" : "bad"}"><b>${p}%</b><span>safe</span></div>
    <div>${mini([["Weekly pay", r.weekly ? usd(r.weekly) : "off"], ["Reserve today", usd(r.startingBuffer)], ["Typical in " + r.months + " mo", usd(r.medianEnd)], ["Bad case (1 in 10)", usd(r.badCaseEnd)]])}
    ${r.safeWeeklyAt95 != null && r.weekly ? `<div class="small muted">Highest weekly pay that stays 95% safe: <b>${usd(r.safeWeeklyAt95)}</b></div>` : ""}</div></div>${fanChart(r.band, r.startingBuffer)}`;
  $("rwText").textContent = r.explanation;
  $("rwMethod").textContent = "How: " + r.method + " Shaded area = 8 in 10 futures. Not a guarantee.";
  return r;
};

// ---------- Save & invest: education + forecasts ----------
$("ivBtn").onclick = async () => {
  const r = await api("POST", "/api/invest", { monthly: $("ivMonthly").value, months: $("ivMonths").value, includeEmergency: $("ivStart").checked });
  const best = Math.max(...r.options.map((o) => o.interest)) || 1;
  $("ivOut").innerHTML = r.options.map((o) => `<details class="iv"><summary>
      <span class="iv-name">${o.name}</span><span class="iv-rate">${(o.rate * 100).toFixed(2)}%</span>
      <span class="iv-bar" title="interest earned"><i style="width:${Math.max(2, Math.round((o.interest / best) * 100))}%"></i></span><b>+${usd(o.interest)}</b><span class="muted small">${usd(o.endValue)}</span></summary>
      <div class="small"><p>${o.what}</p><p><b>Protection:</b> ${o.insured}<br><b>Access:</b> ${o.access}<br><b>Risk:</b> ${o.risk}</p>
      <p class="muted">${o.url ? `Rate: ${o.source}, as of ${o.asOf} (<a href="${o.url}" target="_blank">source</a>).` : o.source} Projection assumes today's rate for ${r.months} months.</p></div></details>`).join("") +
    `<p class="muted small">You'd put in ${usd(r.start + r.monthly * r.months)}. Tap an option to learn how it works. Education only; rates change.</p>`;
  return r;
};

// ---------- Taxes (optional) ----------
function renderTax(s) {
  const t = s.tax;
  if (!t.enabled) { $("taxBody").innerHTML = `<p class="muted small">Off. SteadPal is not setting money aside for taxes. You can turn it on in <a href="#" onclick="showTab('profile');return false">Profile</a>.</p>`; return; }
  const soon = t.daysToDue != null && t.daysToDue <= 30;
  $("taxBody").innerHTML = mini([["Set aside", usd(t.setAside)], ["Next due", t.nextDueDate ? `${t.nextDueDate}` : "—"], ["Days left", t.daysToDue ?? "—"], ["Rate", Math.round(t.rate * 100) + "%"]]) +
    `<p class="small ${soon ? "warnText" : "muted"}">${t.profile.businessType || "Your business"} · ${t.profile.entity || ""} · ${t.profile.state || ""}</p>
    <div class="row"><button class="btn small-btn" data-tax="paid">I paid it: empty the pot</button>
    <button class="btn ghost small-btn" data-tax="partial">I paid part</button>
    <button class="btn ghost small-btn" data-tax="move">Move some to emergency</button>
    <button class="btn link small-btn" data-tax="keep">Keep it</button></div>
    <p class="muted small">These are estimates, not tax advice. You may already have paid tax elsewhere (for example withholding from a job) or received income SteadPal can't see, so check with a tax professional before paying.</p>`;
  document.querySelectorAll("[data-tax]").forEach((b) => (b.onclick = async () => {
    let amount = 0;
    if (b.dataset.tax === "partial" || b.dataset.tax === "move") {
      const v = prompt(`How much? (up to ${usd(S.tax.setAside)})`, "");
      if (v == null) return;
      amount = Number(v);
    }
    const r = await api("POST", "/api/tax/action", { action: b.dataset.tax, amount });
    render(r, ["tax", "emergency"]);
  }));
}

// ---------- Profile: business, taxes, round-ups ----------
let profileLoaded = false;
function renderProfile(s) {
  $("ruEnabled").checked = Boolean(s.settings.roundUps?.enabled);
  $("ruStep").value = String(s.settings.roundUps?.step || 5);
  if (profileLoaded) return; // don't overwrite what the user is typing
  const tp = s.settings.taxProfile || {};
  $("tpEnabled").checked = tp.enabled !== false;
  $("tpBusiness").value = tp.businessType || ""; $("tpEntity").value = tp.entity || "Sole proprietor"; $("tpState").value = tp.state || "";
  $("tpFed").value = +((tp.federalRate ?? 0.2) * 100).toFixed(1); $("tpStateRate").value = +((tp.stateRate ?? 0) * 100).toFixed(1);
  $("tpDates").value = (tp.dueDates || []).join(", ");
  profileLoaded = true;
}
$("tpSave").onclick = async () => {
  const r = await api("POST", "/api/tax/profile", {
    enabled: $("tpEnabled").checked, businessType: $("tpBusiness").value, entity: $("tpEntity").value, state: $("tpState").value,
    federalRate: Number($("tpFed").value) / 100, stateRate: Number($("tpStateRate").value) / 100,
    dueDates: $("tpDates").value.split(/[,\s]+/).filter(Boolean),
  });
  render(r);
  $("tpMsg").textContent = `Saved. Tax set-aside: ${r.settings.taxProfile.enabled ? Math.round(r.settings.taxRate * 100) + "% of each payment" : "off"}.`;
};
$("tpEnabled").onchange = () => $("tpSave").onclick();
const saveRoundUps = async () => {
  const r = await api("POST", "/api/roundups", { enabled: $("ruEnabled").checked, step: Number($("ruStep").value) });
  render(r);
  $("ruOut").textContent = r.settings.roundUps.enabled ? `On: a $118.40 purchase adds $${(Math.ceil(118.4 / r.settings.roundUps.step) * r.settings.roundUps.step - 118.4).toFixed(2)} to your goals.` : "Off.";
};
$("ruEnabled").onchange = saveRoundUps; $("ruStep").onchange = saveRoundUps;

$("ppBtn").onclick = async () => {
  try {
    const r = await api("POST", "/api/passport", { months: Number($("ppMonths").value), threshold: 2500 });
    const s = r.summary;
    const left = r.excluded.length ? `<p class="muted small">Not counted (private to you): ${r.excluded.map((x) => `${usd(x.amount)} on ${x.date}, ${x.why}`).join("; ")}.</p>` : "";
    $("ppOut").innerHTML = `<div class="passport">
      <div class="pp-head"><img src="/logo.svg" alt="" width="36"><div><b>Income Passport</b><div class="muted small">${s.period}</div></div>
      <div class="pp-code">Code <span class="code">${r.code}</span></div></div>
      <div class="mini"><div><span>Monthly average</span><b>${usd(s.monthlyAverage)}</b></div><div><span>Lowest</span><b>${usd(s.min)}</b></div>
      <div><span>Highest</span><b>${usd(s.max)}</b></div><div><span>Verified clients</span><b>${s.distinctVerifiedPayers}</b></div></div>
      <div class="row"><a class="btn" href="${r.certificateUrl}" target="_blank">Open certificate (PDF)</a>
      <a class="btn ghost" href="${r.verifyUrl}" target="_blank">Verification page</a></div>
      <p class="muted small">${s.monthsAboveThreshold} · expires in 30 days</p>${left}</div>`;
    refresh();
  } catch (e) { $("ppOut").textContent = e.message; }
};
$("reset").onclick = async () => { $("nudge").hidden = true; profileLoaded = false; ["rwOut", "rwText", "rwMethod", "ivOut", "repTable", "ruOut", "tpMsg"].forEach((id) => ($(id).innerHTML = "")); render(await api("POST", "/api/reset")); ["payHint", "goalOut", "wiOut", "wiResult", "wiSource", "reportOut", "repStats", "askOut", "ppOut"].forEach((id) => ($(id).textContent = "")); };

// ---------- Guided demo: the 5 moments in order, for the video ----------
const cardOf = (id) => $(id).closest(".card");
function spot(id, caption) {
  document.querySelectorAll(".card.spot").forEach((c) => c.classList.remove("spot"));
  const c = cardOf(id);
  showTab(c.dataset.tab || "home");
  c.classList.add("spot");
  c.scrollIntoView({ behavior: "smooth", block: "center" });
  $("guideCaption").textContent = caption;
}
const STEPS = [
  async () => {
    await $("reset").onclick();
    showTab("home");
    window.scrollTo({ top: 0, behavior: "smooth" });
    document.querySelectorAll(".card.spot").forEach((c) => c.classList.remove("spot"));
    $("guideCaption").textContent = "Meet Ana: freelance designer in Los Angeles. $3,500 in March, $800 in April. Rent is still $1,500.";
  },
  async () => {
    if (S.openInvoices.length) await draftReminder(S.openInvoices[0].id);
    spot("forecastBody", "SteadPal reads her PayPal history: a retainer ended and an invoice is 21 days late. It warns her before the weak month, and the AI drafts a polite reminder to the client.");
  },
  async () => {
    if (S.paypal.enabled) {
      spot("payButtons", "The client pays the overdue invoice with PayPal. Pay with the sandbox buyer account to see the AI split it.");
    } else {
      await $("simPay").onclick();
      spot("pots", "The late $1,600 arrives through PayPal. The AI splits it: taxes, weekly pay reserve, emergency fund, and the code checks every dollar.");
    }
  },
  async () => {
    $("shopQuery").value = "drawing stylus";
    if (!S.settings.roundUps?.enabled) render(await api("POST", "/api/roundups", { enabled: true, step: 5 }));
    const r = await $("shopBtn").onclick();
    if (S.paypal.enabled || !r || !r.products.length) {
      spot("shopResults", "Ana searches real products through Channel3 and pays with PayPal. Each one shows the cashback it would add to her pots.");
    } else {
      await buyProduct(r.products[0].id);
      spot("pots", "She buys with PayPal. The cashback and the round-up (optional) don't go to the wallet: they go to the goal most behind, her emergency fund.");
    }
  },
  async () => {
    $("wiPrice").value = 1400; $("wiEarn").value = 0; $("wiInvest").value = 100; $("wiMonths").value = 12;
    if ([...$("wiOption").options].some((o) => o.value === "tbill")) $("wiOption").value = "tbill";
    await $("wiBtn").onclick();
    spot("wiOut", "A $1,400 laptop? And what if she puts $100 a month aside at the current Treasury bill rate? The simulator shows both, with the official source.");
  },
  async () => {
    $("rwMonths").value = "6";
    const r = await $("rwBtn").onclick();
    spot("rwOut", `Is her weekly pay safe? SteadPal runs 1,000 possible futures from her own history: ${Math.round(r.probSafe * 100)} in 100 keep her pay covered for 6 months. The AI explains; the math decides.`);
  },
  async () => {
    $("ppMonths").value = "6";
    await $("ppBtn").onclick();
    spot("ppOut", "A landlord asks for proof of income. Ana shares a signed passport with facts from PayPal and a code anyone can verify.");
  },
  async () => {
    $("repType").value = "clients"; $("repPeriod").value = "6";
    const r = await $("reportBtn").onclick();
    const top = r.rows[0];
    spot("repStats", `Reports: ${top.client} brings ${Math.round(top.share * 100)}% of her income${top.avgDaysLate ? ` and pays about ${top.avgDaysLate} days late` : ""}. Every payment is in the table below, with what counts for the passport.`);
  },
];
document.querySelectorAll(".step").forEach((b) => {
  b.onclick = async () => {
    const i = Number(b.dataset.step);
    document.querySelectorAll(".step").forEach((x) => {
      x.classList.toggle("active", x === b);
      x.classList.toggle("done", Number(x.dataset.step) < i);
    });
    try { await STEPS[i](); } catch (e) { $("guideCaption").textContent = "Something went wrong: " + e.message; }
  };
});

// ---------- PayPal buttons (sandbox), only when keys are configured ----------
function loadPayPal(clientId) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD`;
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
function mountButton(el, { amount, description, kind, payer, merchant, productId }) {
  window.paypal.Buttons({
    style: { layout: "horizontal", height: kind === "shop" ? 30 : 40, tagline: false },
    createOrder: async () => (await api("POST", "/api/paypal/order", { amount, description })).id,
    onApprove: async (d) => {
      const r = await api("POST", "/api/paypal/capture", { orderId: d.orderID, amount, kind, payer, merchant, productId });
      if (kind === "shop") { $("shopSource").textContent = r.explanation; render(r.state, [r.route.goal]); cashbackToast(r); }
      else if (kind === "purchase") { render(r.state, [r.route.goal]); cashbackToast(r); }
      else { $("payHint").textContent = r.explanation; render(r.state, flashFrom(r.plan.alloc)); paydayToast(r.plan.amount || amount, r.plan.alloc, "Northwind Ltd"); }
    },
    onError: (e) => alert("PayPal error: " + e),
  }).render(el);
}

(async () => {
  await refresh();
  showTab("home");
  if (S.paypal.enabled && S.paypal.clientId) {
    try {
      await loadPayPal(S.paypal.clientId);
      $("simShop").style.display = "none";
      $("payHint").textContent = "Client view: pay the overdue $1,600 invoice with a sandbox buyer account.";
      mountButton("#payButtons", { amount: 1600, description: "Northwind Ltd invoice INV-0412", kind: "payment", payer: "northwind" });
      mountButton("#shopButtons", { amount: 120, description: "InkLine Store stylus", kind: "purchase", merchant: "InkLine Store" });
    } catch { $("payHint").textContent = "PayPal could not load; demo buttons still work."; $("simPay").style.display = ""; }
  }
})();
