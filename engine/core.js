// SteadPal decision engine.
// Principle: "the AI decides, the code verifies".
// Everything in this file is deterministic math: statistics, forecasts, reserve sizing,
// split planning and validation. The LLM layer (llm.js) only interprets goals,
// adjusts priorities within the limits set here, and explains decisions in plain language.

const DAY = 24 * 60 * 60 * 1000;

// ---------- helpers ----------
const toDate = (s) => new Date(s + "T00:00:00Z");
const monthKey = (d) => d.toISOString().slice(0, 7); // "2026-03"
const round = (x, step = 1) => Math.round(x / step) * step;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);
const sd = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
};
const percentile = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Last n full calendar months before `today`, oldest first.
function lastMonths(today, n) {
  const t = toDate(today);
  const out = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - i, 1));
    out.push(monthKey(d));
  }
  return out;
}

// ---------- income ----------
// filter: (tx) => boolean, e.g. only PayPal commercial payments for the passport.
function monthlyIncome(transactions, months, filter = () => true) {
  const byMonth = Object.fromEntries(months.map((m) => [m, 0]));
  for (const tx of transactions) {
    if (!filter(tx)) continue;
    const k = tx.date.slice(0, 7);
    if (k in byMonth) byMonth[k] += tx.amount;
  }
  return months.map((m) => ({ month: m, amount: byMonth[m] }));
}

function incomeStats(series) {
  const xs = series.map((s) => s.amount);
  const m = mean(xs);
  return {
    months: xs.length,
    mean: round(m),
    min: Math.min(...xs),
    max: Math.max(...xs),
    sd: round(sd(xs)),
    cv: m ? +(sd(xs) / m).toFixed(2) : 0, // coefficient of variation = irregularity
    p25: round(percentile(xs, 0.25)),
  };
}

// ---------- forecast ----------
// Explainable forecast for the next month: low / expected / high + the reasons.
function forecastNextMonth(data) {
  const { transactions, contracts = [], openInvoices = [], user } = data;
  const nameOf = (id) => (data.payers || []).find((p) => p.id === id)?.name || id;
  const months = lastMonths(user.today, 6);
  const series = monthlyIncome(transactions, months);
  const stats = incomeStats(series);
  const today = toDate(user.today);
  const signals = [];

  // Recurring income still active (retainers that have not ended).
  let recurring = 0;
  for (const c of contracts) {
    if (c.endedOn && toDate(c.endedOn) < today) {
      signals.push({ type: "contract_ended", payer: nameOf(c.payer), monthly: c.monthly, endedOn: c.endedOn });
    } else recurring += c.monthly;
  }

  // Overdue invoices: likely to arrive, but late.
  let overdue = 0;
  for (const inv of openInvoices) {
    const daysLate = Math.round((today - toDate(inv.dueDate)) / DAY);
    if (daysLate > 0) {
      overdue += inv.amount;
      signals.push({ type: "invoice_overdue", payer: nameOf(inv.payer), amount: inv.amount, daysLate });
    }
  }

  // Irregular (non-contract) income: conservative = 25th percentile of past non-contract months.
  const contractPayers = new Set(contracts.map((c) => c.payer));
  const irregular = monthlyIncome(transactions, months, (tx) => !contractPayers.has(tx.payer)).map((s) => s.amount);
  const irregularLow = percentile(irregular, 0.25);
  const irregularMid = percentile(irregular, 0.5);

  const low = round(recurring + irregularLow, 50);
  const expected = round(recurring + irregularMid, 50);
  const high = round(recurring + irregularMid + overdue, 50);
  const weak = expected < stats.mean * 0.75;
  return { low, expected, high, weak, historyMean: stats.mean, signals };
}

// ---------- actuarial reserve & salary ----------
// Emergency target in months of fixed expenses grows with income irregularity (cv).
function reserveTarget(stats, fixedMonthlyExpenses) {
  const months = clamp(1 + 3 * stats.cv, 1, 6);
  return { months: +months.toFixed(1), amount: round(months * fixedMonthlyExpenses, 50) };
}

// Safe weekly salary: based on after-tax mean income, never above it, never below expenses
// unless income can't cover them (then flag). Rounded to $25.
function safeWeeklySalary(stats, settings) {
  const afterTaxMean = stats.mean * (1 - settings.taxRate);
  const afterTaxP25 = stats.p25 * (1 - settings.taxRate);
  // Cover fixed expenses with a 3% margin, but never more than 90% of the after-tax average.
  const monthly = clamp(settings.fixedMonthlyExpenses * 1.03, 0, afterTaxMean * 0.9);
  const weekly = round((monthly * 12) / 52, 25);
  return {
    weekly,
    monthlyEquivalent: round((weekly * 52) / 12),
    afterTaxMean: round(afterTaxMean),
    sustainable: (weekly * 52) / 12 <= afterTaxMean,
    coveredEvenInWeakMonths: (weekly * 52) / 12 <= afterTaxP25,
    surplusForGoals: round(afterTaxMean - (weekly * 52) / 12),
  };
}

