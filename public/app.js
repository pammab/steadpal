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

// ---------- Sources behind every fact ("i" buttons) ----------
const SOURCES = {
  freelancers: { text: "64 million Americans (38% of the U.S. workforce) did freelance work in 2023.", src: "Upwork, Freelance Forward 2023", url: "https://www.upwork.com/research/freelance-forward-2023-research-report" },
  shed: { text: "63% of U.S. adults would cover a $400 emergency expense with cash or its equivalent (survey fielded Oct 2025).", src: "Federal Reserve, Economic Well-Being of U.S. Households in 2025", url: "https://www.federalreserve.gov/publications/2026-economic-well-being-of-us-households-in-2025-executive-summary.htm" },
  emergency: { text: "The CFPB suggests having at least three months of living expenses saved for emergencies, and six to nine months if possible.", src: "Consumer Financial Protection Bureau", url: "https://www.consumerfinance.gov/consumer-tools/money-as-you-grow/teen-young-adult/explore-saving/" },
  incomeDips: { text: "Research cited by the CFPB finds the median expense spike or income dip is about three weeks of income, and a typical family has more than one a year.", src: "CFPB, Emergency Savings and Financial Security (2022)", url: "https://files.consumerfinance.gov/f/documents/cfpb_mem_emergency-savings-financial-security_report_2022-3.pdf" },
  seTax: { text: "The self-employment tax rate is 15.3%: 12.4% for Social Security and 2.9% for Medicare.", src: "IRS, Publication 334 (2025)", url: "https://www.irs.gov/publications/p334" },
  taxDates: { text: "2026 estimated tax payments are due April 15, June 15 and September 15, 2026, and January 15, 2027.", src: "Fidelity Learning Center", url: "https://www.fidelity.com/learning-center/personal-finance/taxes-small-business" },
  fdic: { text: "FDIC insurance covers $250,000 per depositor, per FDIC-insured bank, for each account ownership category.", src: "FDIC, Understanding Deposit Insurance", url: "https://www.fdic.gov/resources/deposit-insurance/understanding-deposit-insurance" },
  pyusd: { text: "PYUSD rewards are variable, for eligible U.S. users who opt in. PYUSD is not FDIC-insured.", src: "PayPal, PYUSD Rewards", url: "https://www.paypal.com/us/cshelp/article/what-are-pyusd-rewards-help1247" },
};
SOURCES.why = { html: `<div class="why"><b>Why SteadPal?</b>
  <ol type="A">
    <li>Proves your PayPal income with a <b>signed income passport</b>.</li>
    <li>Better financial organization:
      <ol>
        <li>Splits every PayPal payment into pots: taxes, income reserve, emergency fund, goals.</li>
        <li>Pays you a steady income from your own reserve.</li>
        <li>Analysis tools: forecasts, reports, what-if and a runway check.</li>
      </ol></li>
    <li>AI consultant, partner cashback and more.</li>
  </ol>
  <div class="muted small">Your money never leaves PayPal. Turn it off anytime.</div></div>` };
const i = (key) => `<button type="button" class="i" data-src="${key}" aria-label="Source">i</button>`;
document.addEventListener("click", (e) => {
  const b = e.target.closest(".i");
  const pop = $("srcPop");
  if (!b) { if (!e.target.closest("#srcPop")) pop.hidden = true; return; }
  const sdef = SOURCES[b.dataset.src]; if (!sdef) return;
  pop.innerHTML = sdef.html || `<div>${sdef.text}</div><a href="${sdef.url}" target="_blank" rel="noopener">${sdef.src} ↗</a>`;
  pop.classList.toggle("wide", Boolean(sdef.html));
  const r = b.getBoundingClientRect();
  pop.hidden = false;
  pop.style.top = window.scrollY + r.bottom + 6 + "px";
  pop.style.left = Math.max(8, Math.min(window.scrollX + r.left - 20, window.scrollX + document.documentElement.clientWidth - 300)) + "px";
});

// ---------- Tabs ----------
let currentTab = "home";
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll("main > [data-tab]").forEach((c) => (c.hidden = c.dataset.tab !== name));
  currentTab = name;
  if (name === "home" && grid && grid.sizeColumnsToFit) setTimeout(() => grid.sizeColumnsToFit(), 50);
}
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
const POT_NAMES = { available: "Available to spend", tax: "Taxes (estimate)", salaryReserve: "Income reserve", emergency: "Emergency fund", laptop: "New laptop" };

