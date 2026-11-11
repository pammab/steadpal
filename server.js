// SteadPal server. Node.js 22, no external dependencies.
// Run: node server.js  (then open http://localhost:3000)
// Env (all optional for the offline demo):
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET  -> real PayPal sandbox payments and payouts
//   PAYPAL_PAYOUT_RECEIVER                   -> sandbox personal account email that receives steady income payouts
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
const RATES_META = { lastRefresh: null, lastResult: null };
// Live rate refresh: the 3-month Treasury bill comes from FRED (Federal Reserve data, public CSV, no key).
// FDIC national rates are published monthly and the PYUSD reward is set by PayPal: those are updated by hand in data/rates.json.
async function refreshRates() {
  const updated = [], failed = [];
  try {
    const res = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = (await res.text()).trim().split("\n").slice(1).map((l) => l.split(",")).filter((r) => r[1] && r[1] !== ".");
    const [date, val] = rows[rows.length - 1];
    const o = RATES.options.find((x) => x.id === "tbill");
    if (o && Number(val) > 0) { o.rate = +(Number(val) / 100).toFixed(4); o.asOf = date; updated.push(`3-month Treasury bill: ${val}% (${date})`); }
  } catch (e) { failed.push("3-month Treasury bill (FRED): " + e.message); }
  RATES_META.lastRefresh = new Date().toISOString().slice(0, 10);
  RATES_META.lastResult = { updated, failed, manual: ["FDIC savings and CD national averages (published monthly)", "PYUSD reward (set by PayPal)"] };
  return RATES_META.lastResult;
}
const STALE_DAYS = { daily: 1, weekly: 7, monthly: 30 };
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
    if (k === "unassigned" || k === "available") { data.available = money((data.available || 0) + v); continue; }
    const goal = data.goals.find((g) => g.id === k);
    const pot = goal ? goal.pot : k;
    data.pots[pot] = money((data.pots[pot] || 0) + v);
  }
}

// Suggested values: SteadPal proposes, the user decides.
function suggestions() {
  const stats = E.incomeStats(E.monthlyIncome(data.transactions, E.statsMonths(data)));
  const res = E.reserveTarget(stats, data.settings.fixedMonthlyExpenses);
  const sal = E.safeWeeklySalary(stats, data.settings);
  return {
    weeklyPay: sal.suggested, afterTaxMean: sal.afterTaxMean,
    emergencyMonths: res.months, emergencyAmount: res.amount,
    rentTimes3: (data.settings.rent || 0) * 3, expensesTimes3: data.settings.fixedMonthlyExpenses * 3, expensesTimes6: data.settings.fixedMonthlyExpenses * 6,
    irregularity: stats.cv, average: stats.mean,
  };
}

function periodNow() {
  const sal = E.safeWeeklySalary(E.incomeStats(E.monthlyIncome(data.transactions, E.statsMonths(data))), data.settings);
  return E.payPeriod(data.settings, sal.weekly, data.user.today);
}

function state() {
  const report = E.monthlyReport(data);
  const months = E.statsMonths(data);
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
      return { date: t.date, client: p.name || t.payer, amount: t.amount, channel: t.type === "self_reported" ? "Self-reported" : t.channel === "paypal" ? "PayPal" : "Outside PayPal", type: t.type, passport: Boolean(counts) };
    }),
    activity: activity.slice(0, 12),
    tax: A.taxStatus(data),
    suggestions: suggestions(),
    potsSnapshot: data.potsSnapshot || null,
    period: periodNow(),
    wallet: { available: data.available || 0, inPots: Object.values(data.pots).reduce((a, b) => a + b, 0), enabled: data.settings.steadpalEnabled !== false, onboarded: Boolean(data.settings.onboarded) },
    otherIncome: data.transactions.filter((t) => t.type === "self_reported"),
    rates: { asOf: RATES_META.lastRefresh, auto: data.settings.ratesAuto || "weekly" },
    paypal: { enabled: PP.enabled(), invoicing: PP.enabled() && Boolean(INVOICE_TO), clientId: process.env.PAYPAL_CLIENT_ID || null },
    channel3: { enabled: C3.enabled(), cashbackRate: C3.CASHBACK_RATE },
    ai: { enabled: Boolean(process.env.ANTHROPIC_API_KEY), model: AI.MODEL },
  };
}

