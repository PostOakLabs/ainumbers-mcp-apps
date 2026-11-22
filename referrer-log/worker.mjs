// ainumbers-referrer-log: records where page visits to ainumbers.co come from.
//
// Why a Worker: on the Free plan, Cloudflare's GraphQL analytics refuses the
// clientRefererHost field, so referrers can't be read after the fact. This
// Worker sits on the page routes only (see wrangler.jsonc), passes every
// request straight through to the origin unchanged, and writes one Analytics
// Engine datum per HTML page view.
//
// What is logged, and nothing else:
//   blob1 = referring hostname (lowercased, "" when there is no Referer header)
//   blob2 = requested path (no query string, capped at 200 chars)
//   blob3 = Cloudflare verified-bot category ("" for ordinary visitors)
//   blob4 = visitor country code from request.cf (two letters, network-level)
//   index1 = referring hostname
// No IP, no full referer URL, no referer path or query, no cookies, no user
// agent: nothing that identifies a person. ainumbers-internal's
// cf_stats_pull.py reads the dataset nightly into referers-daily.jsonl.

export default {
  async fetch(request, env) {
    try {
      log(request, env);
    } catch (_) {
      // Logging must never affect the page.
    }
    return fetch(request);
  },
};

function log(request, env) {
  if (request.method !== "GET" || !env.REFERRERS) return;
  const accept = request.headers.get("accept") || "";
  const url = new URL(request.url);
  const last = url.pathname.split("/").pop();
  const looksLikePage = accept.includes("text/html") || last === "" || last.endsWith(".html") || !last.includes(".");
  if (!looksLikePage) return;

  let refHost = "";
  const ref = request.headers.get("referer");
  if (ref) {
    try {
      refHost = new URL(ref).hostname.toLowerCase().slice(0, 255);
    } catch (_) {
      refHost = "(invalid)";
    }
  }
  const cf = request.cf || {};
  env.REFERRERS.writeDataPoint({
    blobs: [refHost, url.pathname.slice(0, 200), cf.verifiedBotCategory || "", (cf.country || "").slice(0, 2)],
    indexes: [refHost.slice(0, 96)],
  });
}