function render(s, flash = []) {
  S = s;
  $("who").innerHTML = `<b>${s.user.name}</b><br>${s.user.city} · today ${s.user.today}<br>` +
    `<span class="small">${s.paypal.enabled ? "PayPal sandbox connected" : "Demo mode (no PayPal keys)"} · ` +
    `${s.ai.enabled ? "AI: " + s.ai.model : "AI: templates"}</span>`;

  const f = s.forecast;
  $("forecast").classList.toggle("weak", f.weak);
  const ex = (s.settings.excludedMonths || []).length;
  $("forecastBody").innerHTML = `<div class="range"><a class="ev" data-ev="range">${usd(f.low)} – ${usd(f.high)}</a></div>
    <div class="muted">Expected about <a class="ev" data-ev="expected">${usd(f.expected)}</a> vs your <a class="ev" data-ev="average">${ex ? 6 - ex : 6}-month average of ${usd(f.historyMean)}</a>${ex ? ` <span class="pill">${ex} unusual month${ex > 1 ? "s" : ""} left out</span>` : ""}</div>
    <p class="hint" id="forecastWhy"></p>`;
  document.querySelectorAll("#forecastBody .ev").forEach((a) => (a.onclick = () => showEvidence(a.dataset.ev)));
  api("GET", "/api/forecast").then((r) => ($("forecastWhy").textContent = r.explanation));
  // Weak-month alert: shows the core promise in one line
  const weeksCovered = s.settings.salaryEnabled && s.salary.weekly ? Math.floor((s.pots.salaryReserve || 0) / s.salary.weekly) : 0;
  $("weakAlert").hidden = !f.weak;
  if (f.weak) {
    const why = f.signals.map((x) => x.type === "contract_ended" ? `${x.payer}'s retainer ended` : `${x.payer} is ${x.daysLate} days late`).join(" and ");
    $("weakAlert").innerHTML = `<b>Heads up: next month may be low.</b> ${why ? why.charAt(0).toUpperCase() + why.slice(1) + ". " : ""}` +
      (s.settings.salaryEnabled ? `Your ${usd(s.period.amount)} ${s.period.title.toLowerCase()} is protected: your reserve (<a class="ev" data-ev="reserve">${usd(s.pots.salaryReserve || 0)}</a>) covers ${weeksCovered} week${weeksCovered === 1 ? "" : "s"}.` : "Turn on weekly pay to smooth it out.") +
      ` <span class="muted small">Income dips are common: ${i("incomeDips")}</span>`;
    document.querySelectorAll("#weakAlert .ev").forEach((a) => (a.onclick = () => { showTab("home"); $("pots").scrollIntoView({ behavior: "smooth", block: "center" }); }));
  }

  const goalsByPot = Object.fromEntries(s.goals.map((g) => [g.id, g]));
  const ORDER = ["emergency", "tax", "salaryReserve"];
  const potList = Object.entries(s.pots).sort((x, y) => (ORDER.indexOf(x[0]) + 1 || 99) - (ORDER.indexOf(y[0]) + 1 || 99));
  $("pots").innerHTML = potList.map(([k, v]) => {
    const g = goalsByPot[k];
    const pct = g ? Math.min(100, Math.round((v / g.target) * 100)) : null;
    const name = g ? g.name : POT_NAMES[k] || k;
    const reserveTarget = k === "salaryReserve" && s.settings.salaryEnabled ? s.salary.weekly * (s.settings.reserveWeeks || 4) : null;
    return `<div class="pot ${flash.includes(k) ? "flash" : ""}" id="pot-${k}"><div class="name">${name}</div>
      <div class="val">${usd(v)}</div>
      ${g ? `<div class="bar"><i style="width:${pct}%"></i></div><div class="muted small">${pct}% of ${usd(g.target)} · by ${g.deadline || "—"}</div>` : ""}
      ${k === "salaryReserve" && !s.settings.salaryEnabled ? `<div class="pill">Paused</div>` : ""}
      ${reserveTarget ? `<div class="bar"><i style="width:${Math.min(100, Math.round((v / reserveTarget) * 100))}%"></i></div><div class="muted small">target ${usd(reserveTarget)} = ${s.settings.reserveWeeks || 4} weeks of income</div>` : ""}
      ${k === "tax" ? `<div class="muted small">${s.tax.enabled ? Math.round(s.tax.rate * 100) + "% of each payment" : "off"}</div>` : ""}
      ${k === "emergency" ? `<div class="muted small">Common guide: 3+ months of expenses ${i("emergency")}</div>` : ""}
      ${k === "emergency" && pyusdRate ? `<div class="pyusd small">Opt in to hold it in PYUSD: about ${usd(v * pyusdRate)}/year at ${(pyusdRate * 100).toFixed(0)}% ${i("pyusd")}</div>` : ""}</div>`;
  }).join("");
  if (!$("potManager").hidden) renderPotManager(potManagerKey);
  if (!s.wallet.enabled) $("pots").innerHTML = `<div class="w-off">SteadPal is off: payments go straight to your balance (${usd(s.wallet.available)} available). <button class="btn small-btn" id="potsOn">Turn SteadPal on</button></div>`;
  if ($("potsOn")) $("potsOn").onclick = () => openSetup();

  $("invoices").innerHTML = s.openInvoices.length
    ? s.openInvoices.map((i) => `<div class="invoice">${i.payerName} invoice ${i.id}: ${usd(i.amount)}, due ${i.dueDate}` +
        `${i.daysLate > 0 ? ` <b>(${i.daysLate} days late)</b>` : ""}` +
        `<div class="row">${i.remindedOn ? `<span class="pill ok">Reminder sent ${i.remindedOn}</span>` : `<button class="btn ghost small-btn" data-remind="${i.id}">✨ Draft a reminder</button>`}</div></div>`).join("")
    : `<div class="muted small">No open invoices.</div>`;
  $("simPay").style.display = s.openInvoices.length && !s.paypal.enabled ? "" : "none";

  $("salaryToggle").checked = s.settings.salaryEnabled;
  const P = s.period;
  $("incTitle").textContent = P.title;
  $("salaryBody").innerHTML = s.settings.salaryEnabled
    ? `<div class="range">${usd(P.amount)}<span class="muted small"> / ${P.label}</span></div>
       <div class="small"><span class="pill ${P.mode === "automatic" ? "ok" : ""}">${P.mode === "automatic" ? `Automatic · next payday ${P.next}` : "Manual · you send it when you want"}</span></div>
       <div class="muted small">From your own reserve. ${s.salary.userChosen ? `You chose this amount (suggested: ${usd(Math.round((s.salary.suggested * 52) / P.perYear / 5) * 5)}).` : `Suggested from your history.`} Change amount, frequency or mode in Profile.
       Covers your ${usd(s.settings.fixedMonthlyExpenses)} monthly expenses and leaves about ${usd(Math.max(0, s.salary.surplusForGoals))}/month for goals.</div>
       ${s.salary.surplusForGoals < 0 ? `<div class="note">This pays out more than you earn on average after taxes, so the reserve may shrink over time.</div>` : ""}
       <div class="muted small fact">Why it matters: only 63% of U.S. adults could cover a $400 surprise expense with cash ${i("shed")}</div>`
    : `<p class="muted small">Paused. You manage your own pay; your reserve keeps its ${usd(s.pots.salaryReserve || 0)}. Turn it on to get a steady income from your reserve.</p>`;
  $("paySalary").textContent = P.mode === "automatic" ? "Run payday now (demo)" : payButtonText(P);
  $("paySalary").style.display = s.settings.salaryEnabled ? "" : "none";

  $("offers").innerHTML = s.offers.map((o) => `<div class="offer"><span>${o.merchant}</span><b>${Math.round(o.rate * 100)}%</b></div>`).join("");
  $("passportToggle").checked = s.settings.passportEnabled;
  $("ppBtn").disabled = !s.settings.passportEnabled;

  document.querySelectorAll("[data-remind]").forEach((b) => (b.onclick = () => draftReminder(b.dataset.remind)));
  if (!s.openInvoices.length) $("nudge").hidden = true;
  renderGrid(s.transactions);
  renderTax(s);
  renderProfile(s);
  renderWallet(s);
  renderPrefs(s);

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
        { field: "channel", headerName: "Channel", width: 130 },
        { field: "type", headerName: "Type", width: 140, valueFormatter: (p) => String(p.value).replace("_", " ") },
        { field: "passport", headerName: "Counts for passport", width: 170, cellRenderer: (p) => (p.value ? "✅ Yes" : "— No") },
      ],
      defaultColDef: { sortable: true, filter: true, resizable: true },
      pagination: true, paginationPageSize: 10, paginationPageSizeSelector: [10, 20, 50],
      animateRows: true,
    });
    if ($("txSearch").value) grid.setGridOption("quickFilterText", $("txSearch").value);
  } else {
    el.style.height = "auto";
    const q = $("txSearch").value.trim().toLowerCase();
    const shown = q ? data.filter((t) => Object.values(t).join(" ").toLowerCase().includes(q) || usd(t.amount).toLowerCase().includes(q)) : data;
    const limit = el.dataset.all ? shown.length : 12;
    el.innerHTML = `<table class="tx"><tr><th>Date</th><th>Client</th><th>Amount</th><th>Channel</th><th>Passport</th></tr>` +
      shown.slice(0, limit).map((t) => `<tr><td>${t.date}</td><td>${t.client}</td><td>${usd(t.amount)}</td><td>${t.channel}</td><td>${t.passport ? "✅" : "—"}</td></tr>`).join("") + `</table>` +
      (shown.length > limit ? `<button class="btn link small-btn" id="txMore">Show all ${shown.length} payments</button>` : "");
    if ($("txMore")) $("txMore").onclick = () => { el.dataset.all = "1"; renderGrid(S.transactions); };
  }
}

function filterTx(q) {
  $("txSearch").value = q;
  if (grid) grid.setGridOption("quickFilterText", q); else if (S) renderGrid(S.transactions);
}
$("txSearch").oninput = () => filterTx($("txSearch").value);
$("txClear").onclick = () => filterTx("");

