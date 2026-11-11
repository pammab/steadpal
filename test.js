// Quick checks: node test.js
const assert = require("assert");
const E = require("./engine/core");
const base = require("./data/ana.json");
const clone = () => JSON.parse(JSON.stringify(base));

// 1) Demo numbers stay fixed
const plan = E.planSplit(1600, clone());
assert.deepStrictEqual(plan.alloc, { tax: 400, salaryReserve: 900, emergency: 300 });
assert.strictEqual(E.whatIfPurchase(1400, clone()).delayMonths, 4);
assert.strictEqual(E.routeCashback(6, clone()).goal, "emergency");

// 2) Passport ignores personal transfers, linked accounts and brand-new payers
const d = clone();
d.payers.push({ id: "friend", name: "Friend", accountAgeDays: 900, verified: true, linkedToUser: false });
d.payers.push({ id: "alt", name: "Alt account", accountAgeDays: 400, verified: true, linkedToUser: true });
d.payers.push({ id: "newco", name: "NewCo", accountAgeDays: 5, verified: true, linkedToUser: false });
d.transactions.push(
  { date: "2026-04-10", amount: 3000, payer: "friend", channel: "paypal", type: "p2p" },
  { date: "2026-04-11", amount: 3000, payer: "alt", channel: "paypal", type: "invoice" },
  { date: "2026-04-12", amount: 3000, payer: "newco", channel: "paypal", type: "invoice" }
);
const p = E.passportSummary(d, 6, 2500);
assert.strictEqual(p.monthlyAverage, 2450, "inflating payments must not change the passport");
assert.ok(p.excludedFromPassport.some((x) => x.why.includes("personal transfer")));
assert.ok(p.excludedFromPassport.some((x) => x.why.includes("linked")));
assert.ok(p.excludedFromPassport.some((x) => x.why.includes("too new")));

// 3) Validator rejects a bad split proposed by the AI
assert.throws(() => E.validatePlan({ amount: 100, alloc: { tax: 10, emergency: 80 } }, { taxRate: 0.25 }));

// 4) Passport always states how much comes from the largest 1 and 2 clients
const pc = E.passportSummary(clone(), 6, 2500).clientConcentration;
assert.ok(pc.top1Share > 0 && pc.top2Share >= pc.top1Share && pc.text.length > 10);
const solo = clone(); solo.transactions = solo.transactions.filter((t) => t.payer === "northwind");
assert.ok(E.passportSummary(solo, 6, 2500).clientConcentration.flag, "one-client income must be flagged");

// 5) The user's split preferences are respected
const kp = clone(); kp.settings.allocation = { keepAvailablePct: 0.1, leftover: "available" };
const kplan = E.planSplit(1600, kp);
assert.strictEqual(kplan.alloc.available, 160);
assert.strictEqual(Object.values(kplan.alloc).reduce((a, b) => a + b, 0), 1600);

console.log("All checks passed");
