// Analysis engine: runway risk (Monte Carlo), reports, investing education, taxes, round-ups.
// Deterministic code only. The AI explains these numbers; it never computes them.
const E = require("./core");

const round = (x, step = 1) => Math.round(x / step) * step;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const DAY = 864e5;
const toDate = (s) => new Date(s + "T00:00:00Z");
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
const nameOf = (data, id) => (data.payers || []).find((p) => p.id === id)?.name || id;
// Evidence behind the "Next month" numbers: every month and payment used, and each step of the math.
function forecastEvidence(data) {
  const months = E.lastMonths(data.user.today, 6);
  const used = new Set(E.statsMonths(data));
  const f = E.forecastNextMonth(data);
  const contractPayers = new Set((data.contracts || []).map((c) => c.payer));
  const rows = months.map((m) => {
    const txs = data.transactions.filter((t) => t.date.slice(0, 7) === m);
    return {
      month: m, total: sum(txs.map((t) => t.amount)), used: used.has(m),
      payments: txs.map((t) => ({ date: t.date, client: nameOf(data, t.payer), amount: t.amount, paypal: t.channel === "paypal", retainer: contractPayers.has(t.payer) })),
    };
  });
  const irregular = rows.filter((r) => r.used).map((r) => sum(r.payments.filter((p) => !p.retainer).map((p) => p.amount)));
  const recurring = sum((data.contracts || []).filter((c) => !(c.endedOn && c.endedOn < data.user.today)).map((c) => c.monthly));
  const overdue = sum((data.openInvoices || []).map((i) => i.amount));
  return {
    rows, average: f.historyMean, usedMonths: rows.filter((r) => r.used).length,
    recurring, irregular, overdue, low: f.low, expected: f.expected, high: f.high, weak: f.weak,
    method: "Low = active retainers + the 25th percentile of your other monthly income. Expected = retainers + the median. High = expected + overdue invoices. Rounded to $50. A month is 'weak' when expected is below 75% of your average.",
  };
}

const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; };

// Seeded random numbers so the demo always shows the same result.
function rng(seed = 42) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- 1. Runway risk check ----------
// Bootstraps 1,000 possible next-N-month paths from the user's own monthly income history.
// Each month: after-tax income comes in, the weekly pay (or fixed expenses) goes out.
// "Safe" = the reserve + emergency fund never drops below zero.
function simulate(data, weekly, horizon, sims, seed) {
  const months = E.statsMonths(data);
  const hist = E.monthlyIncome(data.transactions, months).map((m) => m.amount * (1 - data.settings.taxRate));
  const outPerMonth = weekly ? (weekly * 52) / 12 : data.settings.fixedMonthlyExpenses;
  const overdue = sum((data.openInvoices || []).map((i) => i.amount)) * (1 - data.settings.taxRate);
  const start = (data.pots.salaryReserve || 0) + (data.pots.emergency || 0);
  const r = rng(seed);
  const paths = [];
  let safe = 0;
  for (let s = 0; s < sims; s++) {
    let bal = start, ok = true;
    const path = [];
    for (let m = 0; m < horizon; m++) {
      let inc = hist[Math.floor(r() * hist.length)];
      if (m === 0 && overdue && r() < 0.85) inc += overdue; // late invoice probably arrives
      bal += inc - outPerMonth;
      if (bal < 0) ok = false;
      path.push(bal);
    }
    if (ok) safe++;
    paths.push(path);
  }
  return { probSafe: safe / sims, paths, start, outPerMonth };
}

function runwayRisk(data, opts = {}) {
  const horizon = opts.months || 6, sims = opts.sims || 1000;
  const stats = E.incomeStats(E.monthlyIncome(data.transactions, E.statsMonths(data)));
  const weekly = data.settings.salaryEnabled ? E.safeWeeklySalary(stats, data.settings).weekly : 0;
  const base = simulate(data, weekly, horizon, sims, 42);
  const band = Array.from({ length: horizon }, (_, m) => {
    const col = base.paths.map((p) => p[m]);
    return { month: m + 1, p10: round(quantile(col, 0.1)), p50: round(quantile(col, 0.5)), p90: round(quantile(col, 0.9)) };
  });
  // Highest weekly pay (in $25 steps) that keeps at least 95% of paths safe.
  let safeWeekly = null;
  if (weekly) {
    for (let w = weekly + 100; w >= 0; w -= 25) {
      if (simulate(data, w, horizon, sims, 42).probSafe >= 0.95) { safeWeekly = w; break; }
    }
  }
  const ends = base.paths.map((p) => p[horizon - 1]);
  return {
    months: horizon, simulations: sims, weekly, probSafe: +base.probSafe.toFixed(3),
    startingBuffer: base.start, monthlyOut: round(base.outPerMonth),
    medianEnd: round(quantile(ends, 0.5)), badCaseEnd: round(quantile(ends, 0.1)),
    safeWeeklyAt95: safeWeekly, band,
    method: "Bootstrap of the last 6 months of after-tax income; overdue invoices arrive in month 1 with 85% probability.",
  };
}