// ---------- Pots: edit or delete (Taxes is locked) ----------
// One "Edit pots" button: pick a pot, then edit, duplicate or delete it. Taxes follows Profile.
let potManagerKey = null;
$("potEditBtn").onclick = () => {
  const m = $("potManager");
  m.hidden = !m.hidden;
  if (!m.hidden) renderPotManager(potManagerKey || Object.keys(S.pots).find((k) => k !== "tax"));
};
function renderPotManager(k) {
  const m = $("potManager");
  const keys = Object.keys(S.pots);
  if (!keys.includes(k)) k = keys.find((x) => x !== "tax");
  potManagerKey = k;
  const nameOf = (x) => (S.goals.find((g) => g.id === x) || {}).name || POT_NAMES[x] || x;
  const g = S.goals.find((x) => x.id === k);
  let form = "";
  if (!k) form = `<p class="small muted">No pots yet. Create one with New pot.</p>`;
  else if (k === "salaryReserve") form = `<label class="small">Keep <input type="number" id="pe-weeks" min="1" max="12" value="${S.settings.reserveWeeks || 4}"> weeks of income ready</label> <span class="small muted">This pot can be paused, not deleted.</span>`;
  else form = `<div class="pm-grid"><label class="small">Name <input id="pe-name" value="${g.name}" maxlength="40"></label>
      <label class="small">Target <span class="money"><b>$</b><input id="pe-target" type="number" min="1" value="${g.target}"></span></label>
      <label class="small">By <input id="pe-date" type="date" value="${g.deadline}"></label>
      <label class="small">Priority <select id="pe-pri"><option value="1">High</option><option value="2">Normal</option><option value="3">Low</option></select></label></div>
      ${k === "emergency" ? `<div class="chips">${emergencyChips()}</div>` : ""}`;
  m.innerHTML = `<div class="row"><label class="small"><b>Pot</b> <select id="pm-pick">${keys.map((x) => `<option value="${x}" ${x === k ? "selected" : ""} ${x === "tax" ? "disabled" : ""}>${nameOf(x)}${x === "tax" ? " (follows your tax settings in Profile)" : ""}</option>`).join("")}</select></label>
      <button class="btn link small-btn" id="pm-close">Close</button></div>
    ${form}
    <div class="row">${k ? `<button class="btn small-btn" id="pe-save">Save</button>` : ""}
      ${g ? `<button class="btn ghost small-btn" id="pe-dup">Duplicate</button>` : ""}
      ${k === "salaryReserve" ? `<button class="btn ghost small-btn" id="pe-pause">${S.settings.salaryEnabled ? "Pause steady income" : "Resume steady income"}</button>` : k ? `<button class="btn link small-btn" id="pe-del">Delete pot</button>` : ""}
      <button class="btn ghost small-btn" id="pe-new">+ New pot</button></div>`;
  if (g) m.querySelector("#pe-pri").value = String(g.priority || 2);
  m.querySelectorAll("[data-fill]").forEach((c) => (c.onclick = () => (m.querySelector("#pe-target").value = c.dataset.fill)));
  $("pm-pick").onchange = (e) => renderPotManager(e.target.value);
  $("pm-close").onclick = () => (m.hidden = true);
  $("pe-new").onclick = () => { $("gPurpose").focus(); $("gPurpose").closest(".card").scrollIntoView({ behavior: "smooth", block: "center" }); };
  if ($("pe-save")) $("pe-save").onclick = async () => {
    const body = k === "salaryReserve" ? { id: k, reserveWeeks: m.querySelector("#pe-weeks").value }
      : { id: k, name: m.querySelector("#pe-name").value, target: m.querySelector("#pe-target").value, deadline: m.querySelector("#pe-date").value, priority: m.querySelector("#pe-pri").value };
    try { render(await api("POST", "/api/pots/update", body), [k]); profileLoaded = false; prefsLoaded = false; renderProfile(S); } catch (e) { alert(e.message); }
  };
  if ($("pe-pause")) $("pe-pause").onclick = async () => { render(await api("POST", "/api/settings", { salaryEnabled: !S.settings.salaryEnabled }), ["salaryReserve"]); };
  if ($("pe-dup")) $("pe-dup").onclick = async () => { const r = await api("POST", "/api/pots/duplicate", { id: k }); potManagerKey = r.newId; render(r.state, [r.newId]); };
  if ($("pe-del")) $("pe-del").onclick = async () => {
    const note = k === "emergency" ? "SteadPal uses this pot first in weak months. " : "";
    if (!confirm(`${note}Delete "${nameOf(k)}"? Its ${usd(S.pots[k] || 0)} stays in your PayPal balance.`)) return;
    potManagerKey = null; render(await api("POST", "/api/pots/delete", { id: k }));
  };
}
// Quick-fill suggestions for the emergency fund: the user still decides.
function emergencyChips() {
  const g = S.suggestions;
  return [[`Suggested for your income: ${usd(g.emergencyAmount)} (${g.emergencyMonths} months)`, g.emergencyAmount], [`3 months of rent: ${usd(g.rentTimes3)}`, g.rentTimes3],
    [`3 months of expenses: ${usd(g.expensesTimes3)}`, g.expensesTimes3], [`6 months of expenses: ${usd(g.expensesTimes6)}`, g.expensesTimes6]]
    .map(([t, v]) => `<button type="button" class="chip" data-fill="${v}">${t}</button>`).join("");
}

