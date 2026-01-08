import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json({ limit: "200kb" }));

// CORS so CodePen can call this proxy
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // tighten later if desired
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const DEBUG = process.env.DEBUG === "1";

function absUrl(maybeRelative) {
  if (!maybeRelative) return "";
  const s = String(maybeRelative).trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/")) return `https://7sage.com${s}`;
  return s;
}

console.log("RECEIVED url:", JSON.stringify(url));


function firstText($, selectors) {
  for (const sel of selectors) {
    const t = $(sel).first().text().trim();
    if (t) return t;
  }
  return "";
}

function firstAttr($, selectors, attr) {
  for (const sel of selectors) {
    const v = $(sel).first().attr(attr);
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

function firstMatchFromLinks($, predicate) {
  const links = $("a").toArray();
  for (const el of links) {
    const href = ($(el).attr("href") || "").trim();
    if (predicate(href, el)) {
      const txt = ($(el).text() || "").trim();
      if (txt) return txt;
    }
  }
  return "";
}

function findTopic($) {
  // Try to find a topic/category link near top of page.
  // We exclude:
  // - profile links
  // - numeric discussion post links (/discussion/54829/...)
  // - the /discussion root
  const $topicLink = $('a[href^="/discussion/"]')
    .filter((_, a) => {
      const href = ($(a).attr("href") || "").trim();
      if (!href) return false;
      if (href.startsWith("/discussion/profile/")) return false;
      if (href === "/discussion" || href === "/discussion/") return false;
      if (/^\/discussion\/\d+\/?/.test(href)) return false;
      return true;
    })
    .first();

  return {
    topic: ($topicLink.text() || "").trim(),
    topicUrl: absUrl($topicLink.attr("href") || "")
  };
}

function findUsername($) {
  // Primary: discussion profile links
  let username =
    firstText($, [
      'a[href^="/discussion/profile/"]',
      'a[href*="/discussion/profile/"]',
      '[class*="UserLink"] a',
      '[class*="user"] a[href*="profile"]'
    ]) ||
    firstMatchFromLinks($, (href) => href.startsWith("/discussion/profile/"));

  return username.trim();
}

function findAvatar($) {
  // Prefer gravatar. If none, try common avatar-ish patterns.
  const src =
    firstAttr($, [
      'img[src*="gravatar"]',
      'img[class*="Avatar"][src]',
      'img[class*="avatar"][src]',
      'img[alt*="Avatar"][src]',
      'img[alt*="avatar"][src]'
    ], "src");

  return absUrl(src);
}

function findWhen($, html) {
  // Best: <time datetime="...">
  let when =
    firstAttr($, ["time[datetime]"], "datetime") ||
    firstText($, ["time"]);

  // If time tags don't exist, sometimes it's plain text like "Edited 21 mins ago"
  // We do a lightweight regex fallback on the raw HTML text content.
  if (!when) {
    const m = html.match(/\bEdited\s+\d+\s+\w+\s+ago\b/i) || html.match(/\b\d+\s+\w+\s+ago\b/i);
    if (m) when = m[0];
  }

  return (when || "").replace(/\s+/g, " ").trim();
}

app.post("/scrape-discussion", async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();

    if (!url.startsWith("https://7sage.com/discussion/")) {
      return res.status(400).json({
        ok: false,
        error: "URL must start with https://7sage.com/discussion/"
      });
    }

    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NewsletterGenerator/1.0)",
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `Fetch failed: ${r.status}` });
    }

    const html = await r.text();

	if (DEBUG) {
  console.log("DEBUG signals:", {
    hasProfileLinks: html.includes("/discussion/profile/"),
    hasGravatar: html.includes("gravatar"),
    hasTimeTag: html.includes("<time"),
    hasEditedAgo: /Edited\s+\d+/.test(html),
  });

  // show a few surrounding characters if we can find likely author markers
  const idx = html.indexOf("/discussion/profile/");
  console.log("DEBUG profile link index:", idx);
  if (idx !== -1) console.log("DEBUG profile link context:", html.slice(Math.max(0, idx - 200), idx + 200));
}


    const $ = cheerio.load(html);

    // Title: H1 is usually reliable
    const title = ($("h1").first().text() || "").trim() || ($("title").text() || "").trim();

    const { topic, topicUrl } = findTopic($);
    const username = findUsername($);
    const avatar = findAvatar($);
    const when = findWhen($, html);

    if (DEBUG) {
      console.log("DEBUG scrape:", {
        url,
        title,
        topic,
        username,
        avatar: Boolean(avatar),
        when
      });
      console.log("DEBUG signals:", {
        hasProfileLinks: html.includes("/discussion/profile/"),
        hasGravatar: html.includes("gravatar"),
        hasTimeTag: html.includes("<time")
      });
    }

    return res.json({
      ok: true,
      data: {
        url,
        title,
        topic,
        topicUrl,
        username,
        avatar,
        when
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Proxy running on port", port));