// ---------- 2. Client reliability ----------
function clientReliability(data, periodMonths = 6) {
  const months = Array.isArray(periodMonths) ? periodMonths : E.lastMonths(data.user.today, periodMonths);
  const txs = data.transactions.filter((t) => months.includes(t.date.slice(0, 7)));
  const total = sum(txs.map((t) => t.amount));
  const ids = [...new Set(txs.map((t) => t.payer).concat((data.openInvoices || []).map((i) => i.payer)))];
  const rows = ids.map((id) => {
    const mine = txs.filter((t) => t.payer === id);
    const paid = sum(mine.map((t) => t.amount));
    const late = mine.filter((t) => typeof t.daysLate === "number").map((t) => t.daysLate);
    const open = (data.openInvoices || []).filter((i) => i.payer === id);
    const payer = (data.payers || []).find((p) => p.id === id) || {};
    return {
      client: nameOf(data, id), paid, share: total ? +(paid / total).toFixed(2) : 0, payments: mine.length,
      avgDaysLate: late.length ? round(sum(late) / late.length) : null,
      onTimeShare: late.length ? +(late.filter((x) => x <= 3).length / late.length).toFixed(2) : null,
      overdueNow: sum(open.map((i) => i.amount)), viaPayPal: mine.some((t) => t.channel === "paypal"), verified: Boolean(payer.verified),
    };
  }).sort((a, b) => b.paid - a.paid);
  const top = rows[0];
  return { period: `${months[0]} to ${months.at(-1)}`, total, rows, concentration: top ? { client: top.client, share: top.share, high: top.share > 0.5 } : null };
}

// ---------- 3. Taxes ----------
function taxStatus(data) {
  const tp = data.settings.taxProfile || { enabled: false };
  const today = data.user.today;
  const next = (tp.dueDates || []).filter((d) => d >= today).sort()[0] || null;
  const yearStart = today.slice(0, 4) + "-01-01";
  const ytdIncome = sum(data.transactions.filter((t) => t.date >= yearStart && t.date <= today).map((t) => t.amount));
  const paidYtd = sum((data.taxPayments || []).filter((p) => p.date >= yearStart).map((p) => p.amount));
  const estimatedYtd = round(ytdIncome * (data.settings.taxRate || 0));
  return {
    enabled: tp.enabled !== false, profile: tp, setAside: data.pots.tax || 0,
    nextDueDate: next, daysToDue: next ? daysBetween(today, next) : null,
    ytdIncome, estimatedYtd, paidYtd, gap: round(estimatedYtd - paidYtd - (data.pots.tax || 0)),
    rate: data.settings.taxRate, payments: data.taxPayments || [],
  };
}

// ---------- 4. Reports ----------
function cashflow(data, periodMonths) {
  const months = Array.isArray(periodMonths) ? periodMonths : E.lastMonths(data.user.today, periodMonths);
  const series = E.monthlyIncome(data.transactions, months);
  const stats = E.incomeStats(E.monthlyIncome(data.transactions, E.statsMonths(data)));
  const weekly = data.settings.salaryEnabled ? E.safeWeeklySalary(stats, data.settings).weekly : 0;
  const pay = weekly ? round((weekly * 52) / 12) : data.settings.fixedMonthlyExpenses;
  const rows = series.map((m) => {
    const tax = round(m.amount * (data.settings.taxRate || 0));
    return { month: m.month, income: m.amount, taxes: tax, pay, net: m.amount - tax - pay };
  });
  return { rows, totalIn: sum(rows.map((r) => r.income)), totalNet: sum(rows.map((r) => r.net)), negativeMonths: rows.filter((r) => r.net < 0).length, payLabel: weekly ? "weekly pay" : "expenses" };
}

function report(type, data, periodMonths = 3) {
  // periodMonths: a number of months or a list of "YYYY-MM" months
  switch (type) {
    case "clients": return { type, ...clientReliability(data, periodMonths) };
    case "taxes": return { type, ...taxStatus(data) };
    case "goals": return { type, goals: data.goals.map((g) => ({ ...E.goalStatus(g, data.pots[g.pot] || 0, data.user.today), priority: g.priority })) };
    case "cashflow": return { type, ...cashflow(data, periodMonths) };
    default: return { type: "income", ...E.periodReport(data, periodMonths) };
  }
}

// ---------- 5. Investing education + forecasts ----------
function investForecast(rates, { monthly = 100, months = 12, start = 0 } = {}) {
  return rates.options.map((o) => {
    const r = o.rate / 12;
    let bal = start; const path = [];
    for (let m = 1; m <= months; m++) { bal = bal * (1 + r) + monthly; path.push(+bal.toFixed(2)); }
    const contributed = start + monthly * months;
    return { ...o, endValue: round(bal), contributed, interest: round(bal - contributed), path };
  });
}

// ---------- 6. Round-ups ----------
function roundUp(price, step = 1) {
  const up = Math.ceil(price / step - 1e-9) * step;
  return +(up - price).toFixed(2);
}

// Report periods: "1" | "3" | "6" | "12" months, "lastYear" (previous calendar year) or custom "YYYY-MM" to "YYYY-MM".
function resolvePeriod(data, spec = {}) {
  const today = data.user.today;
  if (spec.period === "lastYear") {
    const y = Number(today.slice(0, 4)) - 1;
    return { months: Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`), label: `Calendar year ${y}` };
  }
  if (spec.period === "custom") {
    const ok = (m) => /^\d{4}-\d{2}$/.test(m || "");
    if (!ok(spec.from) || !ok(spec.to)) throw new Error("Choose a start and an end month");
    let [y, m] = spec.from.split("-").map(Number);
    const [ey, em] = spec.to.split("-").map(Number);
    if (y * 12 + m > ey * 12 + em) throw new Error("The start month must be before the end month");
    const months = [];
    while (y * 12 + m <= ey * 12 + em && months.length < 36) { months.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } }
    return { months, label: `${months[0]} to ${months.at(-1)}` };
  }
  const n = [1, 3, 6, 12, 24].includes(Number(spec.period)) ? Number(spec.period) : 3;
  const months = E.lastMonths(today, n);
  return { months, label: n === 1 ? `Last month (${months[0]})` : `Last ${n} months` };
}

module.exports = { forecastEvidence, resolvePeriod, runwayRisk, clientReliability, taxStatus, report, investForecast, roundUp, daysBetween };
