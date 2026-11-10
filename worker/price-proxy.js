// Bookworm 用の価格中継プログラム（Cloudflare Workers に貼り付けて使う）
// ブラウザから直接 Yahoo!ショッピングAPI を呼べないため、ここが代わりに問い合わせて結果を返す。
// アプリケーションID は Cloudflare の「シークレット」に YAHOO_APPID という名前で保存する（コードには書かない）。
// 使い方: https://<このWorkerのURL>/?isbn=9784167158057

const ALLOWED_ORIGINS = ["https://dustbox-beep.github.io"];
const API = "https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch";
const TIMEOUT_MS = 8000;
const CACHE_SECONDS = 3600; // 同じ本は1時間まで結果を使い回す（Yahoo への問い合わせ回数を減らす）

function corsHeaders(origin) {
  const h = { "Content-Type": "application/json; charset=utf-8", "Vary": "Origin" };
  if (ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function reply(body, status, origin, extra) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(origin), ...(extra || {}) } });
}

// 店名をまとめる（ブックオフ・ネットオフは複数の店を出している）
function shopGroup(seller) {
  const id = (seller && seller.sellerId) || "";
  const name = (seller && seller.name) || "";
  if (/^bookoff/i.test(id) || /ブックオフ|BOOKOFF/i.test(name)) return "ブックオフ";
  if (/^netoff/i.test(id) || /ネットオフ/.test(name)) return "ネットオフ";
  return "";
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== "GET") return reply({ error: "method" }, 405, origin);
    // 他のサイトからは使わせない（ブラウザ以外から直接開いたときは Origin が空なので、確認用に許す）
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return reply({ error: "origin" }, 403, origin);

    const isbn = new URL(request.url).searchParams.get("isbn") || "";
    if (!/^97[89]\d{10}$/.test(isbn)) return reply({ error: "isbn" }, 400, origin);
    if (!env.YAHOO_APPID) return reply({ error: "appid not set" }, 500, origin);

    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request("https://price-cache.invalid/" + isbn);
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const body = await hit.text();
        return new Response(body, { status: 200, headers: corsHeaders(origin) });
      }
    }

    const url = API + "?appid=" + encodeURIComponent(env.YAHOO_APPID) + "&jan_code=" + isbn + "&results=50&sort=%2Bprice";
    let data;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return reply({ error: "yahoo " + res.status }, 502, origin);
      data = await res.json();
    } catch (e) {
      return reply({ error: "yahoo unreachable" }, 504, origin);
    }

    // アプリで使う項目だけに絞る。在庫切れは除く
    const items = ((data && data.hits) || [])
      .filter((h) => h.inStock)
      .map((h) => ({
        price: h.price,
        condition: h.condition === "used" ? "used" : "new",
        shop: (h.seller && h.seller.name) || "",
        group: shopGroup(h.seller),
        freeShipping: !!(h.shipping && h.shipping.code === 2),
        url: h.url,
      }))
      .sort((a, b) => a.price - b.price);
    const body = JSON.stringify({ isbn, items, fetchedAt: new Date().toISOString() });

    if (cache) {
      const toCache = new Response(body, { headers: { "Cache-Control": "max-age=" + CACHE_SECONDS } });
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }
    return new Response(body, { status: 200, headers: corsHeaders(origin) });
  },
};
