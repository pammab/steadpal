// SteadPal server. Node.js 22, no external dependencies.
// Run: node server.js  (then open http://localhost:3000)
// Env (all optional for the offline demo):
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET  -> real PayPal sandbox payments and payouts
//   PAYPAL_PAYOUT_RECEIVER                   -> sandbox personal account email that receives weekly pay
//   ANTHROPIC_API_KEY, STEADPAL_MODEL        -> real AI explanations and goal interpretation
//   PASSPORT_SECRET                          -> key used to sign income passports
//   PORT                                     -> default 3000
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const E = require("./engine/core");
const AI = require("./engine/llm");
const PP = require("./paypal");
const C3 = require("./channel3");
const A = require("./engine/analysis");
const shopCache = new Map(); // product id -> product returned by the last searches

const PORT = process.env.PORT || 3000;
const INVOICE_TO = process.env.PAYPAL_INVOICE_RECIPIENT || process.env.PAYPAL_PAYOUT_RECEIVER || null; // sandbox client email
const SECRET = process.env.PASSPORT_SECRET || "dev-only-secret-change-me";
const seed = () => JSON.parse(fs.readFileSync(path.join(__dirname, "data", "ana.json"), "utf8"));
let data = seed();
const RATES = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "rates.json"), "utf8"));
const passports = new Map(); // code -> { summary, signature, expires }
const activity = []; // latest events shown in the app

// ---------- helpers ----------
const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};
const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
const log = (kind, text, extra = {}) => activity.unshift({ at: new Date().toISOString(), kind, text, ...extra });
const money = (x) => Number(Number(x).toFixed(2));
const payerName = (id) => (data.payers || []).find((p) => p.id === id)?.name || id;
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);

function applyPlan(plan) {
  for (const [k, v] of Object.entries(plan.alloc)) {
    if (k === "unassigned") continue;
    const goal = data.goals.find((g) => g.id === k);
    const pot = goal ? goal.pot : k;
    data.pots[pot] = money((data.pots[pot] || 0) + v);
  }
}

function state() {
  const report = E.monthlyReport(data);
  const months = E.lastMonths(data.user.today, 6);
  const stats = E.incomeStats(E.monthlyIncome(data.transactions, months));
  return {
    user: data.user,
    settings: data.settings,
    pots: data.pots,
    goals: report.goals,
    forecast: report.forecast,
    salary: E.safeWeeklySalary(stats, data.settings),
    reserve: report.reserve,
    stats,
    offers: data.cashbackOffers,
    openInvoices: data.openInvoices.map((i) => ({ ...i, payerName: payerName(i.payer), daysLate: daysBetween(i.dueDate, data.user.today) })),
    transactions: data.transactions.map((t) => {
      const p = (data.payers || []).find((x) => x.id === t.payer) || {};
      const counts = t.channel === "paypal" && ["invoice", "goods_services"].includes(t.type) && p.verified && !p.linkedToUser && (p.accountAgeDays || 0) >= 30;
      return { date: t.date, client: p.name || t.payer, amount: t.amount, channel: t.channel === "paypal" ? "PayPal" : "Other", type: t.type, passport: Boolean(counts) };
    }),
    activity: activity.slice(0, 12),
    tax: A.taxStatus(data),
    paypal: { enabled: PP.enabled(), invoicing: PP.enabled() && Boolean(INVOICE_TO), clientId: process.env.PAYPAL_CLIENT_ID || null },
    channel3: { enabled: C3.enabled(), cashbackRate: C3.CASHBACK_RATE },
    ai: { enabled: Boolean(process.env.ANTHROPIC_API_KEY), model: AI.MODEL },
  };
}

// Records an incoming client payment and runs the split (shared by demo mode and real PayPal).
async function receivePayment(amount, payerId, source, paypalId) {
  const inv = data.openInvoices.find((i) => i.payer === payerId && Math.abs(i.amount - amount) < 0.01);
  if (inv) data.openInvoices = data.openInvoices.filter((i) => i !== inv);
  const plan = E.planSplit(amount, data); // computed before the payment enters history
  data.transactions.push({ date: data.user.today, amount, payer: payerId, channel: "paypal", type: "invoice", paypalId });
  applyPlan(plan);
  const explanation = await AI.explain("split", plan);
  log("payment", explanation, { amount, source, alloc: plan.alloc });
  return { plan, explanation };
}

