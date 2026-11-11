// Runs the 3 demo moments on Ana's data, with no network and no API keys.
// Usage: node demo.js
const data = require("./data/ana.json");
const E = require("./engine/core");
const { explain } = require("./engine/llm");

(async () => {
  const months = E.lastMonths(data.user.today, 6);
  const stats = E.incomeStats(E.monthlyIncome(data.transactions, months));
  console.log("Income stats (all sources, last 6 months):", stats);
  console.log("Reserve target:", E.reserveTarget(stats, data.settings.fixedMonthlyExpenses));
  console.log("Safe weekly salary:", E.safeWeeklySalary(stats, data.settings));

  console.log("\n--- Moment 1: weak month detected ---");
  const fc = E.forecastNextMonth(data);
  console.log(fc);
  console.log(await explain("forecast", fc));

  console.log("\n--- Moment 2: late $1,600 payment arrives ---");
  const plan = E.planSplit(1600, data);
  console.log(plan.alloc);
  console.log(await explain("split", plan));

  console.log("\n--- Moment 3: $6 cashback (5% on a $120 stylus) ---");
  const cb = E.routeCashback(6, data);
  console.log(cb);
  console.log(await explain("cashback", cb));

  console.log("\n--- What-if: $1,400 laptop ---");
  const wi = E.whatIfPurchase(1400, data);
  console.log(wi);
  console.log(await explain("whatif", wi));

  console.log("\n--- Income passport (PayPal only) ---");
  console.log(E.passportSummary(data, 6, 2500));
})();