// ---------- Evidence behind the "Next month" numbers ----------
async function showEvidence(which) {
  const e = await api("GET", "/api/evidence/forecast");
  const box = $("evidence");
  const rows = e.rows.map((r) => `<tr class="${r.used ? "" : "off"}"><td><a class="ev" data-month="${r.month}">${r.month}</a></td><td>${usd(r.total)}</td>
    <td class="small">${r.payments.map((p) => `${p.client} ${usd(p.amount)}${p.paypal ? "" : " (outside PayPal)"}`).join(", ") || "—"}</td>
    <td><label class="small"><input type="checkbox" data-incl="${r.month}" ${r.used ? "checked" : ""}> count it</label></td></tr>`).join("");
  const focus = { range: "the range", expected: "the expected amount", average: "your average" }[which] || "these numbers";
  box.innerHTML = `<div class="ev-head"><b>The data behind ${focus}</b><button class="btn link small-btn" id="evClose">Close</button></div>
    <table class="tx"><tr><th>Month</th><th>Income</th><th>Payments</th><th>In your average?</th></tr>${rows}</table>
    <p class="small">Average of the ${e.usedMonths} counted months: <b>${usd(e.average)}</b>. Other (non-retainer) income per counted month: ${e.irregular.map(usd).join(", ")}.
    Active retainers: ${usd(e.recurring)}. Overdue invoices: ${usd(e.overdue)}.</p>
    <p class="small muted">${e.method}</p>
    <p class="small">Untick a month that was unusual (a one-off project, a holiday) and everything recalculates: forecast, income suggestion, runway check. Tap a month to see its payments on Home.</p>`;
  box.hidden = false;
  $("evClose").onclick = () => (box.hidden = true);
  box.querySelectorAll("[data-month]").forEach((a) => (a.onclick = () => { showTab("home"); filterTx(a.dataset.month); $("txGrid").scrollIntoView({ behavior: "smooth", block: "center" }); }));
  box.querySelectorAll("[data-incl]").forEach((c) => (c.onchange = async () => {
    const excluded = [...box.querySelectorAll("[data-incl]")].filter((x) => !x.checked).map((x) => x.dataset.incl);
    if (excluded.length >= 6) { c.checked = true; return; }
    render(await api("POST", "/api/settings", { excludedMonths: excluded }));
    showEvidence(which);
  }));
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- Preferences: dropdowns with suggested options and "Custom" ----------
function prefFields(s) {
  const sg = s.suggestions, rate = s.tax.enabled ? Math.round(s.tax.rate * 100) : 0;
  const eg = s.goals.find((g) => g.id === "emergency");
  const keep = Math.round(((s.settings.allocation || {}).keepAvailablePct || 0) * 100);
  return [
    { key: "taxRate", label: "Set aside for taxes", unit: "%", value: rate, options: [["0", "Don't set money aside"], ["15", "15%"], ["20", "20%"], ["25", "25% (common for freelancers)"], ["30", "30%"]], hint: `Self-employment tax alone is 15.3% ${i("seTax")}` },
    { key: "payAmount", label: "Steady income from your reserve (per payday)", unit: "$", value: !s.wallet.enabled ? "suggested" : !s.settings.salaryEnabled ? "off" : s.salary.userChosen ? s.period.amount : "suggested",
      options: [["off", "Paused: I manage my own pay"], ["suggested", `Suggested: ${usd(Math.round((sg.weeklyPay * 52) / s.period.perYear / 5) * 5)} per ${s.period.label}`]], hint: "Suggested from your income history." },
    { key: "payFrequency", label: "How often", unit: "days", value: s.settings.payFrequency === "custom" ? (s.settings.payEveryDays || 10) : s.settings.payFrequency || "weekly",
      options: [["weekly", "Weekly (Fridays)"], ["biweekly", "Every 2 weeks"], ["semimonthly", "Twice a month (15th and last day)"], ["monthly", "Monthly (1st)"]], customLabel: "Every … days" },
    { key: "payMode", label: "How it reaches your Wallet", value: s.settings.payMode || "manual", options: [["manual", "Manual: I tap Send (default)"], ["automatic", "Automatic on each payday"]], noCustom: true },
    { key: "reserveWeeks", label: "Keep this much income ready", unit: "weeks", value: s.settings.reserveWeeks || 4, options: [["2", "2 weeks"], ["4", "4 weeks (common)"], ["6", "6 weeks"], ["8", "8 weeks"]] },
    { key: "emergencyTarget", label: "Emergency fund target", unit: "$", value: eg ? eg.target : "none",
      options: [[String(sg.emergencyAmount), `Suggested for your income: ${usd(sg.emergencyAmount)}`], [String(sg.rentTimes3), `3 months of rent: ${usd(sg.rentTimes3)}`], [String(sg.expensesTimes3), `3 months of expenses: ${usd(sg.expensesTimes3)}`], [String(sg.expensesTimes6), `6 months of expenses: ${usd(sg.expensesTimes6)}`], ["none", "No emergency pot"]], hint: `Common guide: 3+ months of expenses ${i("emergency")}` },
    { key: "keepAvailablePct", label: "Keep available to spend from every payment", unit: "%", value: keep, options: [["0", "Nothing extra"], ["10", "10%"], ["20", "20%"], ["30", "30%"]] },
    { key: "leftover", label: "When every goal got its share, the extra goes to", value: (s.settings.allocation || {}).leftover || "available", options: [["available", "Available to spend"], ["emergency", "Emergency fund"], ["goals", "My top-priority goal"]], noCustom: true },
  ];
}
function buildPrefs(box, s) {
  box.innerHTML = `<div class="form2 prefs">${prefFields(s).map((f) => {
    const vals = f.options.map((o) => o[0]);
    const isCustom = !f.noCustom && !vals.includes(String(f.value));
    return `<label>${f.label}<select data-pref="${f.key}">${f.options.map(([v, t]) => `<option value="${v}" ${String(f.value) === v ? "selected" : ""}>${t}</option>`).join("")}${f.noCustom ? "" : `<option value="custom" ${isCustom ? "selected" : ""}>${f.customLabel || "Custom…"}</option>`}</select>
      ${f.noCustom ? "" : `<span class="custom" ${isCustom ? "" : "hidden"}><input type="number" min="0" data-custom="${f.key}" value="${isCustom ? f.value : ""}" placeholder="your number"> ${f.unit}</span>`}
      ${f.hint ? `<span class="sugg">${f.hint}</span>` : ""}</label>`;
  }).join("")}</div>`;
  box.querySelectorAll("select[data-pref]").forEach((sel) => (sel.onchange = () => { const c = box.querySelector(`[data-custom="${sel.dataset.pref}"]`); if (c) c.parentElement.hidden = sel.value !== "custom"; }));
}
function readPrefs(box) {
  const out = {};
  box.querySelectorAll("select[data-pref]").forEach((sel) => {
    const k = sel.dataset.pref;
    let v = sel.value === "custom" ? box.querySelector(`[data-custom="${k}"]`).value : sel.value;
    if (k === "taxRate" || k === "keepAvailablePct") v = Number(v) / 100;
    if (k === "payFrequency" && sel.value === "custom") { out.payFrequency = "custom"; out.payEveryDays = v; return; }
    if (k === "payAmount") { if (v === "off") out.weeklyPay = "off"; else if (v === "suggested") out.weeklyPay = "suggested"; else out.payAmount = v; return; }
    out[k] = v;
  });
  return out;
}
let prefsLoaded = false;
function renderPrefs(s) { if (prefsLoaded) return; buildPrefs($("prefForm"), s); prefsLoaded = true; }
$("prefSave").onclick = async () => {
  const r = await api("POST", "/api/steadpal/setup", readPrefs($("prefForm")));
  prefsLoaded = false; profileLoaded = false; render(r);
  $("prefMsg").textContent = "Saved. New payments will be split this way.";
};

// ---------- Wallet view (concept) + on/off + first-time setup ----------
const W_COLORS = { available: "#9fb3d1", tax: "#f0a531", salaryReserve: "#2470e6", emergency: "#2bb673" };
function renderWallet(s) {
  const w = s.wallet;
  $("spEnabled").checked = w.enabled;
  $("wOff").hidden = w.enabled;
  const parts = [["available", w.available]].concat(w.enabled ? Object.entries(s.pots).filter(([, v]) => v > 0) : []);
  const total = parts.reduce((a, [, v]) => a + v, 0) || 1;
  const nameOf = (k) => (s.goals.find((g) => g.id === k) || {}).name || POT_NAMES[k] || k;
  const color = (k, idx) => W_COLORS[k] || ["#8e7cf0", "#e46a9b", "#36b3c2", "#b0882e"][idx % 4];
  $("wTotal").innerHTML = `${usd(w.available + (w.enabled ? w.inPots : 0))}<span class="muted small"> USD · one balance</span>`;
  $("wBar").innerHTML = parts.map(([k, v], idx) => `<i style="width:${(v / total) * 100}%;background:${color(k, idx)}" title="${nameOf(k)}"></i>`).join("");
  $("wList").innerHTML = parts.map(([k, v], idx) => `<div class="w-row"><span><i style="background:${color(k, idx)}"></i>${nameOf(k)}${k === "available" ? "" : ' <span class="muted small">label</span>'}</span><b>${usd(v)}</b></div>`).join("");
  const last = s.activity.find((a) => a.kind === "payment" && a.alloc);
  const split = last ? Object.entries(last.alloc).map(([k, v]) => `${usd(v)} ${nameOf(k).toLowerCase()}`).join(" · ") : "$400 taxes · $900 income reserve · $300 emergency fund";
  $("wFlow").innerHTML = [
    ["1", "A client pays", `${last ? usd(last.amount) : "$1,600"} lands in your PayPal balance, as usual.`],
    ["2", "SteadPal labels it", w.enabled ? `${split}. Same balance, just labelled.` : "Off: nothing is labelled. The whole payment is available."],
    ["3", "Payday", w.enabled && s.settings.salaryEnabled ? `${s.period.mode === "automatic" ? `Automatically on ${s.period.next}` : `"${payButtonText(s.period)}"`} moves ${usd(s.period.amount)} from the reserve label to Available to spend.` : "Steady income is paused; you spend from Available as usual."],
    ["4", "Spend as usual", "Pay with PayPal, use the PayPal debit card, or transfer to your bank."],
  ].map(([n, t, d]) => `<div class="w-step"><b>${n}</b><div><div class="w-st">${t}</div><div class="small muted">${d}</div></div></div>`).join("");
}
function goalRow() {
  const d = new Date(S.user.today); d.setMonth(d.getMonth() + 6);
  const row = document.createElement("div");
  row.className = "sentence su-goal";
  row.innerHTML = `I want <span class="money"><b>$</b><input type="number" min="1" placeholder="1,200" data-g="target"></span> by <input type="date" value="${d.toISOString().slice(0, 10)}" data-g="deadline"> for <input placeholder="a new laptop" data-g="name"> <button type="button" class="btn link small-btn" title="Remove">×</button>`;
  row.querySelector("button").onclick = () => { row.remove(); $("suAddGoal").disabled = false; };
  $("suGoals").appendChild(row);
  $("suAddGoal").disabled = $("suGoals").children.length >= 5;
}
$("suAddGoal").onclick = () => goalRow();
function openSetup() {
  buildPrefs($("setupForm"), S);
  $("suGoals").innerHTML = ""; goalRow(); $("suAddGoal").disabled = false;
  const sn = S.potsSnapshot;
  $("suRestore").innerHTML = sn && sn.total > 0 ? `<label class="restore"><input type="checkbox" id="suRestoreChk" checked> <span><b>Restore my last pots</b> (${usd(sn.total)} as of ${sn.date}: ${Object.entries(sn.pots).filter(([, v]) => v > 0).map(([k, v]) => `${(S.goals.find((g) => g.id === k) || {}).name || POT_NAMES[k] || k} ${usd(v)}`).join(", ")}). Money moves back from Available to spend, as far as it allows.</span></label>` : "";
  $("setup").hidden = false;
}
$("spEnabled").onchange = async (e) => {
  if (e.target.checked) { openSetup(); e.target.checked = false; return; }
  e.target.checked = true;
  const p = S.pots, risks = [];
  if (S.tax.enabled) risks.push(`<b>Taxes:</b> ${p.tax ? `${usd(p.tax)} set aside for taxes becomes spending money, and n` : "N"}othing new is set aside for taxes. Estimated payments are still due${S.tax.nextDueDate ? ` (next: ${S.tax.nextDueDate})` : ""}.`);
  if (S.settings.salaryEnabled) risks.push(`<b>Steady income stops:</b> no more ${usd(S.period.amount)} every ${S.period.label}. In a weak month there is no reserve smoothing your income.`);
  if (p.emergency) risks.push(`<b>Emergency cushion:</b> ${usd(p.emergency)} is no longer kept apart, so it is easy to spend by accident.`);
  risks.push(`<b>Payments are no longer split:</b> cashback and round-ups go to your balance instead of your goals.`);
  if (S.forecast.weak) risks.push(`<b>Timing:</b> SteadPal expects a weak month ahead.`);
  $("offRisks").innerHTML = risks.map((r) => `<li>${r}</li>`).join("");
  $("offSheet").hidden = false;
};
$("offCancel").onclick = () => ($("offSheet").hidden = true);
$("offConfirm").onclick = async () => {
  $("offSheet").hidden = true;
  render(await api("POST", "/api/steadpal/toggle", { enabled: false }));
  toast("SteadPal is off", [["Pot values saved", "you can restore them"]]);
};
$("suCancel").onclick = () => { $("setup").hidden = true; renderWallet(S); };
$("suSave").onclick = async () => {
  const body = { ...readPrefs($("setupForm")), finish: true };
  body.goals = [...document.querySelectorAll("#suGoals .su-goal")].map((r) => ({ target: r.querySelector('[data-g="target"]').value, deadline: r.querySelector('[data-g="deadline"]').value, name: r.querySelector('[data-g="name"]').value })).filter((g) => g.name && g.target);
  if ($("suRestoreChk") && $("suRestoreChk").checked) body.restore = true;
  const r = await api("POST", "/api/steadpal/setup", body);
  $("setup").hidden = true; prefsLoaded = false; profileLoaded = false; render(r);
  toast("✅ SteadPal is on", [["Taxes", r.tax.enabled ? Math.round(r.tax.rate * 100) + "%" : "off"], ["Steady income", r.settings.salaryEnabled ? `${usd(r.period.amount)} / ${r.period.label}` : "paused"], ["Emergency target", r.goals.find((g) => g.id === "emergency") ? usd(r.goals.find((g) => g.id === "emergency").target) : "none"]]);
};
$("wSetup").onclick = openSetup;
$("wHome").onclick = () => showTab("home");

function payButtonText(P) {
  return P.freq === "weekly" ? "Send this week's income to my Wallet" : P.freq === "monthly" ? "Send this month's income to my Wallet" : "Send this payday's income to my Wallet";
}

async function refresh(flash) { render(await api("GET", "/api/state"), flash); }
const flashFrom = (alloc) => Object.keys(alloc || {}).filter((k) => k !== "unassigned");

// ---------- actions ----------
$("simPay").onclick = async () => {
  const r = await api("POST", "/api/demo/payment", { amount: 1600, payer: "northwind" });
  $("payHint").textContent = r.explanation;
  render(r.state, flashFrom(r.plan.alloc));
  if (r.plan.off) toast("💸 $1,600 from Northwind Ltd", [["Available to spend", "+$1,600"]]); else paydayToast(1600, r.plan.alloc, "Northwind Ltd");
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
  try { const r = await api("POST", "/api/salary/pay"); render(r.state, ["salaryReserve"]); toast(`💵 ${usd(r.paid)} sent to your Wallet`, [["From", "Income reserve"], ["To", "Available to spend"]]); }
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

// ---------- Rates (official sources, refreshed on the user's schedule) ----------
let RATES = null;
function showRates(r) {
  RATES = r;
  const py = r.options.find((o) => o.id === "pyusd"); if (py) { pyusdRate = py.rate; if (S) render(S); }
  const tb = r.options.find((o) => o.id === "tbill");
  $("ratesInfo").textContent = `Treasury bill ${(tb.rate * 100).toFixed(2)}% as of ${tb.asOf}` + (r.lastRefresh ? ` · last checked ${r.lastRefresh}` : "");
  if (r.auto) $("ratesAuto").value = r.auto;
}
api("GET", "/api/rates").then(showRates);
$("ratesAuto").onchange = async () => { await api("POST", "/api/settings", { ratesAuto: $("ratesAuto").value }); };
$("ratesNow").onclick = async () => {
  $("ratesInfo").textContent = "Checking official sources…";
  const r = await api("POST", "/api/rates/refresh");
  showRates({ options: r.options, lastRefresh: r.lastRefresh, auto: $("ratesAuto").value });
  const res = r.result;
  $("ratesInfo").textContent += res.updated.length ? ` · updated: ${res.updated.join("; ")}` : " · could not reach FRED, kept the saved rates";
  if ($("ivOut").innerHTML) $("ivBtn").onclick();
};

// ---------- What if: one decision, its effect on your month ----------
$("wiBtn").onclick = async () => {
  const r = await api("POST", "/api/whatif/plan", { spend: $("wiPrice").value, earn: $("wiEarn").value, costs: $("wiCosts").value });
  const mo = (x) => (x == null ? "not reachable" : x === 0 ? "done" : `${x} mo`);
  $("wiResult").innerHTML = `<div class="mini">
    <div><span>Free each month</span><b>${usd(r.freeAfter)}</b><small>${r.freeChange ? (r.freeChange > 0 ? "+" : "−") + usd(Math.abs(r.freeChange)) : "no change"}</small></div>
    <div><span>${r.emergencyName} ready in</span><b>${mo(r.emergencyMonthsAfter)}</b><small>now ${mo(r.emergencyMonthsNow)}</small></div>
    <div><span>Your income covers costs?</span><b>${r.weeklyPayCoversCosts ? "Yes" : "No"}</b><small>${usd(S.period.amount)}/${S.period.label} vs ${usd(r.expensesAfter)}/mo</small></div>
    <div><span>Purchase vs your cushion</span><b>${r.spendShareOfReserve == null ? "—" : Math.round(r.spendShareOfReserve * 100) + "%"}</b><small>of reserve + emergency fund</small></div></div>`;
  $("wiOut").textContent = r.explanation;
  return r;
};

// ---------- Report + AI consultant ----------
const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
const table = (heads, rows) => `<table class="tx"><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;
const mini = (pairs) => `<div class="mini">${pairs.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>`;
$("repType").onchange = () => { const off = ["taxes", "goals"].includes($("repType").value); $("repPeriod").disabled = off; $("repCustom").hidden = off || $("repPeriod").value !== "custom"; };
$("repPeriod").onchange = () => {
  $("repCustom").hidden = $("repPeriod").value !== "custom";
  if (!$("repFrom").value && S) { const t = S.user.today; const y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7)); $("repTo").value = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; $("repFrom").value = `${y - 1}-${t.slice(5, 7)}`; }
};
$("reportBtn").onclick = async () => {
  let r;
  try { r = await api("POST", "/api/reports", { type: $("repType").value, period: $("repPeriod").value, from: $("repFrom").value, to: $("repTo").value, includeSelf: $("repSelf").checked }); }
  catch (e) { $("reportOut").textContent = e.message; return; }
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
    tbl = table(["Month", "Income", "Taxes", r.payLabel === "weekly pay" ? "Steady income" : "Expenses", "Left"], r.rows.map((x) => [x.month, usd(x.income), usd(x.taxes), usd(x.pay), `<b class="${x.net < 0 ? "neg" : "pos"}">${usd(x.net)}</b>`]));
  } else if (r.type === "taxes") {
    stats = r.enabled ? mini([["Set aside", usd(r.setAside)], ["Next due", r.nextDueDate || "—"], ["Paid this year", usd(r.paidYtd)], ["Not covered yet", usd(Math.max(0, r.gap))]]) : "";
    tbl = r.payments.length ? table(["Date", "Payment", "Note"], r.payments.map((x) => [x.date, usd(x.amount), x.note || ""])) : "";
  } else if (r.type === "goals") {
    tbl = table(["Goal", "Saved", "Target", "Progress", "Needed / month", "By"], r.goals.map((g) => [g.name, usd(g.saved), usd(g.target), pct(g.progress), usd(g.neededPerMonth), g.deadline]));
  }
  if (!["taxes", "goals"].includes(r.type) && r.periodLabel) {
    const selfNote = r.selfReportedInPeriod ? (r.includeSelf ? ` · <span class="pill warn">Modified report: includes ${usd(r.selfReportedInPeriod)} self-reported or outside PayPal, not verified</span>` : "") : "";
    stats = `<div class="small muted">${r.periodLabel}${selfNote}</div>` + stats;
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
    <div>${mini([["Steady income", r.weekly ? `${usd(S.period.amount)} / ${S.period.label}` : "paused"], ["Reserve today", usd(r.startingBuffer)], ["Typical in " + r.months + " mo", usd(r.medianEnd)], ["Bad case (1 in 10)", usd(r.badCaseEnd)]])}
    ${r.safeWeeklyAt95 != null && r.weekly ? `<div class="small muted">Highest income per ${S.period.label} that stays 95% safe: <b>${usd(Math.round((r.safeWeeklyAt95 * 52) / S.period.perYear / 5) * 5)}</b></div>` : ""}</div></div>${fanChart(r.band, r.startingBuffer)}`;
  $("rwText").textContent = r.explanation;
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
  renderOtherIncome(s);
  if (profileLoaded) return; // don't overwrite what the user is typing
  // Your numbers
  $("nRent").value = s.settings.rent ?? ""; $("nExp").value = s.settings.fixedMonthlyExpenses ?? "";
  $("nWeekly").value = s.salary.userChosen ? s.period.amount : ""; $("nWeeks").value = s.settings.reserveWeeks || 4;
  $("nWeeklyLbl").textContent = `Income per payday (every ${s.period.label})`;
  const eg = s.goals.find((g) => g.id === "emergency");
  $("nEmerg").value = eg ? eg.target : ""; $("nEmerg").disabled = !eg;
  const sugP = Math.round((s.suggestions.weeklyPay * 52) / s.period.perYear / 5) * 5;
  $("sWeekly").innerHTML = `Suggested from your history: <button type="button" class="chip" data-wk="${sugP}">${usd(sugP)}</button> or leave empty to follow it. Frequency and manual/automatic: SteadPal preferences above.`;
  $("sWeekly").querySelector("[data-wk]").onclick = (e) => { $("nWeekly").value = e.target.dataset.wk; numberNotes(); };
  $("sEmerg").innerHTML = eg ? emergencyChips() + ` ${i("emergency")}` : "You deleted the emergency pot; add one on Home if you want it back.";
  $("sEmerg").querySelectorAll("[data-fill]").forEach((c) => (c.onclick = () => { $("nEmerg").value = c.dataset.fill; numberNotes(); }));
  numberNotes();
  // About you
  const a = s.settings.aboutMe || {};
  $("abShare").checked = Boolean(a.share);
  $("abRisk").value = a.risk || ""; $("abWork").value = a.workType || ""; $("abClients").value = a.clients || ""; $("abYears").value = a.yearsFreelancing || "";
  $("abJob").value = a.otherJob || ""; $("abPriority").value = a.priority || ""; $("abStyle").value = a.style || "";
  $("abSlow").innerHTML = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    .map((m) => `<label class="mp"><input type="checkbox" value="${m}" ${(a.slowMonths || []).includes(m) ? "checked" : ""}>${m}</label>`).join("");
  $("oiDate").value = s.user.today;
  const tp = s.settings.taxProfile || {};
  $("tpEnabled").checked = tp.enabled !== false;
  $("tpBusiness").value = tp.businessType || ""; $("tpEntity").value = tp.entity || "Sole proprietor"; $("tpState").value = tp.state || "";
  $("tpFed").value = +((tp.federalRate ?? 0.2) * 100).toFixed(1); $("tpStateRate").value = +((tp.stateRate ?? 0) * 100).toFixed(1);
  renderDates(tp.dueDates || []);
  profileLoaded = true;
}
// Gentle notes: SteadPal comments, the user decides. Nothing here blocks a save.
function numberNotes() {
  const sg = S.suggestions, notes = [];
  const P = S.period;
  const rent = Number($("nRent").value), exp = Number($("nExp").value), wk = Number($("nWeekly").value) ? (Number($("nWeekly").value) * P.perYear) / 52 : sg.weeklyPay;
  const em = Number($("nEmerg").value), weeks = Number($("nWeeks").value);
  if (exp && rent > exp) notes.push("Rent is higher than your total fixed expenses: does the expenses figure include rent?");
  if (wk > sg.weeklyPay * 1.1) notes.push(`${usd(Math.round((wk * 52) / P.perYear))} every ${P.label} is above what your recent income supports (${usd(Math.round((sg.weeklyPay * 52) / P.perYear / 5) * 5)}). It looks like you may be overstretching; the Runway check on Analysis shows how safe it is.`);
  if ((wk * 52) / 12 > sg.afterTaxMean) notes.push("That income is more than you earn on average after taxes, so the reserve would shrink over time.");
  if (exp && wk && (wk * 52) / 12 < exp * 0.9) notes.push(`Your steady income (${usd(Math.round((wk * 52) / 12))}/month) is below your fixed expenses (${usd(exp)}).`);
  if (em && exp && em < exp) notes.push(`Your emergency target covers less than one month of expenses. A common guide is at least three months ${i("emergency")}.`);
  if (em && sg.emergencyAmount && em > sg.expensesTimes6 * 1.5) notes.push("That's a large cushion: past about 9 months of expenses, some people move the extra toward other goals.");
  if (weeks && weeks < 2) notes.push("With less than 2 weeks of income in reserve, one late client can interrupt your steady income.");
  $("numNotes").innerHTML = notes.map((n) => `<div class="note">${n}</div>`).join("") ||
    `<div class="muted small">Your income changes by about ${Math.round(sg.irregularity * 100)}% from month to month, so SteadPal suggests a cushion of about ${sg.emergencyMonths} months of expenses. More irregular income means a bigger suggestion.</div>`;
}
["nRent", "nExp", "nWeekly", "nWeeks", "nEmerg"].forEach((id) => ($(id).oninput = numberNotes));
$("nSave").onclick = async () => {
  const r = await api("POST", "/api/profile/numbers", { rent: $("nRent").value, expenses: $("nExp").value, payAmount: $("nWeekly").value, reserveWeeks: $("nWeeks").value, emergencyTarget: $("nEmerg").value });
  render(r, ["emergency", "salaryReserve"]);
  $("nMsg").textContent = `Saved. Steady income: ${usd(r.period.amount)} every ${r.period.label}${r.salary.userChosen ? " (your choice)" : " (suggested)"}.`;
};
$("abSave").onclick = async () => {
  const r = await api("POST", "/api/profile/about", {
    share: $("abShare").checked, risk: $("abRisk").value, workType: $("abWork").value, clients: $("abClients").value, yearsFreelancing: $("abYears").value,
    otherJob: $("abJob").value, priority: $("abPriority").value, style: $("abStyle").value,
    slowMonths: [...document.querySelectorAll("#abSlow input:checked")].map((x) => x.value),
  });
  render(r);
  $("abMsg").textContent = r.settings.aboutMe.share ? "Saved. The AI consultant will use these answers." : "Saved, but not shared with the AI (switch on to share).";
};
$("abShare").onchange = () => $("abSave").onclick();
function renderOtherIncome(s) {
  $("oiList").innerHTML = s.otherIncome.length
    ? `<table class="tx"><tr><th>Date</th><th>From</th><th>Amount</th><th></th></tr>${s.otherIncome.map((t) => `<tr><td>${t.date}</td><td>${(s.transactions.find((x) => x.date === t.date && x.amount === t.amount) || {}).client || t.payer}</td><td>${usd(t.amount)}</td><td><button class="btn link small-btn" data-oidel="${t.ref}">Delete</button></td></tr>`).join("")}</table>`
    : `<div class="muted small">Nothing added yet.</div>`;
  document.querySelectorAll("[data-oidel]").forEach((b) => (b.onclick = async () => render(await api("POST", "/api/income/self/delete", { ref: b.dataset.oidel }))));
}
// ---------- Import self-reported income (CSV file or pasted rows; no new connections) ----------
$("oiTemplate").href = "data:text/csv;charset=utf-8," + encodeURIComponent("date,amount,source\n2026-04-20,300,Etsy shop\n2026-04-27,150,Cash client\n");
function parseCsv(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (!lines.length) return { rows: [], skipped: 0 };
  const split = (l) => { const out = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if ((ch === "," || ch === ";" || ch === "\t") && !q) { out.push(cur.trim()); cur = ""; } else cur += ch; } out.push(cur.trim()); return out; };
  let head = split(lines[0]).map((h) => h.toLowerCase());
  const hasHeader = head.some((h) => /date|amount|credit|gross|net|source|description|name|from|payer|memo/.test(h));
  const col = (re, dflt) => { const i = head.findIndex((h) => re.test(h)); return i >= 0 ? i : dflt; };
  const di = hasHeader ? col(/date/, 0) : 0, ai = hasHeader ? col(/amount|credit|gross|net|deposit/, 1) : 1, si = hasHeader ? col(/source|from|payer|name|description|memo/, 2) : 2;
  const toDate = (x) => {
    x = (x || "").trim();
    let m = x.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = x.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; }
    return "";
  };
  const toAmt = (x) => { x = String(x || "").replace(/[$,\s]/g, ""); const neg = /^\(.*\)$/.test(x) || x.startsWith("-"); const n = Number(x.replace(/[()\-]/g, "")); return neg ? -n : n; };
  const rows = []; let skipped = 0;
  for (const l of lines.slice(hasHeader ? 1 : 0)) {
    const c = split(l), date = toDate(c[di]), amount = toAmt(c[ai]);
    if (!date || !(amount > 0)) { skipped++; continue; }
    rows.push({ date, amount, source: (c[si] || "Imported").slice(0, 40) });
  }
  return { rows, skipped };
}
let oiRows = [];
function previewImport(text) {
  const { rows, skipped } = parseCsv(text);
  oiRows = rows;
  $("oiImport").disabled = !rows.length;
  $("oiPrev").innerHTML = rows.length
    ? `<b>${rows.length}</b> payment${rows.length > 1 ? "s" : ""} ready${skipped ? `, ${skipped} line${skipped > 1 ? "s" : ""} skipped (no date, or money going out)` : ""}:` +
      `<table class="tx">${rows.slice(0, 5).map((r) => `<tr><td>${r.date}</td><td>${r.source}</td><td>${usd(r.amount)}</td></tr>`).join("")}</table>${rows.length > 5 ? `<span class="muted">…and ${rows.length - 5} more</span>` : ""}`
    : `No payments found. Use columns date, amount, source (a header row is fine; dates like 2026-04-20 or 4/20/2026).`;
}
$("oiFile").onchange = () => { const f = $("oiFile").files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { $("oiPaste").value = rd.result.slice(0, 20000); previewImport(rd.result); }; rd.readAsText(f); };
$("oiPreview").onclick = () => previewImport($("oiPaste").value);
$("oiImport").onclick = async () => {
  const r = await api("POST", "/api/income/self/import", { rows: oiRows });
  render(r.state); oiRows = []; $("oiImport").disabled = true; $("oiPaste").value = ""; $("oiFile").value = ""; $("oiPrev").innerHTML = "";
  $("oiMsg").textContent = `Imported ${r.added}${r.skipped ? `, skipped ${r.skipped}` : ""}. Marked self-reported; never counted in the passport.`;
};

