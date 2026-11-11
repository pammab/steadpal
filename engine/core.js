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
// The months behind "your 6-month average": the last 6, minus months the user marked as unusual.
function statsMonths(data) {
  const ex = new Set((data.settings && data.settings.excludedMonths) || []);
  const ms = lastMonths(data.user.today, 6).filter((m) => !ex.has(m));
  return ms.length ? ms : lastMonths(data.user.today, 6);
}

// The emergency goal, or the top-priority goal if the user deleted it.
function emergencyGoal(data) {
  return data.goals.find((g) => g.id === "emergency") || [...data.goals].sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9))[0] || null;
}

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
  const months = statsMonths(data);
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
  // Suggestion: cover fixed expenses with a 3% margin, but never more than 90% of the after-tax average.
  const monthly = clamp(settings.fixedMonthlyExpenses * 1.03, 0, afterTaxMean * 0.9);
  const suggested = round((monthly * 12) / 52, 25);
  // The user decides: a weekly pay they set themselves replaces the suggestion.
  const chosen = Number(settings.weeklyPay) > 0 ? Math.round(Number(settings.weeklyPay)) : null;
  const weekly = chosen ?? suggested;
  return {
    weekly,
    suggested,
    userChosen: chosen != null,
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
  const months = statsMonths(data);
  const stats = incomeStats(monthlyIncome(data.transactions, months));
  const salary = safeWeeklySalary(stats, settings);
  const forecast = forecastNextMonth(data);
  const reasons = [];
  const alloc = {};

  // 1) taxes (fixed rate, estimate, not tax advice)
  const taxOn = settings.taxProfile?.enabled !== false; // tax set-aside is optional
  alloc.tax = taxOn ? round(amount * settings.taxRate) : 0;
  let left = amount - alloc.tax;
  reasons.push({ step: "tax", rate: settings.taxRate });
  // User preference: keep a share of every payment available to spend right away.
  const prefs = settings.allocation || {};
  const keepPct = Math.min(0.9, Math.max(0, Number(prefs.keepAvailablePct) || 0));
  if (keepPct > 0) { alloc.available = round(amount * keepPct); left -= alloc.available; }

  // 2) salary reserve: keep `reserveWeeks` of salary ready
  if (settings.salaryEnabled) {
    const reserveWeeks = opts.reserveWeeks ?? settings.reserveWeeks ?? 4;
    const targetReserve = salary.weekly * reserveWeeks;
    const deficit = Math.max(0, targetReserve - (pots.salaryReserve || 0));
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
  // What happens to money left after every goal got its monthly amount: the user's choice.
  if (left > 0) {
    const eg = emergencyGoal(data);
    const top = [...statuses].sort((a, b) => (goals.find((g) => g.id === a.id).priority ?? 9) - (goals.find((g) => g.id === b.id).priority ?? 9))[0];
    const target = prefs.leftover === "emergency" ? eg && eg.id : prefs.leftover === "goals" ? top && top.id : null;
    if (target) alloc[target] = (alloc[target] || 0) + round(left);
    else alloc.available = (alloc.available || 0) + round(left); // stays available to spend in the balance
    left = 0;
  }

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
  if (settings.taxProfile?.enabled !== false && plan.alloc.tax < round(plan.amount * settings.taxRate) - 1) throw new Error("tax below minimum");
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
  if (!statuses.length) return { amount: cashback, goal: null, goalName: "your balance", progress: 0, reason: "no goals yet" };
  const eg = emergencyGoal(data);
  let pick = fc.weak && eg ? statuses.find((s) => s.id === eg.id) : null;
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
  const months = statsMonths(data);
  const stats = incomeStats(monthlyIncome(data.transactions, months));
  const salary = safeWeeklySalary(stats, data.settings);
  const perMonth = Math.max(1, salary.surplusForGoals);
  const emergency = emergencyGoal(data);
  const st = emergency ? goalStatus(emergency, data.pots[emergency.pot] || 0, data.user.today) : { remaining: 0 };
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

// ---------- full what-if plan ----------
// spend: one-off purchase now · earn: extra income per month · invest: amount per month into
// an option with an annual rate (compounded monthly) · months: horizon. Education only.
function whatIfPlan({ spend = 0, earn = 0, costs = 0 }, data) {
  const stats = incomeStats(monthlyIncome(data.transactions, statsMonths(data)));
  const salary = safeWeeklySalary(stats, data.settings);
  const extraAfterTax = earn * (1 - data.settings.taxRate);
  const freeNow = Math.max(0, salary.surplusForGoals);
  const freeAfter = Math.max(0, salary.surplusForGoals + extraAfterTax - costs);
  const emergency = emergencyGoal(data);
  const st = emergency ? goalStatus(emergency, data.pots[emergency.pot] || 0, data.user.today) : { remaining: 0, name: "Emergency fund" };
  const monthsTo = (rem, free) => (rem <= 0 ? 0 : free > 0 ? Math.ceil(rem / free) : null);
  const now = monthsTo(st.remaining, freeNow);
  const after = monthsTo(st.remaining + spend, freeAfter);
  // Weekly pay check: the new monthly costs must still fit in what the weekly pay covers.
  const payMonthly = (salary.weekly * 52) / 12;
  const expensesAfter = data.settings.fixedMonthlyExpenses + costs;
  return {
    spend, earn, costs,
    freeNow: round(freeNow), freeAfter: round(freeAfter), freeChange: round(freeAfter - freeNow),
    emergencyName: emergency ? emergency.name : "Emergency fund",
    emergencyMonthsNow: now, emergencyMonthsAfter: after,
    emergencyChangeMonths: now != null && after != null ? after - now : null,
    weeklyPay: salary.weekly, weeklyPayCoversCosts: payMonthly >= expensesAfter, expensesAfter: round(expensesAfter),
    spendShareOfReserve: (data.pots.emergency || 0) + (data.pots.salaryReserve || 0) > 0 ? +(spend / ((data.pots.emergency || 0) + (data.pots.salaryReserve || 0))).toFixed(2) : null,
  };
}

// ---------- period report ----------
function periodReport(data, periodMonths = 1) {
  const months = Array.isArray(periodMonths) ? periodMonths : lastMonths(data.user.today, Math.max(periodMonths, 1));
  const all = monthlyIncome(data.transactions, months);
  const viaPayPal = monthlyIncome(data.transactions, months, (t) => t.channel === "paypal");
  const total = sum(all.map((m) => m.amount));
  const sorted = [...all].sort((a, b) => b.amount - a.amount);
  const six = incomeStats(monthlyIncome(data.transactions, statsMonths(data)));
  const byPayer = {};
  data.transactions.filter((t) => months.includes(t.date.slice(0, 7))).forEach((t) => (byPayer[t.payer] = (byPayer[t.payer] || 0) + t.amount));
  const names = Object.fromEntries((data.payers || []).map((p) => [p.id, p.name]));
  const topPayer = Object.entries(byPayer).sort((a, b) => b[1] - a[1])[0];
  return {
    period: months.length === 1 ? months[0] : `${months[0]} to ${months[months.length - 1]}`,
    months: months.length,
    totalIncome: total,
    monthlyAverage: round(total / months.length),
    best: sorted[0],
    worst: sorted[sorted.length - 1],
    payPalShare: total ? +(sum(viaPayPal.map((m) => m.amount)) / total).toFixed(2) : 0,
    topClient: topPayer ? { name: names[topPayer[0]] || topPayer[0], share: +(topPayer[1] / total).toFixed(2) } : null,
    sixMonthAverage: six.mean,
    irregularity: six.cv,
    reserve: reserveTarget(six, data.settings.fixedMonthlyExpenses),
    goals: data.goals.map((g) => goalStatus(g, data.pots[g.pot] || 0, data.user.today)),
    pots: data.pots,
  };
}

// ---------- income passport ----------
// Facts only. Counts PayPal commercial payments (invoices, goods & services) from
// distinct, verified payers that are not linked to the user. No scores, no labels.
const COMMERCIAL = new Set(["invoice", "goods_services"]);

// Anti-fraud fact: how much of the counted income came from the biggest 1 and 2 clients.
// Always shown on the passport, without client names, so a viewer can ask about them.
function concentrationNote(data, months, eligible) {
  const by = {};
  data.transactions.filter((t) => months.includes(t.date.slice(0, 7)) && eligible(t)).forEach((t) => (by[t.payer] = (by[t.payer] || 0) + t.amount));
  const totals = Object.values(by).sort((a, b) => b - a);
  const total = sum(totals);
  if (!total) return { clients: 0, top1Share: 0, top2Share: 0, flag: false, text: "No counted income in this period." };
  const top1 = totals[0] / total, top2 = (totals[0] + (totals[1] || 0)) / total;
  const pct = (x) => Math.round(x * 100) + "%";
  const flag = totals.length <= 2 || top1 >= 0.5 || top2 >= 0.8;
  const text = totals.length === 1
    ? "All of this income came from 1 client."
    : `${pct(top1)} of this income came from the largest client and ${pct(top2)} from the largest 2 (of ${totals.length} clients).`;
  return { clients: totals.length, top1Share: +top1.toFixed(2), top2Share: +top2.toFixed(2), flag,
    text: text + (flag ? " Most of it depends on 1 or 2 clients, so a viewer may reasonably ask who they are." : "") };
}

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
  const firstPayPal = data.transactions.filter((t) => t.channel === "paypal").map((t) => t.date).sort()[0];
  const historyMonths = firstPayPal ? monthsBetween(firstPayPal, data.user.today) : 0;
  // Never count months before the user's PayPal history began (they would show as $0).
  const months = lastMonths(data.user.today, periodMonths).filter((m) => firstPayPal && m >= firstPayPal.slice(0, 7));
  periodMonths = months.length;
  const series = monthlyIncome(data.transactions, months, eligible);
  const st = incomeStats(series);
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
    clientConcentration: concentrationNote(data, months, eligible),
    excludedFromPassport: excluded,
    note: "Shows payments received through PayPal. Not a guarantee of employment or future income.",
  };
  if (data.settings.salaryEnabled) {
    // Same weekly pay the app uses everywhere: based on the last 6 months.
    const salary = safeWeeklySalary(incomeStats(monthlyIncome(data.transactions, statsMonths(data))), data.settings);
    out.scheduledWeeklyPay = `$${salary.weekly}/week from the user's own reserve (separate fact, not income)`;
  }
  return out;
}

// ---------- monthly report ----------
function monthlyReport(data) {
  const months = statsMonths(data);
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
  statsMonths, emergencyGoal,
  lastMonths, monthlyIncome, incomeStats, forecastNextMonth, reserveTarget, safeWeeklySalary,
  goalStatus, planSplit, validatePlan, routeCashback, whatIfPurchase, passportSummary, monthlyReport,
  whatIfPlan, periodReport, monthsBetween,
};