// Optional round-ups: the spare change of a PayPal purchase goes to the same pot as the cashback.
function applyRoundUp(price, pot) {
  const ru = data.settings.roundUps || {};
  if (!ru.enabled) return 0;
  const extra = A.roundUp(price, ru.step || 1);
  if (extra > 0) {
    data.pots[pot] = money((data.pots[pot] || 0) + extra);
    log("round-up", `Round-up to the next $${ru.step}: $${extra.toFixed(2)} moved to your ${pot === "emergency" ? "emergency fund" : pot} pot.`);
  }
  return extra;
}

function signPassport(summary) {
  const body = JSON.stringify(summary);
  const signature = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  const code = signature.slice(0, 10).toUpperCase();
  return { code, signature };
}

// ---------- routes ----------
const routes = {
  "GET /api/state": async () => [200, state()],

  // Quick health check for the AI connection: makes one tiny call and reports the result.
  "GET /api/ai/check": async () => {
    if (!process.env.ANTHROPIC_API_KEY) return [200, { ok: false, reason: "ANTHROPIC_API_KEY not set" }];
    const text = await AI.explain("cashback", { amount: 1, goalName: "Test", progress: 0.5 });
    const err = AI.getLastError();
    return [200, err ? { ok: false, model: AI.MODEL, reason: err } : { ok: true, model: AI.MODEL, sample: text }];
  },

  // Late-invoice nudge: AI drafts a reminder; the user edits it and sends it (sending is simulated in the demo).
  "POST /api/invoice/reminder": async (b) => {
    const inv = data.openInvoices.find((i) => i.id === b.id);
    if (!inv) return [404, { error: "Invoice not found" }];
    const ctx = { invoiceId: inv.id, clientName: payerName(inv.payer), amount: inv.amount, dueDate: inv.dueDate, daysLate: daysBetween(inv.dueDate, data.user.today), freelancerName: data.user.name };
    return [200, { ...(await AI.draftReminder(ctx)), invoice: ctx }];
  },
  "POST /api/invoice/remind": async (b) => {
    const inv = data.openInvoices.find((i) => i.id === b.id);
    if (!inv) return [404, { error: "Invoice not found" }];
    const note = String(b.text || "").slice(0, 4000);
    const subject = `Reminder: invoice ${inv.id} for $${inv.amount}`;
    let via = "demo", paypalInvoiceId = inv.paypalInvoiceId || null, warning = null;
    if (PP.enabled() && INVOICE_TO) {
      try {
        if (!paypalInvoiceId) {
          // First reminder: create the invoice in PayPal and send it with the note (PayPal emails a Pay button).
          paypalInvoiceId = await PP.createInvoice({ amount: inv.amount, itemName: `Invoice ${inv.id} (design services)`, note, recipientEmail: INVOICE_TO, invoicerName: data.user.name });
          await PP.sendInvoice(paypalInvoiceId, subject, note);
        } else await PP.remindInvoice(paypalInvoiceId, subject, note);
        inv.paypalInvoiceId = paypalInvoiceId; via = "paypal";
      } catch (e) { warning = "PayPal Invoicing failed, reminder recorded in demo mode."; console.error("[invoicing]", e.message); }
    }
    inv.remindedOn = data.user.today;
    log("reminder", `Payment reminder for invoice ${inv.id} sent to ${payerName(inv.payer)}${via === "paypal" ? ` through PayPal Invoicing (${paypalInvoiceId})` : ""}.`);
    return [200, { via, paypalInvoiceId, warning, state: state() }];
  },

  // ---------- Analysis ----------
  "POST /api/runway": async (b) => {
    const r = A.runwayRisk(data, { months: Math.min(12, Math.max(3, Number(b.months) || 6)) });
    return [200, { ...r, explanation: await AI.explain("runway", r) }];
  },
  "POST /api/reports": async (b) => {
    const type = ["income", "clients", "taxes", "goals", "cashflow"].includes(b.type) ? b.type : "income";
    const r = A.report(type, data, [1, 3, 6].includes(Number(b.months)) ? Number(b.months) : 3);
    return [200, { ...r, explanation: await AI.explain(type === "income" ? "period" : `report_${type}`, r) }];
  },
  "POST /api/invest": async (b) => {
    const monthly = Math.max(0, Number(b.monthly) || 0), months = Math.min(120, Math.max(1, Number(b.months) || 12));
    const start = b.includeEmergency ? data.pots.emergency || 0 : 0;
    return [200, { monthly, months, start, options: A.investForecast(RATES, { monthly, months, start }) }];
  },

  // ---------- Taxes (optional) ----------
  "POST /api/tax/profile": async (b) => {
    const tp = data.settings.taxProfile || (data.settings.taxProfile = {});
    if (typeof b.enabled === "boolean") tp.enabled = b.enabled;
    for (const k of ["businessType", "entity", "state"]) if (b[k] != null) tp[k] = String(b[k]).slice(0, 80);
    for (const k of ["federalRate", "stateRate"]) if (b[k] != null) tp[k] = Math.min(0.6, Math.max(0, Number(b[k]) || 0));
    if (Array.isArray(b.dueDates)) tp.dueDates = b.dueDates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    data.settings.taxRate = +((tp.federalRate || 0) + (tp.stateRate || 0)).toFixed(4);
    return [200, state()];
  },
  "POST /api/tax/action": async (b) => {
    const pot = data.pots.tax || 0;
    const amt = Math.min(pot, Math.max(0, Number(b.amount) || 0));
    if (b.action === "paid") {
      if (pot > 0) { data.taxPayments.push({ date: data.user.today, amount: pot, note: "Marked as paid by the user" }); data.pots.tax = 0; }
      log("tax", `Tax payment of $${pot} recorded. Tax pot emptied.`);
    } else if (b.action === "partial") {
      data.taxPayments.push({ date: data.user.today, amount: amt, note: "Partial payment" }); data.pots.tax = money(pot - amt);
      log("tax", `Partial tax payment of $${amt} recorded.`);
    } else if (b.action === "move") {
      data.pots.tax = money(pot - amt); data.pots.emergency = money((data.pots.emergency || 0) + amt);
      log("tax", `$${amt} moved from the tax pot to the emergency fund.`);
    } else log("tax", "Tax pot kept as is.");
    return [200, state()];
  },
  "POST /api/roundups": async (b) => {
    data.settings.roundUps = { enabled: Boolean(b.enabled), step: [1, 5, 10].includes(Number(b.step)) ? Number(b.step) : 5 };
    return [200, state()];
  },


  "POST /api/reset": async () => { data = seed(); activity.length = 0; passports.clear(); return [200, state()]; },

  // Demo mode: simulate the late Northwind payment without PayPal keys.
  "POST /api/demo/payment": async (b) => {
    const amount = Number(b.amount || 1600);
    const r = await receivePayment(amount, b.payer || "northwind", "demo");
    return [200, { ...r, state: state() }];
  },

  // Real PayPal: create and capture an order for a client payment or a partner purchase.
  "POST /api/paypal/order": async (b) => {
    if (!PP.enabled()) return [400, { error: "PayPal keys not configured" }];
    const order = await PP.createOrder(b.amount, b.description || "SteadPal payment");
    return [200, { id: order.id }];
  },
  "POST /api/paypal/capture": async (b) => {
    if (!PP.enabled()) return [400, { error: "PayPal keys not configured" }];
    const cap = await PP.captureOrder(b.orderId);
    const unit = cap.purchase_units?.[0]?.payments?.captures?.[0];
    const amount = Number(unit?.amount?.value || b.amount);
    if (b.kind === "purchase") return routes["POST /api/cashback"]({ merchant: b.merchant, amount, paypalId: cap.id });
    if (b.kind === "shop") return routes["POST /api/shop/buy"]({ productId: b.productId, paypalId: cap.id });
    const r = await receivePayment(amount, b.payer || "northwind", "paypal", cap.id);
    return [200, { ...r, paypalStatus: cap.status, state: state() }];
  },

  // Webhook endpoint (PAYMENT.CAPTURE.COMPLETED). Signature verification is a TODO before production.
  "POST /api/paypal/webhook": async (b) => {
    log("webhook", `PayPal event received: ${b.event_type || "unknown"}`);
    return [200, { received: true }];
  },

  // Purchase at a partner merchant -> cashback goes to the right pot.
  "POST /api/cashback": async (b) => {
    const offer = data.cashbackOffers.find((o) => o.merchant === b.merchant && o.partner);
    if (!offer) return [400, { error: "Not a partner merchant: no cashback" }];
    const cashback = money(Number(b.amount) * offer.rate);
    const route = E.routeCashback(cashback, data);
    const goal = data.goals.find((g) => g.id === route.goal);
    data.pots[goal.pot] = money((data.pots[goal.pot] || 0) + cashback);
    const explanation = await AI.explain("cashback", route);
    log("cashback", explanation, { amount: cashback, merchant: offer.merchant });
    const roundUp = applyRoundUp(Number(b.amount), goal.pot);
    return [200, { route, explanation, roundUp, state: state() }];
  },

  // Real products from Channel3 with the cashback each would put into a pot.
  "POST /api/shop/search": async (b) => {
    const q = String(b.query || "").slice(0, 120);
    if (!q) return [400, { error: "Type what you are looking for" }];
    const r = await C3.search(q, { limit: 4, maxPrice: b.maxPrice });
    const products = r.products.map((p) => {
      shopCache.set(p.id, p);
      return { ...p, cashback: money(p.price * C3.CASHBACK_RATE) };
    });
    return [200, { source: r.source, rate: C3.CASHBACK_RATE, products }];
  },

  // Purchase of a Channel3 product (paid with PayPal) -> estimated commission share -> pot.
  "POST /api/shop/buy": async (b) => {
    const p = shopCache.get(b.productId);
    if (!p) return [400, { error: "Search for the product first" }];
    const cashback = money(p.price * C3.CASHBACK_RATE);
    const route = E.routeCashback(cashback, data);
    const goal = data.goals.find((g) => g.id === route.goal);
    data.pots[goal.pot] = money((data.pots[goal.pot] || 0) + cashback);
    const explanation = await AI.explain("cashback", route);
    log("cashback", `${p.title} ($${p.price}) paid with PayPal. ${explanation}`, { amount: cashback, merchant: p.merchant, source: "channel3" });
    const roundUp = applyRoundUp(p.price, goal.pot);
    return [200, { product: p, route, explanation, roundUp, state: state() }];
  },

  "POST /api/whatif": async (b) => {
    const r = E.whatIfPurchase(Number(b.price), data);
    return [200, { ...r, explanation: await AI.explain("whatif", r) }];
  },

  "GET /api/rates": async () => [200, RATES],

  // Full simulator: spend now, earn more, invest monthly at an official rate.
  "POST /api/whatif/plan": async (b) => {
    const opt = RATES.options.find((o) => o.id === b.option) || RATES.options[0];
    const num = (x) => Math.max(0, Number(x) || 0);
    const r = E.whatIfPlan({ spend: num(b.spend), earn: num(b.earn), invest: num(b.invest), rate: opt.rate, months: num(b.months) || 12 }, data);
    const out = { ...r, optionName: opt.name, source: opt.source, sourceUrl: opt.url, asOf: opt.asOf };
    return [200, { ...out, explanation: await AI.explain("whatifplan", out) }];
  },

  // Structured goal: I want $X by DATE for PURPOSE.
  "POST /api/goal/plan": async (b) => {
    const target = Number(b.amount), deadline = String(b.deadline || ""), purpose = String(b.purpose || "").trim().slice(0, 60);
    if (!(target > 0)) return [400, { error: "Enter an amount above $0" }];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || deadline <= data.user.today) return [400, { error: "Pick a date in the future" }];
    if (!purpose) return [400, { error: "Tell us what it's for" }];
    const months = E.lastMonths(data.user.today, 6);
    const salary = E.safeWeeklySalary(E.incomeStats(E.monthlyIncome(data.transactions, months)), data.settings);
    const priority = Number(b.priority) || 2;
    // Money already promised to goals of the same or higher priority (1 = high).
    const committed = data.goals.filter((g) => (g.priority ?? 2) <= priority)
      .reduce((s, g) => s + E.goalStatus(g, data.pots[g.pot] || 0, data.user.today).neededPerMonth, 0);
    const monthsLeft = Math.max(1, E.monthsBetween(data.user.today, deadline));
    const neededPerMonth = Math.round(target / monthsLeft);
    const free = Math.max(0, Math.round(salary.surplusForGoals - committed));
    const feasible = neededPerMonth <= free;
    let fitsBy = null;
    if (!feasible && free > 0) {
      const d = new Date(data.user.today + "T00:00:00Z");
      d.setUTCMonth(d.getUTCMonth() + Math.ceil(target / free));
      fitsBy = d.toISOString().slice(0, 7);
    }
    const plan = { target, deadline, purpose, neededPerMonth, free, feasible, fitsBy };
    if (b.save) {
      const id = `goal-${Date.now()}`;
      data.goals.push({ id, name: purpose, target, deadline, pot: id, priority: Number(b.priority) || 2 });
      data.pots[id] = 0;
      log("goal", `New goal "${purpose}": $${target} by ${deadline} (about $${neededPerMonth}/month).`);
    }
    return [200, { ...plan, saved: Boolean(b.save), explanation: await AI.explain("goalplan", plan), state: state() }];
  },

  "POST /api/report": async (b) => {
    const r = E.periodReport(data, [1, 3, 6].includes(Number(b.months)) ? Number(b.months) : 1);
    return [200, { ...r, explanation: await AI.explain("period", r) }];
  },

  "POST /api/consultant": async (b) => {
    const r = E.periodReport(data, 6);
    const context = { ...r, forecast: E.forecastNextMonth(data), weeklyPay: data.settings.salaryEnabled ? state().salary.weekly : null, expenses: data.settings.fixedMonthlyExpenses };
    return [200, await AI.consult(b.question, context)];
  },

  "GET /api/report": async () => {
    const r = E.monthlyReport(data);
    return [200, { ...r, explanation: await AI.explain("report", r) }];
  },

  "GET /api/forecast": async () => {
    const f = E.forecastNextMonth(data);
    return [200, { ...f, explanation: await AI.explain("forecast", f) }];
  },

  "POST /api/goal": async (b) => {
    const goal = await AI.interpretGoal(String(b.text || ""), {
      today: data.user.today, rent: data.settings.rent, fixedMonthlyExpenses: data.settings.fixedMonthlyExpenses,
    });
    if (goal.target && goal.deadline && !(goal.missing || []).length) {
      const id = `goal-${Date.now()}`;
      data.goals.push({ id, name: goal.name, target: goal.target, deadline: goal.deadline, pot: id, priority: goal.priority || 2 });
      data.pots[id] = 0;
      log("goal", `New goal "${goal.name}": $${goal.target} by ${goal.deadline}.`);
      return [200, { saved: true, goal, state: state() }];
    }
    return [200, { saved: false, goal, ask: `To set this goal I still need: ${(goal.missing || []).join(", ")}.` }];
  },

  "POST /api/settings": async (b) => {
    for (const k of ["salaryEnabled", "passportEnabled"]) if (k in b) data.settings[k] = Boolean(b[k]);
    return [200, state()];
  },

  // Weekly pay from the user's own reserve. Real Payout when keys + receiver are set.
  "POST /api/salary/pay": async () => {
    if (!data.settings.salaryEnabled) return [400, { error: "Weekly pay is turned off" }];
    const s = state().salary;
    if (data.pots.salaryReserve < s.weekly) return [400, { error: "Reserve too low for this week's pay" }];
    let payout = null;
    if (PP.enabled() && process.env.PAYPAL_PAYOUT_RECEIVER) {
      payout = await PP.createPayout(s.weekly, process.env.PAYPAL_PAYOUT_RECEIVER, "SteadPal weekly pay from your reserve");
    }
    data.pots.salaryReserve = money(data.pots.salaryReserve - s.weekly);
    log("salary", `Weekly pay of $${s.weekly} sent from your reserve.`, { payoutBatch: payout?.batch_header?.payout_batch_id });
    return [200, { paid: s.weekly, payout, state: state() }];
  },

  "POST /api/passport": async (b) => {
    if (!data.settings.passportEnabled) return [400, { error: "Income passport is turned off" }];
    const months = [3, 6, 12, 24].includes(Number(b.months)) ? Number(b.months) : 6;
    const summary = E.passportSummary(data, months, b.threshold ? Number(b.threshold) : undefined);
    if (!summary.ok) return [400, { error: summary.reason }];
    const { excludedFromPassport, ...shareable } = summary; // the excluded list stays private to the user
    shareable.issuedTo = data.user.name;
    shareable.issuedOn = data.user.today;
    const { code, signature } = signPassport(shareable);
    passports.set(code, { summary: shareable, signature, expires: Date.now() + 30 * 24 * 3600 * 1000 });
    log("passport", `Income passport ${code} created (valid 30 days).`);
    return [200, { code, verifyUrl: `/verify?code=${code}`, certificateUrl: `/passport?code=${code}`, summary: shareable, excluded: excludedFromPassport }];
  },

  "POST /api/passport/revoke": async (b) => { passports.delete(String(b.code || "").toUpperCase()); return [200, { revoked: true }]; },
};

