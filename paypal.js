// Minimal PayPal REST client for the sandbox. No external dependencies.
// Env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV ("sandbox" by default)
const BASE = process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

const enabled = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

let cached = { token: null, expires: 0 };
async function token() {
  if (cached.token && Date.now() < cached.expires) return cached.token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  cached = { token: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 };
  return cached.token;
}

async function call(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`PayPal ${method} ${path} -> ${res.status}: ${text}`);
  return data;
}

// Orders v2: the client pays Ana (or Ana buys at a partner merchant).
const createOrder = (amount, description) =>
  call("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: "USD", value: Number(amount).toFixed(2) }, description }],
  });

const captureOrder = (orderId) => call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {});

// Payouts: weekly pay from the user's own reserve (sandbox: from a test business account).
const createPayout = (amount, receiverEmail, note) =>
  call("POST", "/v1/payments/payouts", {
    sender_batch_header: {
      sender_batch_id: `steadpal-${Date.now()}`,
      email_subject: "Your SteadPal weekly pay",
    },
    items: [{
      recipient_type: "EMAIL",
      amount: { value: Number(amount).toFixed(2), currency: "USD" },
      receiver: receiverEmail,
      note,
    }],
  });

// Transaction Search: history for statistics and the passport (data can arrive with a delay).
const searchTransactions = (startDate, endDate) =>
  call("GET", `/v1/reporting/transactions?start_date=${startDate}T00:00:00-0000&end_date=${endDate}T23:59:59-0000&fields=all&page_size=100`);

module.exports = { enabled, createOrder, captureOrder, createPayout, searchTransactions, BASE };
