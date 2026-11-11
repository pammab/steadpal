// Channel3 product search (https://docs.trychannel3.com).
// POST https://api.trychannel3.com/v1/search with the x-api-key header.
// Prices and buy links live on each product's offers. If the key is missing or the call
// fails, SteadPal falls back to fictional demo products so the app never breaks.
const BASE = "https://api.trychannel3.com";
const enabled = () => Boolean(process.env.CHANNEL3_API_KEY);

// Share of the purchase that SteadPal returns as cashback. Channel3 pays a commission on
// sales made through its links; the exact rate is not in the search response, so this is
// an estimate, configurable and shown as "estimated" in the app.
const CASHBACK_RATE = Number(process.env.CASHBACK_RATE || 0.03);

const DEMO = [
  { id: "demo-stylus", title: "Pro drawing stylus (demo)", brand: "InkLine", price: 120, currency: "USD", merchant: "inkline.example", url: null, image: null },
  { id: "demo-tablet", title: "10-inch drawing tablet (demo)", brand: "InkLine", price: 249, currency: "USD", merchant: "inkline.example", url: null, image: null },
  { id: "demo-fonts", title: "Font bundle, yearly (demo)", brand: "CloudFonts", price: 180, currency: "USD", merchant: "cloudfonts.example", url: null, image: null },
];

// Defensive parsing: offers carry price, currency, domain and buy link.
function normalize(p) {
  const offer = (p.offers || [])[0] || {};
  const priceObj = typeof offer.price === "object" && offer.price !== null ? offer.price : null;
  const price = Number(priceObj ? priceObj.price : offer.price);
  const img = (p.images || [])[0] || {};
  return {
    id: p.id,
    title: p.title,
    brand: (p.brands && p.brands[0] && p.brands[0].name) || (p.brand && p.brand.name) || "",
    price: Number.isFinite(price) ? price : null,
    currency: (priceObj && priceObj.currency) || offer.currency || "USD",
    merchant: offer.domain || offer.merchant_domain || "",
    url: offer.url || null,
    image: img.cleaned_url || img.url || null,
  };
}

async function search(query, { limit = 4, maxPrice } = {}) {
  if (!enabled()) return { source: "demo", products: DEMO.filter((d) => !query || matches(d, query)).concat([]).slice(0, limit) };
  try {
    const body = { query, limit };
    if (maxPrice) body.filters = { price: { max_price: maxPrice } };
    const res = await fetch(`${BASE}/v1/search`, {
      method: "POST",
      headers: { "x-api-key": process.env.CHANNEL3_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Channel3 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    const list = Array.isArray(j) ? j : j.products || [];
    const products = list.map(normalize).filter((p) => p.price && p.currency === "USD").slice(0, limit);
    if (!products.length) throw new Error("no USD products returned");
    return { source: "channel3", products };
  } catch (e) {
    console.error("[channel3]", e.message);
    return { source: "demo", error: e.message, products: DEMO.slice(0, limit) };
  }
}

function matches(d, q) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${d.title} ${d.brand}`.toLowerCase();
  return words.some((w) => hay.includes(w));
}

module.exports = { search, enabled, CASHBACK_RATE, normalize, DEMO };
