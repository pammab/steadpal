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

const PORT = process.env.PORT || 3000;
const SECRET = process.env.PASSPORT_SECRET || "dev-only-secret-change-me";
const seed = () => JSON.parse(fs.readFileSync(path.join(__dirname, "data", "ana.json"), "utf8"));
let data = seed();
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
    openInvoices: data.openInvoices,
    activity: activity.slice(0, 12),
    paypal: { enabled: PP.enabled(), clientId: process.env.PAYPAL_CLIENT_ID || null },
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

function signPassport(summary) {
  const body = JSON.stringify(summary);
  const signature = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  const code = signature.slice(0, 10).toUpperCase();
  return { code, signature };
}

// ---------- routes ----------
const routes = {
  "GET /api/state": async () => [200, state()],

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
    return [200, { route, explanation, state: state() }];
  },

  "POST /api/whatif": async (b) => {
    const r = E.whatIfPurchase(Number(b.price), data);
    return [200, { ...r, explanation: await AI.explain("whatif", r) }];
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
    return [200, { code, verifyUrl: `/verify?code=${code}`, summary: shareable, excluded: excludedFromPassport }];
  },

  "POST /api/passport/revoke": async (b) => { passports.delete(String(b.code || "").toUpperCase()); return [200, { revoked: true }]; },
};

function verifyPage(code) {
  const p = passports.get(String(code || "").toUpperCase());
  const ok = p && Date.now() < p.expires && signPassport(p.summary).signature === p.signature;
  const rows = ok ? Object.entries(p.summary).map(([k, v]) => `<tr><th>${k}</th><td>${String(v)}</td></tr>`).join("") : "";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SteadPal passport check</title><link rel="stylesheet" href="/style.css">
<main class="verify"><h1>Income passport check</h1>
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
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const full = path.join(__dirname, "public", path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
    if (full.startsWith(path.join(__dirname, "public")) && fs.existsSync(full)) {
      const ext = path.extname(full);
      const type = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" }[ext] || "text/plain";
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
