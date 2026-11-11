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

  const goalsByPot = Object.fromEntries(s.goals.map((g) => [g.id, g]));
  $("pots").innerHTML = Object.entries(s.pots).map(([k, v]) => {
    const g = goalsByPot[k];
    const pct = g ? Math.min(100, Math.round((v / g.target) * 100)) : null;
    const name = POT_NAMES[k] || (g ? g.name : k);
    return `<div class="pot ${flash.includes(k) ? "flash" : ""}"><div class="name">${name}</div>
      <div class="val">${usd(v)}</div>
      ${g ? `<div class="bar"><i style="width:${pct}%"></i></div><div class="muted small">${pct}% of ${usd(g.target)} · by ${g.deadline || "—"}</div>` : ""}</div>`;
  }).join("");

  $("invoices").innerHTML = s.openInvoices.length
    ? s.openInvoices.map((i) => `<div class="invoice">Northwind Ltd invoice ${i.id}: ${usd(i.amount)}, due ${i.dueDate} (overdue)</div>`).join("")
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

  $("activity").innerHTML = s.activity.length
    ? s.activity.map((a) => `<li><span class="kind">${a.kind}</span>${a.text}</li>`).join("")
    : `<li class="muted">Nothing yet. Try the late payment.</li>`;
}

async function refresh(flash) { render(await api("GET", "/api/state"), flash); }
const flashFrom = (alloc) => Object.keys(alloc || {}).filter((k) => k !== "unassigned");

// ---------- actions ----------
$("simPay").onclick = async () => {
  const r = await api("POST", "/api/demo/payment", { amount: 1600, payer: "northwind" });
  $("payHint").textContent = r.explanation;
  render(r.state, flashFrom(r.plan.alloc));
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
$("goalBtn").onclick = async () => {
  const r = await api("POST", "/api/goal", { text: $("goalText").value });
  $("goalOut").textContent = r.saved ? `Saved: ${r.goal.name}, ${usd(r.goal.target)} by ${r.goal.deadline}.` : r.ask;
  if (r.saved) render(r.state, [r.state.goals.at(-1).id]);
};
$("wiBtn").onclick = async () => {
  const r = await api("POST", "/api/whatif", { price: Number($("wiPrice").value) });
  $("wiOut").textContent = r.explanation;
};
$("reportBtn").onclick = async () => { $("reportOut").textContent = (await api("GET", "/api/report")).explanation; };
$("ppBtn").onclick = async () => {
  try {
    const r = await api("POST", "/api/passport", { months: Number($("ppMonths").value), threshold: 2500 });
    const rows = Object.entries(r.summary).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");
    const left = r.excluded.length ? `<p class="muted small">Not counted (private to you): ${r.excluded.map((x) => `${usd(x.amount)} on ${x.date}, ${x.why}`).join("; ")}.</p>` : "";
    $("ppOut").innerHTML = `<div class="passport">Verification code <span class="code">${r.code}</span> ·
      <a href="${r.verifyUrl}" target="_blank">open verification page</a> · expires in 30 days<table>${rows}</table>${left}</div>`;
    refresh();
  } catch (e) { $("ppOut").textContent = e.message; }
};
$("reset").onclick = async () => { render(await api("POST", "/api/reset")); ["payHint", "goalOut", "wiOut", "reportOut", "ppOut"].forEach((id) => ($(id).textContent = "")); };

// ---------- PayPal buttons (sandbox), only when keys are configured ----------
function loadPayPal(clientId) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD`;
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
function mountButton(el, { amount, description, kind, payer, merchant }) {
  window.paypal.Buttons({
    style: { layout: "horizontal", height: 40, tagline: false },
    createOrder: async () => (await api("POST", "/api/paypal/order", { amount, description })).id,
    onApprove: async (d) => {
      const r = await api("POST", "/api/paypal/capture", { orderId: d.orderID, amount, kind, payer, merchant });
      if (kind === "purchase") render(r.state, [r.route.goal]);
      else { $("payHint").textContent = r.explanation; render(r.state, flashFrom(r.plan.alloc)); }
    },
    onError: (e) => alert("PayPal error: " + e),
  }).render(el);
}

(async () => {
  await refresh();
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