// ---------- goals ----------
function monthsBetween(a, b) {
  const d1 = toDate(a), d2 = toDate(b);
  return (d2.getUTCFullYear() - d1.getUTCFullYear()) * 12 + (d2.getUTCMonth() - d1.getUTCMonth());
}

function goalStatus(goal, saved, today) {
  const remaining = Math.max(0, goal.target - saved);
  const monthsLeft = Math.max(1, monthsBetween(today, goal.deadline));
  return {
    id: goal.id,
    name: goal.name,
    deadline: goal.deadline,
    saved,
    target: goal.target,
    remaining,
    monthsLeft,
    neededPerMonth: round(remaining / monthsLeft),
    progress: +(saved / goal.target).toFixed(2),
  };
}

// ---------- split planner ----------
// Splits one incoming payment. Order of priorities (the LLM may reorder goals, never the
// first two): 1) taxes, 2) refill the salary reserve if the salary feature is on,
// 3) emergency boost when a weak month is forecast, 4) goals by urgency.
function planSplit(amount, data, opts = {}) {
  const { settings, pots, goals, user } = data;
  const months = lastMonths(user.today, 6);
  const stats = incomeStats(monthlyIncome(data.transactions, months));
  const salary = safeWeeklySalary(stats, settings);
  const forecast = forecastNextMonth(data);
  const reasons = [];
  const alloc = {};

  // 1) taxes (fixed rate, estimate, not tax advice)
  alloc.tax = round(amount * settings.taxRate);
  let left = amount - alloc.tax;
  reasons.push({ step: "tax", rate: settings.taxRate });

  // 2) salary reserve: keep `reserveWeeks` of salary ready
  if (settings.salaryEnabled) {
    const reserveWeeks = opts.reserveWeeks ?? 4;
    const targetReserve = salary.weekly * reserveWeeks;
    const deficit = Math.max(0, targetReserve - pots.salaryReserve);
    const cap = forecast.weak ? 0.75 : 0.5; // in a weak month the reserve gets more
    alloc.salaryReserve = round(Math.min(deficit, left * cap));
    left -= alloc.salaryReserve;
    reasons.push({ step: "salaryReserve", targetReserve, deficit, cap, weakMonth: forecast.weak });
  }

  // 3+4) goals by urgency: needed-per-month relative to what's been saved
  const ordered = (opts.goalOrder || goals.map((g) => g.id))
    .map((id) => goals.find((g) => g.id === id))
    .filter(Boolean);
  const statuses = ordered.map((g) => goalStatus(g, pots[g.pot] || 0, user.today));
  if (forecast.weak) {
    // weak month ahead: everything left goes to the emergency goal first
    statuses.sort((a, b) => (a.id === "emergency" ? -1 : b.id === "emergency" ? 1 : 0));
  }
  for (const g of statuses) {
    if (left <= 0) break;
    const give = round(Math.min(left, Math.max(g.neededPerMonth, forecast.weak && g.id === "emergency" ? left : 0)));
    if (give > 0) {
      alloc[g.id] = (alloc[g.id] || 0) + give;
      left -= give;
    }
  }
  if (left > 0) alloc.unassigned = round(left); // stays in the main balance, user decides

  const plan = { amount, alloc, forecast, salary, reasons };
  validatePlan(plan, settings);
  return plan;
}

// Code verifies whatever the AI proposes.
function validatePlan(plan, settings) {
  const vals = Object.values(plan.alloc);
  if (vals.some((v) => v < 0)) throw new Error("negative allocation");
  const total = sum(vals);
  if (Math.abs(total - plan.amount) > 1) throw new Error(`split ${total} != payment ${plan.amount}`);
  if (plan.alloc.tax < round(plan.amount * settings.taxRate) - 1) throw new Error("tax below minimum");
  return true;
}

// ---------- cashback router ----------
// Cashback from partner merchants goes to the goal most behind its schedule.
// Rule: in a weak month the emergency goal comes first; otherwise the highest-priority
// goal that is behind schedule (saved < what it should have by now), then lowest progress.
function routeCashback(cashback, data) {
  const fc = forecastNextMonth(data);
  const statuses = data.goals.map((g) => ({
    ...goalStatus(g, data.pots[g.pot] || 0, data.user.today),
    priority: g.priority ?? 9,
  }));
  let pick = fc.weak ? statuses.find((s) => s.id === "emergency") : null;
  if (!pick) {
    pick = [...statuses].sort((a, b) => a.priority - b.priority || a.progress - b.progress)[0];
  }
  return {
    amount: cashback,
    goal: pick.id,
    goalName: pick.name,
    progress: pick.progress,
    reason: fc.weak ? "weak month forecast: emergency fund first" : "highest-priority goal behind schedule",
  };
}