// Records an incoming client payment and runs the split (shared by demo mode and real PayPal).
async function receivePayment(amount, payerId, source, paypalId) {
  const inv = data.openInvoices.find((i) => i.payer === payerId && Math.abs(i.amount - amount) < 0.01);
  if (inv) data.openInvoices = data.openInvoices.filter((i) => i !== inv);
  if (data.settings.steadpalEnabled === false) {
    // SteadPal is off: PayPal works exactly as before, the whole payment is available to spend.
    data.transactions.push({ date: data.user.today, amount, payer: payerId, channel: "paypal", type: "invoice", paypalId });
    data.available = money((data.available || 0) + amount);
    const explanation = `$${amount} added to your PayPal balance. SteadPal is off, so nothing was split.`;
    log("payment", explanation, { amount, source });
    return { plan: { amount, alloc: { available: amount }, off: true }, explanation };
  }
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
          paypalInvoiceId = await PP.createInvoice({ amount: inv.amount, itemName: `Invoice ${inv.id} (design services)`, note, recipientEmail: INVOICE_TO });
          await PP.sendInvoice(paypalInvoiceId, subject, note);
        } else await PP.remindInvoice(paypalInvoiceId, subject, note);
        inv.paypalInvoiceId = paypalInvoiceId; via = "paypal";
      } catch (e) {
        console.error("[invoicing]", e.message);
        // Show PayPal's reason (no secrets in it) so the problem can be fixed.
        const m = e.message.match(/"(?:issue|name)":"([^"]+)"/g) || [];
        const why = m.map((x) => x.split(":")[1].replace(/"/g, "")).slice(0, 2).join(", ") || e.message.slice(0, 120);
        warning = `PayPal Invoicing failed (${why}). Reminder recorded in demo mode.`;
      }
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
    let per;
    try { per = A.resolvePeriod(data, { period: b.period ?? b.months, from: b.from, to: b.to }); }
    catch (e) { return [400, { error: e.message }]; }
    // Self-reported income (outside PayPal) is included only if the user wants it, and always labelled.
    const includeSelf = b.includeSelf !== false;
    const isSelf = (t) => t.channel !== "paypal";
    const view = includeSelf ? data : { ...data, transactions: data.transactions.filter((t) => !isSelf(t)) };
    const selfTotal = data.transactions.filter((t) => isSelf(t) && per.months.includes(t.date.slice(0, 7))).reduce((a, t) => a + t.amount, 0);
    const r = { ...A.report(type, view, per.months), periodLabel: per.label, includeSelf, selfReportedInPeriod: selfTotal };
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


  // ---------- SteadPal on/off inside the Wallet, and the user's split preferences ----------
  "POST /api/steadpal/toggle": async (b) => {
    if (b.enabled === false) {
      const inPots = Object.values(data.pots).reduce((a, x) => a + x, 0);
      // Remember the last pot values so the user can restore them later.
      data.potsSnapshot = { date: data.user.today, pots: { ...data.pots }, salaryEnabled: data.settings.salaryEnabled, total: money(inPots) };
      data.available = money((data.available || 0) + inPots);
      for (const k of Object.keys(data.pots)) data.pots[k] = 0;
      data.settings.steadpalEnabled = false; data.settings.salaryEnabled = false;
      log("steadpal", `SteadPal turned off. The $${money(inPots)} in your pots is back in your available balance. Your goals and settings are kept.`);
    } else {
      data.settings.steadpalEnabled = true;
      log("steadpal", "SteadPal turned on.");
    }
    return [200, state()];
  },
  "POST /api/steadpal/setup": async (b) => {
    const st = data.settings;
    const tp = st.taxProfile || (st.taxProfile = { federalRate: 0.2, stateRate: 0.05, dueDates: [] });
    if (b.taxRate !== undefined) {
      const r = Number(b.taxRate);
      if (!(r > 0)) tp.enabled = false;
      else { tp.enabled = true; const stRate = Math.min(tp.stateRate || 0, r); tp.stateRate = stRate; tp.federalRate = +(Math.min(0.6, r) - stRate).toFixed(4); }
      st.taxRate = tp.enabled ? +((tp.federalRate || 0) + (tp.stateRate || 0)).toFixed(4) : st.taxRate;
    }
    if (["weekly", "biweekly", "semimonthly", "monthly", "custom"].includes(b.payFrequency)) st.payFrequency = b.payFrequency;
    if (b.payEveryDays !== undefined && Number(b.payEveryDays) > 0) st.payEveryDays = Math.min(90, Math.max(1, Math.round(Number(b.payEveryDays))));
    if (["manual", "automatic"].includes(b.payMode)) st.payMode = b.payMode;
    // Amount per payday (custom) is converted to its weekly equivalent for the engine.
    if (b.payAmount !== undefined && b.payAmount !== "" && b.weeklyPay === undefined) b.weeklyPay = (Number(b.payAmount) * E.payPeriod(st, 1, data.user.today).perYear) / 52;
    if (b.weeklyPay !== undefined) {
      if (b.weeklyPay === "off") { st.salaryEnabled = false; }
      else { st.salaryEnabled = true; if (data.pots.salaryReserve == null) data.pots.salaryReserve = 0; st.weeklyPay = b.weeklyPay === "suggested" ? null : Math.max(1, Math.round(Number(b.weeklyPay)) || 0) || null; }
    }
    if (b.reserveWeeks !== undefined) st.reserveWeeks = Math.min(12, Math.max(1, Math.round(Number(b.reserveWeeks)) || 4));
    if (b.emergencyTarget !== undefined) {
      let g = data.goals.find((x) => x.id === "emergency");
      if (b.emergencyTarget === "none") { if (g) { data.available = money((data.available || 0) + (data.pots.emergency || 0)); data.goals = data.goals.filter((x) => x !== g); delete data.pots.emergency; } }
      else {
        const t = Math.round(Number(b.emergencyTarget));
        if (t > 0) {
          if (!g) { const d = new Date(data.user.today + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 12);
            g = { id: "emergency", name: "Emergency fund", target: t, deadline: d.toISOString().slice(0, 10), pot: "emergency", priority: 1 }; data.goals.unshift(g); data.pots.emergency = data.pots.emergency || 0; }
          g.target = t;
        }
      }
    }
    st.allocation = st.allocation || {};
    if (b.keepAvailablePct !== undefined) st.allocation.keepAvailablePct = Math.min(0.9, Math.max(0, Number(b.keepAvailablePct) || 0));
    if (["available", "emergency", "goals"].includes(b.leftover)) st.allocation.leftover = b.leftover;
    // Up to 5 goals at setup; each becomes a pot.
    const goals = (Array.isArray(b.goals) ? b.goals : b.goal ? [b.goal] : []).slice(0, 5);
    goals.forEach((g, n) => {
      if (!(g && g.name && Number(g.target) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(g.deadline || "") && g.deadline > data.user.today)) return;
      const id = `goal-${Date.now()}-${n}`;
      data.goals.push({ id, name: String(g.name).slice(0, 40), target: Math.round(Number(g.target)), deadline: g.deadline, pot: id, priority: [1, 2, 3].includes(Number(g.priority)) ? Number(g.priority) : 2 });
      data.pots[id] = 0;
    });
    // Restore the pot values saved when SteadPal was switched off, as far as the available balance allows.
    if (b.restore && data.potsSnapshot) {
      const snap = data.potsSnapshot.pots;
      const want = Object.entries(snap).filter(([k]) => k in data.pots || k === "salaryReserve" || data.goals.some((g) => g.pot === k));
      const total = want.reduce((a, [, v]) => a + v, 0);
      const ratio = total > 0 ? Math.min(1, (data.available || 0) / total) : 0;
      for (const [k, v] of want) { const amt = money(v * ratio); data.pots[k] = money((data.pots[k] || 0) + amt); data.available = money(data.available - amt); }
      if (data.potsSnapshot.salaryEnabled && b.weeklyPay !== "off") data.settings.salaryEnabled = true;
      log("steadpal", ratio < 1 ? `Pots restored to ${Math.round(ratio * 100)}% of their ${data.potsSnapshot.date} values (not enough available balance for all of it).` : `Pots restored to their values from ${data.potsSnapshot.date}.`);
      data.potsSnapshot = null;
    }
    if (b.finish) { st.onboarded = true; st.steadpalEnabled = true; log("steadpal", "SteadPal is set up with your choices. You can change them anytime in Profile."); }
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
    const goal = data.goals.find((g) => g.id === route.goal) || { pot: "emergency" };
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
    const goal = data.goals.find((g) => g.id === route.goal) || { pot: "emergency" };
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

  "GET /api/rates": async () => {
    // Auto-refresh on the user's chosen schedule (off / daily / weekly / monthly).
    const days = STALE_DAYS[data.settings.ratesAuto];
    const age = RATES_META.lastRefresh ? (Date.now() - new Date(RATES_META.lastRefresh)) / 864e5 : Infinity;
    if (days && age >= days) await refreshRates();
    return [200, { ...RATES, lastRefresh: RATES_META.lastRefresh, lastResult: RATES_META.lastResult, auto: data.settings.ratesAuto }];
  },

  // Full simulator: spend now, earn more, invest monthly at an official rate.
  "POST /api/whatif/plan": async (b) => {
    const num = (x) => Math.max(0, Number(x) || 0);
    const r = E.whatIfPlan({ spend: num(b.spend), earn: num(b.earn), costs: num(b.costs) }, data);
    return [200, { ...r, explanation: await AI.explain("whatifplan", r) }];
  },

  // Structured goal: I want $X by DATE for PURPOSE.
  "POST /api/goal/plan": async (b) => {
    const target = Number(b.amount), deadline = String(b.deadline || ""), purpose = String(b.purpose || "").trim().slice(0, 60);
    if (!(target > 0)) return [400, { error: "Enter an amount above $0" }];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || deadline <= data.user.today) return [400, { error: "Pick a date in the future" }];
    if (!purpose) return [400, { error: "Tell us what it's for" }];
    const months = E.statsMonths(data);
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
    const about = data.settings.aboutMe || {};
    const context = { ...r, forecast: E.forecastNextMonth(data), weeklyPay: data.settings.salaryEnabled ? state().salary.weekly : null, expenses: data.settings.fixedMonthlyExpenses,
      rent: data.settings.rent, aboutMe: about.share ? { risk: about.risk, workType: about.workType, clients: about.clients, slowMonths: about.slowMonths, otherJob: about.otherJob, priority: about.priority, style: about.style, yearsFreelancing: about.yearsFreelancing } : "not shared" };
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
    if (data.settings.salaryEnabled && data.pots.salaryReserve == null) data.pots.salaryReserve = 0;
    if (Array.isArray(b.excludedMonths)) data.settings.excludedMonths = b.excludedMonths.filter((m) => /^\d{4}-\d{2}$/.test(m)).slice(0, 5);
    if (["off", "daily", "weekly", "monthly"].includes(b.ratesAuto)) data.settings.ratesAuto = b.ratesAuto;
    return [200, state()];
  },

  // ---------- Profile: the user's own numbers (SteadPal only suggests) ----------
  "POST /api/profile/numbers": async (b) => {
    const pos = (x) => (x === "" || x == null ? null : Math.max(0, Math.round(Number(x)) || 0));
    if (b.rent !== undefined) data.settings.rent = pos(b.rent) ?? data.settings.rent;
    if (b.expenses !== undefined) data.settings.fixedMonthlyExpenses = pos(b.expenses) ?? data.settings.fixedMonthlyExpenses;
    if (b.weeklyPay !== undefined) data.settings.weeklyPay = pos(b.weeklyPay) || null; // empty = use the suggestion
    if (b.payAmount !== undefined) { const a = pos(b.payAmount); data.settings.weeklyPay = a ? Math.round((a * E.payPeriod(data.settings, 1, data.user.today).perYear) / 52) : null; }
    if (b.reserveWeeks !== undefined) data.settings.reserveWeeks = Math.min(12, Math.max(1, Math.round(Number(b.reserveWeeks)) || 4));
    if (b.emergencyTarget !== undefined) {
      const g = data.goals.find((x) => x.id === "emergency");
      const t = pos(b.emergencyTarget);
      if (g && t) g.target = t;
    }
    log("profile", "Your numbers were updated.");
    return [200, state()];
  },
  "POST /api/profile/about": async (b) => {
    const a = data.settings.aboutMe || (data.settings.aboutMe = {});
    const pick = (v, ok) => (ok.includes(v) ? v : "");
    a.share = Boolean(b.share);
    a.risk = pick(b.risk, ["cautious", "balanced", "adventurous"]);
    a.workType = String(b.workType || "").slice(0, 60);
    a.clients = pick(b.clients, ["1", "2-3", "4-6", "7+"]);
    a.slowMonths = (Array.isArray(b.slowMonths) ? b.slowMonths : []).filter((m) => /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(m));
    a.otherJob = pick(b.otherJob, ["yes", "no"]);
    a.priority = pick(b.priority, ["steady pay", "safety cushion", "goals", "growing savings"]);
    a.style = pick(b.style, ["short", "detailed"]);
    a.yearsFreelancing = pick(b.yearsFreelancing, ["<1", "1-3", "3-5", "5+"]);
    return [200, state()];
  },
  // Self-reported income (outside PayPal): counted in reports only when the user includes it; never in the passport.
  "POST /api/income/self": async (b) => {
    const amount = Math.round(Number(b.amount));
    const date = String(b.date || "");
    const source = String(b.source || "").trim().slice(0, 40);
    if (!(amount > 0)) return [400, { error: "Enter an amount above $0" }];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > data.user.today) return [400, { error: "Pick a date that is not in the future" }];
    if (!source) return [400, { error: "Where did it come from?" }];
    const id = "self-" + source.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (!data.payers.find((p) => p.id === id)) data.payers.push({ id, name: source, verified: false, linkedToUser: false, accountAgeDays: null });
    data.transactions.push({ date, amount, payer: id, channel: "manual", type: "self_reported", ref: "sr-" + Date.now() });
    log("income", `Self-reported income added: $${amount} from ${source} (${date}). Not verified by PayPal.`);
    return [200, state()];
  },
  // Import self-reported income from a CSV the user exported elsewhere (bank, Etsy, Venmo...). No new connections.
  "POST /api/income/self/import": async (b) => {
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 500);
    let added = 0; const skipped = [];
    for (const r of rows) {
      const amount = Math.round(Number(r.amount) * 100) / 100, date = String(r.date || ""), source = String(r.source || "Imported").trim().slice(0, 40) || "Imported";
      if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > data.user.today) { skipped.push(r); continue; }
      const id = "self-" + source.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (!data.payers.find((p) => p.id === id)) data.payers.push({ id, name: source, verified: false, linkedToUser: false, accountAgeDays: null });
      data.transactions.push({ date, amount, payer: id, channel: "manual", type: "self_reported", ref: "sr-" + Date.now() + "-" + added });
      added++;
    }
    log("income", `${added} self-reported payment${added === 1 ? "" : "s"} imported${skipped.length ? `, ${skipped.length} skipped (no date, a future date or not an amount received)` : ""}. Not verified by PayPal.`);
    return [200, { added, skipped: skipped.length, state: state() }];
  },
  "POST /api/income/self/delete": async (b) => {
    data.transactions = data.transactions.filter((t) => t.ref !== b.ref);
    return [200, state()];
  },

  // ---------- Pots: every pot except Taxes can be edited or deleted ----------
  "POST /api/pots/update": async (b) => {
    if (b.id === "tax") return [400, { error: "The tax pot follows your tax settings in Profile" }];
    if (b.id === "salaryReserve") {
      if (b.reserveWeeks) data.settings.reserveWeeks = Math.min(12, Math.max(1, Math.round(Number(b.reserveWeeks))));
      return [200, state()];
    }
    const g = data.goals.find((x) => x.id === b.id);
    if (!g) return [404, { error: "Pot not found" }];
    if (b.name) g.name = String(b.name).trim().slice(0, 40) || g.name;
    if (Number(b.target) > 0) g.target = Math.round(Number(b.target));
    if (/^\d{4}-\d{2}-\d{2}$/.test(b.deadline || "") && b.deadline > data.user.today) g.deadline = b.deadline;
    if ([1, 2, 3].includes(Number(b.priority))) g.priority = Number(b.priority);
    log("pot", `"${g.name}" updated: $${g.target} by ${g.deadline}.`);
    return [200, state()];
  },
  "POST /api/pots/pyusd": async (b) => {
    // Concept: hold a pot in PYUSD (PayPal USD stablecoin, 1 PYUSD = 1 USD) inside the same PayPal balance.
    if (!(b.id in data.pots)) return [404, { error: "Pot not found" }];
    data.settings.pyusdPots = data.settings.pyusdPots || {};
    const on = Boolean(b.on);
    if (on) data.settings.pyusdPots[b.id] = true; else delete data.settings.pyusdPots[b.id];
    const g = data.goals.find((x) => x.pot === b.id || x.id === b.id);
    const name = g ? g.name : ({ tax: "Taxes", salaryReserve: "Income reserve", emergency: "Emergency fund", available: "Available to spend" })[b.id] || b.id;
    log("pot", on ? `"${name}" ($${data.pots[b.id]}) now held in PYUSD, 1:1 with USD. Not FDIC-insured.` : `"${name}" switched back to USD.`);
    return [200, state()];
  },
  "POST /api/pyusd/apply": async (b) => {
    // Several pots at once: amount "all" or a dollar amount (capped at the pot); 0 = back to USD.
    data.settings.pyusdPots = data.settings.pyusdPots || {};
    const done = [];
    for (const it of Array.isArray(b.items) ? b.items : []) {
      if (!(it.id in data.pots)) continue;
      if (it.amount === "all") data.settings.pyusdPots[it.id] = true;
      else { const a = Math.max(0, Math.round(Number(it.amount) || 0)); if (a) data.settings.pyusdPots[it.id] = a; else delete data.settings.pyusdPots[it.id]; }
      done.push(it.id);
    }
    if (done.length) log("pot", `PYUSD updated for ${done.length} pot${done.length > 1 ? "s" : ""}. 1 PYUSD = 1 USD; not FDIC-insured.`);
    return [200, state()];
  },
  "POST /api/pots/delete": async (b) => {
    if (b.id === "tax") return [400, { error: "The tax pot can't be deleted; turn tax set-aside off in Profile instead" }];
    const amount = data.pots[b.id] || 0;
    if (b.id === "salaryReserve") return [400, { error: "The income reserve can't be deleted; pause it instead" }];
    else {
      const g = data.goals.find((x) => x.id === b.id);
      if (!g) return [404, { error: "Pot not found" }];
      data.goals = data.goals.filter((x) => x !== g);
      delete data.pots[g.pot];
    }
    log("pot", `Pot deleted. Its $${amount} stays in your PayPal balance.`);
    return [200, state()];
  },
  "POST /api/pots/duplicate": async (b) => {
    const g = data.goals.find((x) => x.id === b.id);
    if (!g) return [400, { error: "Only goal pots can be duplicated" }];
    const id = `goal-${Date.now()}`;
    data.goals.push({ id, name: `${g.name} (copy)`.slice(0, 40), target: g.target, deadline: g.deadline, pot: id, priority: g.priority ?? 2 });
    data.pots[id] = 0;
    log("pot", `"${g.name}" duplicated. The copy starts at $0.`);
    return [200, { newId: id, state: state() }];
  },
  "POST /api/pots/create": async (b) => {
    const name = String(b.name || "").trim().slice(0, 40), target = Math.round(Number(b.target));
    if (!name || !(target > 0)) return [400, { error: "Give the pot a name and an amount" }];
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(b.deadline || "") && b.deadline > data.user.today ? b.deadline : null;
    if (!deadline) return [400, { error: "Pick a date in the future" }];
    const id = `goal-${Date.now()}`;
    data.goals.push({ id, name, target, deadline, pot: id, priority: [1, 2, 3].includes(Number(b.priority)) ? Number(b.priority) : 2 });
    data.pots[id] = 0;
    return [200, state()];
  },

  // ---------- Evidence behind the numbers ----------
  "GET /api/evidence/forecast": async () => [200, A.forecastEvidence(data)],

  // ---------- Rates ----------
  "POST /api/rates/refresh": async () => [200, { result: await refreshRates(), options: RATES.options, lastRefresh: RATES_META.lastRefresh }],

  // Steady income from the user's own reserve, on the frequency they chose. Real Payout when keys + receiver are set
  // (in the sandbox it goes to a test account; inside PayPal it would just move from the reserve label to Available).
  "POST /api/salary/pay": async () => {
    if (!data.settings.salaryEnabled) return [400, { error: "Steady income is paused" }];
    const pp = periodNow();
    if ((data.pots.salaryReserve || 0) < pp.amount) return [400, { error: "The income reserve is too low for this payday" }];
    let payout = null;
    if (PP.enabled() && process.env.PAYPAL_PAYOUT_RECEIVER) {
      payout = await PP.createPayout(pp.amount, process.env.PAYPAL_PAYOUT_RECEIVER, "SteadPal income from your reserve");
    }
    data.pots.salaryReserve = money(data.pots.salaryReserve - pp.amount);
    data.available = money((data.available || 0) + pp.amount);
    log("salary", `${pp.title}: $${pp.amount} moved from your income reserve to Available to spend${pp.mode === "automatic" ? " (automatic payday)" : ""}.`, { payoutBatch: payout?.batch_header?.payout_batch_id });
    return [200, { paid: pp.amount, period: pp, payout, state: state() }];
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
    // The holder chooses whether viewers may ask about the main clients. Client names are never printed.
    passports.set(code, { summary: shareable, signature, expires: Date.now() + 30 * 24 * 3600 * 1000, allowRequests: Boolean(b.allowRequests), requests: [] });
    log("passport", `Income passport ${code} created (valid 30 days).`);
    return [200, { code, verifyUrl: `/verify?code=${code}`, certificateUrl: `/passport?code=${code}`, summary: shareable, excluded: excludedFromPassport, allowRequests: Boolean(b.allowRequests) }];
  },

  // A viewer (e.g. a landlord) asks the holder about the main clients. The holder decides what to share.
  "POST /api/passport/request": async (b) => {
    const p = passports.get(String(b.code || "").toUpperCase());
    if (!p || Date.now() > p.expires) return [404, { error: "This passport is not valid" }];
    if (!p.allowRequests) return [403, { error: "The holder has not enabled questions on this passport" }];
    const name = String(b.name || "").trim().slice(0, 60), org = String(b.org || "").trim().slice(0, 60), message = String(b.message || "").trim().slice(0, 300);
    if (!name || !message) return [400, { error: "Please add your name and a short question" }];
    p.requests.push({ at: new Date().toISOString(), name, org, message });
    log("passport", `${name}${org ? ` (${org})` : ""} asked about the clients on passport ${String(b.code).toUpperCase()}: "${message}". You decide what to share.`);
    return [200, { sent: true }];
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
  <header><img src="/logo.svg" alt="" class="logo"><div><div class="brand">SteadPal</div><div class="sub">Income Passport · a feature concept for PayPal</div><div class="sub" style="color:#2470e6;font-weight:600">Click PayPal. Build your future.</div><div class="sub" style="color:#3b4a6b;font-style:italic">Every dollar through PayPal works for you.</div></div>
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
    ${s.clientConcentration ? row("Largest client / largest 2", `${Math.round(s.clientConcentration.top1Share * 100)}% / ${Math.round(s.clientConcentration.top2Share * 100)}% of income`) : ""}
    ${s.scheduledWeeklyPay ? row("Scheduled steady income (separate fact, not income)", s.scheduledWeeklyPay.split(" from")[0]) : ""}
  </section>
  ${s.clientConcentration && s.clientConcentration.flag ? `<p class="conc"><b>Note:</b> ${s.clientConcentration.text}${p.allowRequests ? " The holder accepts questions about these clients at the verification link below." : ""}</p>` : ""}
  <p class="method">Counts only commercial PayPal payments (invoices, goods and services) from verified clients not linked to the holder. Personal transfers and manually entered income are excluded. Facts only: not a credit score and not a guarantee of employment or future income.</p>
  <footer><div>Check this document at<br><b>${verifyUrl}</b></div><div class="seal">Signed<br>${p.signature.slice(0, 16)}…</div></footer>
</main></html>`;
}

const PASSPORT_LABELS = {
  issuedTo: "Issued to", issuedOn: "Issued on", period: "Period shown", payPalHistoryMonths: "History on PayPal (months)",
  monthlyAverage: "Monthly average ($)", min: "Lowest month ($)", max: "Highest month ($)", monthsAboveThreshold: "Consistency",
  distinctVerifiedPayers: "Distinct verified clients", scheduledWeeklyPay: "Scheduled steady income", note: "Note",
};
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function verifyPage(code) {
  const cd = String(code || "").toUpperCase();
  const p = passports.get(cd);
  const ok = p && Date.now() < p.expires && signPassport(p.summary).signature === p.signature;
  const rows = ok ? Object.entries(p.summary).filter(([k]) => k !== "ok" && k !== "clientConcentration")
    .map(([k, v]) => `<tr><th>${PASSPORT_LABELS[k] || k}</th><td>${esc(v)}</td></tr>`).join("") : "";
  const cc = ok && p.summary.clientConcentration;
  const form = ok && p.allowRequests ? `<form class="askform" id="ask"><h2>Ask the holder about these clients</h2>
    <p class="muted">The holder chose to accept questions. Your request goes to them; they decide what to share. Client names are never shown here.</p>
    <input name="name" placeholder="Your name" required maxlength="60"><input name="org" placeholder="Organization (optional)" maxlength="60">
    <textarea name="message" rows="3" maxlength="300" required placeholder="e.g. Could you share who your two main clients are and how long you have worked with them?"></textarea>
    <button class="btn">Send request</button><p id="askMsg" class="muted"></p></form>
    <script>document.getElementById("ask").onsubmit=async(e)=>{e.preventDefault();const f=new FormData(e.target);
      const r=await fetch("/api/passport/request",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:${JSON.stringify(cd)},name:f.get("name"),org:f.get("org"),message:f.get("message")})});
      const j=await r.json();document.getElementById("askMsg").textContent=r.ok?"Sent. The holder will decide what to share with you.":j.error;if(r.ok)e.target.reset();};</script>` : "";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SteadPal passport check</title><link rel="icon" href="/logo.svg"><link rel="stylesheet" href="/style.css">
<main class="verify"><img src="/logo.svg" alt="" width="44"><h1>Income passport check</h1>
${ok ? `<p class="ok">Authentic. Issued by SteadPal from PayPal records, unchanged since it was issued.</p><table>${rows}</table>
  ${cc ? `<div class="note ${cc.flag ? "" : "soft"}"><b>Client concentration:</b> ${esc(cc.text)}</div>` : ""}${form}`
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
      const type = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".mp3": "audio/mpeg" }[ext] || "text/plain";
      if (ext === ".mp3") {
        // Audio: support byte ranges so the browser can jump to any step of the narration.
        const buf = fs.readFileSync(full), m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
        if (m) {
          const start = m[1] ? Number(m[1]) : 0, end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
          res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${buf.length}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Cache-Control": "public, max-age=3600" });
          return res.end(buf.subarray(start, end + 1));
        }
        res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": buf.length, "Cache-Control": "public, max-age=3600" });
        return res.end(buf);
      }
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