// Printable certificate (Download as PDF = the browser's Save as PDF).
function certificatePage(code, host) {
  const p = passports.get(String(code || "").toUpperCase());
  if (!p || Date.now() > p.expires) return verifyPage(code);
  const s = p.summary;
  const usd = (x) => "$" + Number(x).toLocaleString("en-US");
  const verifyUrl = `${host}/verify?code=${encodeURIComponent(code)}`;
  const row = (k, v) => `<div class="fact"><span>${k}</span><b>${v}</b></div>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SteadPal Income Passport ${code}</title><link rel="icon" href="/logo.svg"><link rel="stylesheet" href="/certificate.css">
<div class="actions"><button onclick="window.print()">Download PDF</button><a href="/">Back to SteadPal</a></div>
<main class="cert">
  <header><img src="/logo.svg" alt="" class="logo"><div><div class="brand">SteadPal</div><div class="sub">Income Passport · a feature concept for PayPal</div></div>
  <div class="code"><span>Verification code</span><b>${code}</b></div></header>
  <h1>Income received through PayPal</h1>
  <p class="who">Issued to <b>${s.issuedTo}</b> on ${s.issuedOn}</p>
  <section class="hero">
    <div><span>Monthly average</span><b>${usd(s.monthlyAverage)}</b></div>
    <div><span>Lowest month</span><b>${usd(s.min)}</b></div>
    <div><span>Highest month</span><b>${usd(s.max)}</b></div>
  </section>
  <section class="facts">
    ${row("Period shown", s.period)}
    ${row("History on PayPal", `${s.payPalHistoryMonths} months`)}
    ${row("Consistency", s.monthsAboveThreshold)}
    ${row("Distinct verified clients", s.distinctVerifiedPayers)}
    ${s.scheduledWeeklyPay ? row("Scheduled weekly pay (separate fact, not income)", s.scheduledWeeklyPay.split(" from")[0]) : ""}
  </section>
  <p class="method">Counts only commercial PayPal payments (invoices, goods and services) from verified clients not linked to the holder. Personal transfers and manually entered income are excluded. Facts only: not a credit score and not a guarantee of employment or future income.</p>
  <footer><div>Check this document at<br><b>${verifyUrl}</b></div><div class="seal">Signed<br>${p.signature.slice(0, 16)}…</div></footer>
</main></html>`;
}