// ---------- what-if simulator ----------
function whatIfPurchase(price, data) {
  const months = lastMonths(data.user.today, 6);
  const stats = incomeStats(monthlyIncome(data.transactions, months));
  const salary = safeWeeklySalary(stats, data.settings);
  const perMonth = Math.max(1, salary.surplusForGoals);
  const emergency = data.goals.find((g) => g.id === "emergency");
  const st = goalStatus(emergency, data.pots[emergency.pot] || 0, data.user.today);
  const monthsNow = Math.ceil(st.remaining / perMonth);
  const monthsAfter = Math.ceil((st.remaining + price) / perMonth);
  return {
    price,
    surplusPerMonth: perMonth,
    emergencyMonthsNow: monthsNow,
    emergencyMonthsIfBought: monthsAfter,
    delayMonths: monthsAfter - monthsNow,
  };
}

// ---------- income passport ----------
// Facts only. Counts PayPal commercial payments (invoices, goods & services) from
// distinct, verified payers that are not linked to the user. No scores, no labels.
const COMMERCIAL = new Set(["invoice", "goods_services"]);

function passportSummary(data, periodMonths = 6, threshold) {
  const payers = Object.fromEntries(data.payers.map((p) => [p.id, p]));
  const excluded = [];
  const eligible = (tx) => {
    const p = payers[tx.payer] || {};
    let why = null;
    if (tx.channel !== "paypal") why = "not received through PayPal";
    else if (!COMMERCIAL.has(tx.type)) why = "personal transfer, not a commercial payment";
    else if (!p.verified) why = "payer not verified";
    else if (p.linkedToUser) why = "payer account linked to the user";
    else if ((p.accountAgeDays ?? 0) < 30) why = "payer account too new";
    if (why) excluded.push({ date: tx.date, amount: tx.amount, why });
    return !why;
  };
  const months = lastMonths(data.user.today, periodMonths);
  const series = monthlyIncome(data.transactions, months, eligible);
  const st = incomeStats(series);
  const firstPayPal = data.transactions.filter((t) => t.channel === "paypal").map((t) => t.date).sort()[0];
  const historyMonths = firstPayPal ? monthsBetween(firstPayPal, data.user.today) : 0;
  const thr = threshold ?? round(st.mean, 500);
  const distinctPayers = new Set(
    data.transactions.filter((t) => months.includes(t.date.slice(0, 7)) && eligible(t)).map((t) => t.payer)
  );
  excluded.length = 0; // recount once, cleanly
  data.transactions.filter((t) => months.includes(t.date.slice(0, 7))).forEach(eligible);

  if (historyMonths < 3) return { ok: false, reason: "At least 3 months of PayPal income are needed." };
  const out = {
    ok: true,
    period: `last ${periodMonths} months (${months[0]} to ${months[months.length - 1]})`,
    payPalHistoryMonths: historyMonths,
    monthlyAverage: st.mean,
    min: st.min,
    max: st.max,
    monthsAboveThreshold: `${series.filter((s) => s.amount > thr).length} of ${series.length} months above $${thr}`,
    distinctVerifiedPayers: distinctPayers.size,
    excludedFromPassport: excluded,
    note: "Shows payments received through PayPal. Not a guarantee of employment or future income.",
  };
  if (data.settings.salaryEnabled) {
    const salary = safeWeeklySalary(incomeStats(monthlyIncome(data.transactions, months)), data.settings);
    out.scheduledWeeklyPay = `$${salary.weekly}/week from the user's own reserve (separate fact, not income)`;
  }
  return out;
}

// ---------- monthly report ----------
function monthlyReport(data) {
  const months = lastMonths(data.user.today, 6);
  const series = monthlyIncome(data.transactions, months);
  const stats = incomeStats(series);
  const last = series[series.length - 1];
  return {
    month: last.month,
    income: last.amount,
    vsAverage: last.amount - stats.mean,
    stats,
    reserve: reserveTarget(stats, data.settings.fixedMonthlyExpenses),
    goals: data.goals.map((g) => goalStatus(g, data.pots[g.pot] || 0, data.user.today)),
    forecast: forecastNextMonth(data),
  };
}

module.exports = {
  lastMonths, monthlyIncome, incomeStats, forecastNextMonth, reserveTarget, safeWeeklySalary,
  goalStatus, planSplit, validatePlan, routeCashback, whatIfPurchase, passportSummary, monthlyReport,
};