$("oiAdd").onclick = async () => {
  try {
    const r = await api("POST", "/api/income/self", { date: $("oiDate").value, amount: $("oiAmount").value, source: $("oiSource").value });
    render(r); $("oiAmount").value = ""; $("oiSource").value = "";
    $("oiMsg").textContent = "Added. It shows in reports as self-reported and in the transactions table; never in the passport.";
  } catch (e) { $("oiMsg").textContent = e.message; }
};

$("tpSave").onclick = async () => {
  const r = await api("POST", "/api/tax/profile", {
    enabled: $("tpEnabled").checked, businessType: $("tpBusiness").value, entity: $("tpEntity").value, state: $("tpState").value,
    federalRate: Number($("tpFed").value) / 100, stateRate: Number($("tpStateRate").value) / 100,
    dueDates: [...document.querySelectorAll("#tpDates input")].map((i) => i.value).filter(Boolean),
  });
  render(r);
  $("tpMsg").textContent = `Saved. Tax set-aside: ${r.settings.taxProfile.enabled ? Math.round(r.settings.taxRate * 100) + "% of each payment" : "off"}.`;
};
$("tpEnabled").onchange = () => $("tpSave").onclick();
// Payment dates: one date picker per date, add or delete as needed.
function renderDates(dates) {
  $("tpDates").innerHTML = dates.map((d) => `<span class="dateitem"><input type="date" value="${d}"><button type="button" title="Delete this date" aria-label="Delete date">×</button></span>`).join("") ||
    `<span class="small muted">No dates yet.</span>`;
  $("tpDates").querySelectorAll(".dateitem button").forEach((b) => (b.onclick = () => {
    renderDates([...document.querySelectorAll("#tpDates input")].filter((i) => i !== b.previousElementSibling).map((i) => i.value));
  }));
}
$("tpAddDate").onclick = () => {
  const cur = [...document.querySelectorAll("#tpDates input")].map((i) => i.value);
  renderDates([...cur, ""]);
  const inputs = document.querySelectorAll("#tpDates input");
  inputs[inputs.length - 1].focus();
};
const saveRoundUps = async () => {
  const r = await api("POST", "/api/roundups", { enabled: $("ruEnabled").checked, step: Number($("ruStep").value) });
  render(r);
  $("ruOut").textContent = r.settings.roundUps.enabled ? `On: a $118.40 purchase adds $${(Math.ceil(118.4 / r.settings.roundUps.step) * r.settings.roundUps.step - 118.4).toFixed(2)} to your goals.` : "Off.";
};
$("ruEnabled").onchange = saveRoundUps; $("ruStep").onchange = saveRoundUps;

