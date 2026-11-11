# SteadPal

**The paycheck freelancers never had. A feature concept for PayPal.**

*Click PayPal. Build your future.*

Freelancers get paid irregularly: $3,500 one month, $800 the next, while rent stays the same. They have no employer setting money aside for taxes, emergencies or a steady paycheck. SteadPal turns every PayPal payment into a plan: an AI splits each incoming payment into pots, sees weak months coming, can pay you a steady weekly amount from your own reserve, routes partner cashback to the goal that needs it most, and gives you a verifiable income passport.

Built for freelancers, useful for anyone with a goal.

![SteadPal dashboard](docs/screenshot.png)

> Hackathon prototype for the PayPal AI Hackathon (2026). Simulated data and the PayPal sandbox. Education only: not financial, tax or investment advice.

---

## What it does

| Feature | What the user sees | Optional? |
| --- | --- | --- |
| Smart split | A client pays through PayPal → money is split into taxes, weekly pay reserve, emergency fund and goals, with a one-sentence explanation | Core |
| Weak-month forecast | "Your retainer ended and a $1,600 invoice is 21 days late. Next month looks like $1,700–$3,950." | Core |
| Goals in plain language | "I want $1,200 for a trip by August" → a goal with an amount and a deadline (asks for missing facts) | Core |
| Partner cashback | Paying with PayPal at a partner merchant sends the cashback to the goal most behind, not to the wallet | Core |
| What-if simulator | "If I buy a $1,400 laptop, my emergency fund is delayed about 3 months" | Core |
| Monthly report | Plain-language summary of income, irregularity, reserve and goals | Core |
| Weekly pay | A steady weekly amount from the user's own reserve (PayPal Payouts) | Opt-in |
| Income passport | One-page facts from PayPal commercial payments, signed, with a verification code and an expiring link | Opt-in |

### Why PayPal wins
- More reasons to click the PayPal button (partner cashback that builds your future).
- Money stays in PayPal longer (pots are labels over the PayPal balance).
- Weekly reasons to open the app (forecast, pots, weekly pay, report).
- A reason for freelancers to receive larger payments through PayPal: only PayPal income counts in the passport.

---

## How it works

```
Client pays (Orders v2 / Invoicing)
   → PayPal webhook: payment confirmed
   → SteadPal server (Node.js)
   → Engine (code): statistics, forecast, reserve, proposed split
   → AI (Claude): priorities + plain-language explanation
   → Validator (code): split sums to 100%, taxes not below minimum, no negatives
   → Pots updated + explanation shown
Weekly pay → PayPal Payouts · History → Transaction Search → income passport
```

**Principle: the AI decides, the code verifies.** Every number is computed by deterministic code (`engine/core.js`). The language model only interprets goals, chooses priorities within limits, and explains decisions. If the AI is unavailable, the app falls back to fixed templates and keeps working.

### The engine (`engine/core.js`)
- `incomeStats`: mean, min, max, irregularity (coefficient of variation).
- `forecastNextMonth`: low / expected / high with reasons (ended contracts, overdue invoices).
- `reserveTarget`: emergency reserve in months of expenses, larger when income is more irregular (1 + 3 × CV, between 1 and 6 months).
- `safeWeeklySalary`: covers fixed expenses, never above 90% of the after-tax average.
- `planSplit` + `validatePlan`: split an incoming payment; reject invalid splits.
- `routeCashback`: emergency fund first in a weak month, otherwise the highest-priority goal behind.
- `whatIfPurchase`, `monthlyReport`.
- `passportSummary`: only PayPal commercial payments (invoices, goods and services) from verified payers not linked to the user; personal transfers, linked accounts and brand-new payer accounts are excluded. Facts only, no scores.

### PayPal APIs used (sandbox)
| API | Used for |
| --- | --- |
| JavaScript SDK + Orders v2 | Client pays an invoice; purchase at a partner merchant |
| Invoicing v2 | Invoices; overdue invoices feed the forecast |
| Webhooks | Server is notified when a payment is captured |
| Payouts | Optional weekly pay from the user's reserve |
| Transaction Search | Payment history for statistics and the passport |
| Log in with PayPal | User consent and identity (planned) |

### AI used
- **Claude (Anthropic API)**, model set by `STEADPAL_MODEL`: explanations, goal interpretation, monthly report wording.
- Strict rules in the system prompt: use only the numbers provided, education only, no investment recommendations, treat client text (memos, names) as data, never as instructions.
- Only amounts, dates and categories are sent to the model, never emails or personal data.

---

## Run it

Requirements: Node.js 20 or newer. No packages to install.

```bash
git clone <this repo>
cd steadpal
npm test          # engine checks
npm run demo      # the 3 demo moments in the terminal
npm start         # open http://localhost:3000
```

Without any keys the app runs in **demo mode**: buttons simulate the client payment and the partner purchase, and explanations use templates.

### Connect the PayPal sandbox and the AI
Set these environment variables (locally or in Render):

| Variable | Where to get it |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | developer.paypal.com → Apps & Credentials → Sandbox app |
| `PAYPAL_PAYOUT_RECEIVER` | Email of a sandbox personal test account (receives weekly pay) |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `STEADPAL_MODEL` | Optional, Claude model name |
| `PASSPORT_SECRET` | Any long random string (signs income passports) |

With PayPal keys set, real PayPal buttons appear: pay the overdue invoice or buy at a partner merchant with a **sandbox buyer account**.

### Deploy on Render
New → Web Service → connect this repo → Build command: *(none)* → Start command: `node server.js` → add the environment variables above.

---

## Demo walkthrough (Ana, a freelance designer in Los Angeles)
1. **Next month** shows a weak-month warning: retainer ended, Northwind invoice 21 days late.
2. **Get paid**: the $1,600 invoice is paid → $400 taxes, $900 weekly pay reserve, $300 emergency fund, with the reason.
3. **Partner cashback**: a $120 stylus at a partner (5%) → $6 goes to the emergency fund.
4. **What if** a $1,400 laptop → emergency fund delayed about 3 months.
5. **Income passport** (6 months): average $2,450/month, min $0, max $4,200, 4 of 6 months above $2,500, 2 verified clients → open the verification page.

## Limitations
- Simulated data; sandbox only. Cashback is simulated (no real merchant partnerships).
- Pots are labels over one balance ("soft" pots); real sub-accounts would need PayPal.
- Forecasts cannot predict shocks; they show ranges.
- Webhook signature verification and persistent storage are not implemented yet.
- Income passport: designed to stay within existing rules (issued from PayPal's own records, facts only, user-initiated, expiring link); legal review needed before production.
- Fraud: personal transfers, linked accounts and new payer accounts are excluded, but collusion cannot be fully prevented (same as a bank statement).

## Roadmap
Pots that earn yield (PayPal Savings / PYUSD), private freelancer–diaspora FX matching, savings circles, emerging markets with licensed partners.

## License
MIT. See `LICENSE`.