function verifyPage(code) {
  const p = passports.get(String(code || "").toUpperCase());
  const ok = p && Date.now() < p.expires && signPassport(p.summary).signature === p.signature;
  const rows = ok ? Object.entries(p.summary).map(([k, v]) => `<tr><th>${k}</th><td>${String(v)}</td></tr>`).join("") : "";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SteadPal passport check</title><link rel="icon" href="/logo.svg"><link rel="stylesheet" href="/style.css">
<main class="verify"><img src="/logo.svg" alt="" width="44"><h1>Income passport check</h1>
${ok ? `<p class="ok">Authentic. Issued by SteadPal from PayPal records, unchanged since it was issued.</p><table>${rows}</table>`
     : `<p class="bad">Not valid: this code is unknown, expired or was revoked.</p>`}
<p class="muted">This page only confirms the document. It shows payments received through PayPal and is not a credit score or a guarantee of future income.</p></main>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const key = `${req.method} ${url.pathname}`;
  try {
    if (routes[key]) {
      const body = req.method === "POST" ? await readBody(req) : {};
      const [status, out] = await routes[key](body);
      return send(res, status, out);
    }
    if (url.pathname === "/verify") return send(res, 200, verifyPage(url.searchParams.get("code")), "text/html; charset=utf-8");
    if (url.pathname === "/passport") {
      const host = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
      return send(res, 200, certificatePage(url.searchParams.get("code"), host), "text/html; charset=utf-8");
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const full = path.join(__dirname, "public", path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
    if (full.startsWith(path.join(__dirname, "public")) && fs.existsSync(full)) {
      const ext = path.extname(full);
      const type = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" }[ext] || "text/plain";
      return send(res, 200, fs.readFileSync(full), type);
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

if (require.main === module) server.listen(PORT, () => console.log(`SteadPal running on http://localhost:${PORT}`));
module.exports = { server, routes };