$("ppBtn").onclick = async () => {
  try {
    const r = await api("POST", "/api/passport", { months: Number($("ppMonths").value), threshold: 2500, allowRequests: $("ppAsk").checked });
    const s = r.summary;
    const left = r.excluded.length ? `<p class="muted small">Not counted (private to you): ${r.excluded.map((x) => `${usd(x.amount)} on ${x.date}, ${x.why}`).join("; ")}.</p>` : "";
    $("ppOut").innerHTML = `<div class="passport">
      <div class="pp-head"><img src="/logo.svg" alt="" width="36"><div><b>Income Passport</b><div class="muted small">${s.period}</div></div>
      <div class="pp-code">Code <span class="code">${r.code}</span></div></div>
      <div class="mini"><div><span>Monthly average</span><b>${usd(s.monthlyAverage)}</b></div><div><span>Lowest</span><b>${usd(s.min)}</b></div>
      <div><span>Highest</span><b>${usd(s.max)}</b></div><div><span>Verified clients</span><b>${s.distinctVerifiedPayers}</b></div></div>
      <div class="row"><a class="btn" href="${r.certificateUrl}" target="_blank">Open certificate (PDF)</a>
      <a class="btn ghost" href="${r.verifyUrl}" target="_blank">Verification page</a></div>
      <p class="muted small">${s.monthsAboveThreshold} · expires in 30 days</p>
      <div class="note ${s.clientConcentration.flag ? "" : "soft"}"><b>Shown on the passport:</b> ${s.clientConcentration.text}${r.allowRequests ? " Viewers can ask you about these clients; you decide what to share." : ""}</div>${left}</div>`;
    refresh();
  } catch (e) { $("ppOut").textContent = e.message; }
};
$("reset").onclick = async () => { prefsLoaded = false; $("setup").hidden = true; $("nudge").hidden = true; $("evidence").hidden = true; filterTx(""); profileLoaded = false; ["rwOut", "rwText", "ivOut", "repTable", "ruOut", "tpMsg", "nMsg", "abMsg", "oiMsg", "evidence"].forEach((id) => ($(id).innerHTML = "")); render(await api("POST", "/api/reset")); ["payHint", "goalOut", "wiOut", "wiResult", "reportOut", "repStats", "askOut", "ppOut"].forEach((id) => ($(id).textContent = "")); };

// ---------- Guided demo: the 5 moments in order, for the video ----------
const cardOf = (id) => $(id).closest(".card");
function spot(id, caption) {
  document.querySelectorAll(".card.spot").forEach((c) => c.classList.remove("spot"));
  const c = cardOf(id);
  showTab(c.closest("[data-tab]")?.dataset.tab || "home");
  c.classList.add("spot");
  c.scrollIntoView({ behavior: "smooth", block: "center" });
  $("guideCaption").textContent = caption;
}
const STEPS = [
  async () => {
    await $("reset").onclick();
    window.scrollTo({ top: 0, behavior: "smooth" });
    document.querySelectorAll(".card.spot").forEach((c) => c.classList.remove("spot"));
    showTab("wallet");
    $("guideCaption").textContent = "Meet Ana: freelance designer in Los Angeles. $3,500 in March, $800 in April. Rent is still $1,500. SteadPal lives inside her PayPal Wallet: one balance, labelled into pots.";
  },
  async () => spot("forecastBody", "SteadPal reads her PayPal history: a retainer ended and an invoice is 21 days late. It warns her about the weak month before it happens, and shows her steady income is still protected."),
  async () => {
    if (S.openInvoices.length) await draftReminder(S.openInvoices[0].id);
    spot("nudge", "The AI drafts a polite reminder for the late $1,600 invoice. Ana edits it if she wants and sends it through PayPal.");
  },
  async () => {
    if (S.paypal.enabled && !autoPlaying) {
      spot("payButtons", "The client pays the overdue invoice with PayPal. Pay with the sandbox buyer account to see the AI split it.");
    } else {
      await $("simPay").onclick();
      spot("pots", "The late $1,600 arrives through PayPal. The AI splits it: taxes, income reserve, emergency fund, and the code checks every dollar.");
    }
  },
  async () => {
    $("shopQuery").value = "drawing stylus";
    if (!S.settings.roundUps?.enabled) render(await api("POST", "/api/roundups", { enabled: true, step: 5 }));
    const r = await $("shopBtn").onclick();
    if ((S.paypal.enabled && !autoPlaying) || !r || !r.products.length) {
      spot("shopResults", "Ana searches real products through Channel3 and pays with PayPal. Each one shows the cashback it would add to her pots.");
    } else {
      await buyProduct(r.products[0].id);
      spot("pots", "She buys with PayPal. The cashback and the round-up (optional) don't go to the wallet: they go to the goal most behind, her emergency fund.");
    }
  },
  async () => {
    $("wiPrice").value = 1400; $("wiEarn").value = 0; $("wiCosts").value = 0;
    const r = await $("wiBtn").onclick();
    spot("wiOut", `A $1,400 laptop now? Her emergency fund would be ready in ${r.emergencyMonthsAfter} months instead of ${r.emergencyMonthsNow}, and it equals ${Math.round(r.spendShareOfReserve * 100)}% of her cushion. She decides.`);
  },
  async () => {
    $("rwMonths").value = "6";
    const r = await $("rwBtn").onclick();
    spot("rwOut", `Is her steady income safe? SteadPal runs 1,000 possible futures from her own history: ${Math.round(r.probSafe * 100)} in 100 keep her pay covered for 6 months. The AI explains; the math decides.`);
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
    spot("repStats", `Reports: ${top.client} brings ${Math.round(top.share * 100)}% of her income${top.avgDaysLate ? ` and pays about ${top.avgDaysLate} days late` : ""}. On Home, every PayPal payment is in one table that shows what counts for the passport.`);
  },
];
// ---------- Narration: each guided step speaks its part of the script ----------
// Uses an MP3 from /voice/step-N.mp3 if present (e.g. made with ElevenLabs), otherwise the browser's own voice.
const NARRATION = [
  "Sixty-four million Americans freelance. Ana is one of them: a designer in Los Angeles. In March she earned thirty-five hundred dollars. In April, eight hundred. Her rent is still fifteen hundred. This is SteadPal: the paycheck freelancers never had, a feature concept for PayPal. SteadPal lives inside the PayPal Wallet. One balance, labelled into pots: taxes, an income reserve, an emergency fund and goals. The money never leaves PayPal, and Ana can switch SteadPal off anytime.",
  "SteadPal reads her PayPal history. A retainer ended, and an invoice is twenty-one days late. So it warns her before the weak month, and shows her steady income is still protected.",
  "The AI drafts a polite reminder for the late invoice. Ana edits it and sends it through PayPal. Her client can even pay with Pay Later, and Ana still gets the full amount now.",
  "The sixteen hundred dollars arrives. SteadPal splits it: four hundred for taxes, nine hundred to refill her income reserve, three hundred to her emergency fund. The AI explains every decision. The math is code, and code checks every dollar.",
  "She buys a stylus with PayPal through Channel 3. The cashback, and an optional round-up, go to the goal that needs them most, not to her wallet.",
  "A fourteen-hundred-dollar laptop, right now? Her emergency fund would be ready months later. SteadPal shows the trade-off. Ana decides.",
  "Is her income safe? SteadPal runs one thousand possible futures from her own history. In almost all of them, her income stays covered for the next six months.",
  "A landlord asks for proof of income. Ana shares a signed income passport: facts from PayPal payments only, never a score, with a code anyone can verify.",
  "Her reports show which clients pay late, and an AI consultant answers her questions. Freelancers get a steady paycheck. PayPal keeps the money and the clicks. Every dollar through PayPal works for you. Click PayPal. Build your future.",
];
let voiceOn = false, voiceAudio = null;
function stopVoice() { if (voiceAudio) { voiceAudio.pause(); voiceAudio = null; } if (window.speechSynthesis) speechSynthesis.cancel(); }
function pickVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  return vs.find((v) => /Google US English/i.test(v.name)) || vs.find((v) => /Samantha|Jenny|Aria|Zira/i.test(v.name) && /en/i.test(v.lang)) || vs.find((v) => /^en-US/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
}
// Recorded voiceover (ElevenLabs): one file, with the second where each step starts.
const VOICE_FILE = "/voice/full.mp3";
const VOICE_MARKS = [0, 29.9, 40.8, 53.2, 67.9, 77.2, 85.1, 96.0, 105.9, 999];
let hasRecording = false;
fetch(VOICE_FILE, { method: "HEAD" }).then((r) => (hasRecording = r.ok)).catch(() => {});
function speakStep(n) {
  stopVoice();
  if (!voiceOn || !NARRATION[n]) return;
  if (hasRecording) {
    const a = new Audio(VOICE_FILE);
    voiceAudio = a;
    a.addEventListener("loadedmetadata", () => { a.currentTime = VOICE_MARKS[n]; a.play().catch(() => {}); }, { once: true });
    a.addEventListener("timeupdate", () => { if (a.currentTime >= VOICE_MARKS[n + 1] - 0.05) a.pause(); });
    return;
  }
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(NARRATION[n]);
  const v = pickVoice(); if (v) u.voice = v;
  u.lang = "en-US"; u.rate = 0.98; u.pitch = 1;
  speechSynthesis.speak(u);
}

// One button: plays the whole voiceover and moves through the 9 steps by itself (for recording the video).
let autoPlaying = false;
function markStep(i) {
  document.querySelectorAll(".step[data-step]").forEach((x) => {
    x.classList.toggle("active", Number(x.dataset.step) === i);
    x.classList.toggle("done", Number(x.dataset.step) < i);
  });
}
$("playAll").onclick = async () => {
  if (autoPlaying) { autoPlaying = false; stopVoice(); $("playAll").textContent = "▶ Play demo with voice"; return; }
  autoPlaying = true; stopVoice();
  $("playAll").textContent = "■ Stop";
  let next = 0;
  const run = async (i) => { markStep(i); try { await STEPS[i](); } catch (e) { $("guideCaption").textContent = "Something went wrong: " + e.message; } };
  if (hasRecording) {
    const a = new Audio(VOICE_FILE);
    voiceAudio = a;
    a.play().catch(() => {}); // start right away, while the click still counts as a user gesture
    await run(0); next = 1;
    a.addEventListener("timeupdate", () => {
      if (!autoPlaying) return;
      while (next < STEPS.length && a.currentTime >= VOICE_MARKS[next]) { const k = next++; run(k); }
    });
    a.addEventListener("ended", () => { autoPlaying = false; $("playAll").textContent = "▶ Play demo with voice"; });
  } else {
    // No recording: browser voice, one step after another.
    for (let i = 0; i < STEPS.length && autoPlaying; i++) {
      await run(i);
      await new Promise((res) => {
        if (!window.speechSynthesis) return setTimeout(res, 6000);
        const u = new SpeechSynthesisUtterance(NARRATION[i]); const v = pickVoice(); if (v) u.voice = v; u.lang = "en-US";
        u.onend = res; u.onerror = res; speechSynthesis.speak(u);
      });
    }
    autoPlaying = false; $("playAll").textContent = "▶ Play demo with voice";
  }
};
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => pickVoice();
$("voiceBtn").onclick = () => {
  voiceOn = !voiceOn;
  $("voiceBtn").textContent = voiceOn ? "🔊 Voice: on" : "🔊 Voice: off";
  $("voiceBtn").classList.toggle("active", voiceOn);
  if (!voiceOn) stopVoice();
  else if (window.speechSynthesis) { const u = new SpeechSynthesisUtterance("Voice on."); const v = pickVoice(); if (v) u.voice = v; speechSynthesis.speak(u); }
};

document.querySelectorAll(".step[data-step]").forEach((b) => {
  b.onclick = async () => {
    const i = Number(b.dataset.step);
    document.querySelectorAll(".step[data-step]").forEach((x) => {
      x.classList.toggle("active", x === b);
      x.classList.toggle("done", Number(x.dataset.step) < i);
    });
    speakStep(i);
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
