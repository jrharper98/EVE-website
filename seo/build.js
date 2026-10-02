// EVE site builder — makes welcometoeve.com readable by Google.
//
// What it does (runs automatically on GitHub, see .github/workflows/eve-site.yml):
//   1. Unpacks the exported index.html bundle into a normal web page + an assets/ folder,
//      so the words on the site are in the page itself instead of compressed inside it.
//   2. Adds a real page title, description, social-share preview and Organization schema.
//   3. Gives the homepage headline a plain-language line Google can read.
//   4. Pulls every PUBLISHED event from Supabase and writes one page per event
//      (/events/<name>/) with Event schema, plus an /events/ listing page.
//   5. Writes sitemap.xml and robots.txt.
//
// You keep exporting/uploading index.html exactly like before — this runs after every upload,
// every morning, and whenever you press "Run workflow".
// No npm packages needed. Node 18+.

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ───────────────────────── Settings you can change ─────────────────────────
const SITE = 'https://welcometoeve.com';
const INPUT = 'index.html';            // the file you upload (bundle or plain HTML)
const OUT = '_site';                   // what gets published
const TZ = 'America/Los_Angeles';

const ORG = {
  name: 'EVE',
  alternateName: ['EVE San Francisco', "EVE Women's Community"],
  description:
    "EVE is a San Francisco women's community that hosts workshops, pampering experiences, and networking events for women and femme-expressing people.",
  email: 'eveforwomen.information@gmail.com',
  instagram: 'https://www.instagram.com/welcometoeve',
  founders: ['Joslyn René Harper', 'Ashley Liu'],
};

// Title + description Google shows for each section of the site (?p=…).
const PAGES = {
  home: {
    title: "EVE | Women's Community & Events in San Francisco",
    description:
      "EVE is a San Francisco women's community for learning, pampering, and connection. Join hands-on workshops, self-care socials, and networking events for women and femme-expressing people.",
  },
  mission: {
    title: "Our Mission | EVE Women's Community, San Francisco",
    description:
      "EVE empowers women to express their femininity with confidence, values women for their individuality, and elevates women's lifestyles through new opportunities in San Francisco.",
  },
  about: {
    title: 'About EVE & Our Founders | San Francisco Women\'s Community',
    description:
      "Meet Joslyn René Harper and Ashley Liu, the founders of EVE — a San Francisco community gathering women and femme-expressing people to learn, restore, and rise.",
  },
  events: {
    title: "Women's Events in San Francisco | EVE",
    description:
      "Upcoming EVE gatherings in San Francisco: hands-on workshops, pampering socials, outings, and networking for women and femme-expressing people. Reserve your spot.",
  },
  privacy: {
    title: 'Privacy & Terms | EVE',
    description: 'How EVE handles your information, in plain language.',
  },
  portal: { title: 'EVE Team Portal', description: '', noindex: true },
};

// A small line added above "A space to bloom" on the homepage (set to '' to turn off).
const HERO_EYEBROW = "EVE · Women's Community · San Francisco";
// Swap a phrase in the homepage intro so it names the city (set to null to turn off).
const HERO_TEXT_SWAP = ["A women's community for learning", "A San Francisco women's community for learning"];

// Street addresses for venues whose address isn't typed into the event's "location detail".
// Google needs a street address to show an event. Add new venues here as you use them.
const VENUES = {
  'ferry building': { streetAddress: '1 Ferry Building', postalCode: '94111' },
  'muddy waters': { streetAddress: '521 Valencia Street', postalCode: '94110' },
};
// ────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const log = (...a) => console.log('[eve-build]', ...a);

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const jsonLd = (obj) =>
  '<script type="application/ld+json">' + JSON.stringify(obj, null, 2).replace(/</g, '\\u003c') + '</script>';

const EXT = {
  'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'text/javascript': 'js', 'application/javascript': 'js', 'text/css': 'css',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf',
};

// ── 1. Unpack the bundle ────────────────────────────────────────────────────
function scriptBlock(src, type) {
  const re = new RegExp('<script type="__bundler/' + type + '">\\s*([\\s\\S]*?)\\s*</script>');
  const m = src.match(re);
  return m ? m[1] : null;
}

function unpack(src) {
  const manifestText = scriptBlock(src, 'manifest');
  const templateText = scriptBlock(src, 'template');
  if (!manifestText || !templateText) {
    log('index.html is not a bundle — using it as plain HTML');
    return { html: src, assets: [] };
  }
  const manifest = JSON.parse(manifestText);
  let html = JSON.parse(templateText);
  const ext = JSON.parse(scriptBlock(src, 'ext_resources') || '[]');
  const assets = [];
  const names = {};
  for (const [uuid, entry] of Object.entries(manifest)) {
    let bytes = Buffer.from(entry.data, 'base64');
    if (entry.compressed) bytes = zlib.gunzipSync(bytes);
    const file = 'assets/' + uuid + '.' + (EXT[entry.mime] || 'bin');
    assets.push({ file, bytes });
    names[uuid] = file;
  }
  for (const [uuid, file] of Object.entries(names)) html = html.split(uuid).join(file);
  html = html.replace(/\s+integrity="[^"]*"/gi, '').replace(/\s+crossorigin="[^"]*"/gi, '');
  // The page runtime looks up React etc. through window.__resources (the bundle used to set this).
  const resources = {};
  for (const e of ext) if (names[e.uuid]) resources[e.id] = names[e.uuid];
  const resScript = '<script>window.__resources = ' + JSON.stringify(resources).replace(/<\//g, '<\\/') + ';</script>';
  html = insertAfterHeadOpen(html, resScript);
  log('unpacked', assets.length, 'assets');
  return { html, assets };
}

function insertAfterHeadOpen(html, text) {
  const m = html.match(/<head[^>]*>/i);
  if (!m) return text + html;
  const i = m.index + m[0].length;
  return html.slice(0, i) + text + html.slice(i);
}

// Find an <img> by a fragment of its tag (alt text, class, attribute) and return its src.
function imgSrc(html, needle) {
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].includes(needle)) {
      const s = m[0].match(/\ssrc="([^"]+)"/);
      if (s && !s[1].startsWith('data:') && !s[1].includes('{{')) return s[1];
    }
  }
  return null;
}

// Pull @font-face rules out of the page so the event pages use the same fonts.
function extractFonts(html, assets) {
  const rules = [];
  const re = /@font-face\s*\{([\s\S]*?)\}/g;
  const seen = new Set();
  let m, n = 0;
  while ((m = re.exec(html))) {
    const body = m[1];
    const fam = (body.match(/font-family:\s*([^;]+)/) || [])[1];
    const srcM = body.match(/url\((["']?)([^"')]+)\1\)/);
    if (!fam || !srcM) continue;
    let url = srcM[2];
    if (url.startsWith('data:')) {
      const dm = url.match(/^data:([^;]+);base64,(.*)$/);
      if (!dm) continue;
      const file = 'assets/fonts/' + fam.replace(/['"]/g, '').trim().toLowerCase().replace(/\s+/g, '-') + '-' + (n++) + '.' + (EXT[dm[1]] || 'woff2');
      assets.push({ file, bytes: Buffer.from(dm[2], 'base64') });
      url = file;
    } else if (!url.startsWith('assets/')) continue; // dangling reference in the export
    const style = ((body.match(/font-style:\s*([^;]+)/) || [])[1] || 'normal').trim();
    const range = (body.match(/unicode-range:\s*([^;]+)/) || [])[1];
    const key = fam + style + (range || '');
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(
      `@font-face{font-family:${fam.trim()};font-style:${style};font-weight:400;font-display:swap;src:url("/${url}") format("woff2");${range ? 'unicode-range:' + range.trim() + ';' : ''}}`
    );
  }
  return rules.join('\n');
}

// ── 2. Events from Supabase ─────────────────────────────────────────────────
async function fetchEvents(sbUrl, sbKey) {
  const url = sbUrl + '/rest/v1/events?select=*&status=eq.published&order=event_date.asc';
  const res = await fetch(url, { headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey } });
  if (!res.ok) throw new Error('Supabase returned ' + res.status + ' ' + (await res.text()));
  return res.json();
}

const pad = (n) => String(n).padStart(2, '0');
function parseTime(s) {
  if (!s) return null;
  const m = String(s).trim().toLowerCase().replace(/\./g, '').match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = +m[1];
  const min = +(m[2] || 0);
  const ap = m[3] ? m[3][0] : null;
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return pad(h) + ':' + pad(min);
}
function tzOffset(date, time) {
  const d = new Date(date + 'T' + (time || '12:00') + ':00Z');
  const part = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName').value;
  return part === 'GMT' ? '+00:00' : part.replace('GMT', '');
}
function isoDateTime(date, timeText) {
  const t = parseTime(timeText);
  return t ? `${date}T${t}:00${tzOffset(date, t)}` : date;
}
function todayLA() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function longDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return 'Date to be announced';
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function slugify(s) {
  return String(s || 'event')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[’']/g, '').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'event';
}
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  return n === 0 ? 'Free' : '$' + (Number.isInteger(n) ? n : n.toFixed(2));
}

function placeFor(ev) {
  const name = (ev.location || '').trim();
  const detail = (ev.location_detail || '').trim();
  const addr = { '@type': 'PostalAddress', addressLocality: 'San Francisco', addressRegion: 'CA', addressCountry: 'US' };
  const parts = detail.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length && /^\d/.test(parts[0])) {
    addr.streetAddress = parts[0];
    if (parts[1] && !/^(ca|california)$/i.test(parts[1])) addr.addressLocality = parts[1].replace(/\s+(ca|california)$/i, '');
    const zip = detail.match(/\b(9\d{4})\b/);
    if (zip) addr.postalCode = zip[1];
  }
  const hay = (name + ' ' + detail).toLowerCase();
  for (const [k, v] of Object.entries(VENUES)) {
    if (hay.includes(k)) {
      if (!addr.streetAddress) addr.streetAddress = v.streetAddress;
      if (!addr.postalCode && v.postalCode) addr.postalCode = v.postalCode;
    }
  }
  return { '@type': 'Place', name: name || 'San Francisco', address: addr };
}

function prepareEvents(rows, assets, fallbackImage) {
  const today = todayLA();
  const used = new Set();
  return rows.map((r) => {
    let slug = slugify(r.title);
    if (used.has(slug)) slug += '-' + (r.event_date || String(r.id).slice(0, 6));
    used.add(slug);
    const url = `${SITE}/events/${slug}/`;
    let image = null;
    const img = r.image_url || '';
    const dm = img.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
    if (dm) {
      const ext = dm[1] === 'jpeg' ? 'jpg' : dm[1];
      const file = `events/${slug}/photo.${ext}`;
      assets.push({ file, bytes: Buffer.from(dm[2], 'base64') });
      image = `${SITE}/${file}`;
    } else if (/^https?:\/\//.test(img)) image = img;
    const past = r.event_date ? r.event_date < today : false;
    return { ...r, slug, url, image, hasOwnImage: !!image, imageOrFallback: image || fallbackImage, past };
  });
}

function eventSchema(ev) {
  const s = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: ev.title,
    description: ev.description || undefined,
    startDate: isoDateTime(ev.event_date, ev.start_time),
    endDate: ev.end_time && parseTime(ev.end_time) ? isoDateTime(ev.event_date, ev.end_time) : undefined,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: placeFor(ev),
    image: ev.imageOrFallback ? [ev.imageOrFallback] : undefined,
    url: ev.url,
    organizer: { '@type': 'Organization', name: ORG.name, url: SITE + '/' },
    audience: { '@type': 'PeopleAudience', audienceType: 'Women and femme-expressing people' },
    maximumAttendeeCapacity: ev.capacity || undefined,
  };
  const price = ev.price_advance ?? ev.price_door;
  if (price !== null && price !== undefined && price !== '') {
    s.offers = {
      '@type': 'Offer',
      price: String(Number(price)),
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url: ev.url,
      validFrom: ev.created_at || undefined,
    };
  }
  return JSON.parse(JSON.stringify(s)); // drops undefined fields
}

// ── 3. Page templates for event pages ───────────────────────────────────────
function shell({ title, description, canonical, image, body, schema, fontsCss, logo, flower }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="EVE">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
${image ? `<meta property="og:image" content="${esc(image)}">\n<meta name="twitter:card" content="summary_large_image">` : ''}
<style>
${fontsCss}
:root{--sage:#DCF2C2;--cream:#F7F5EC;--gold:#F0DC6A;--goldtext:#8a6f2a;--lav:#DABAF5;--olive:#8EA86F;--forest:#3D4F2E;--line:#E4D3A0}
*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--forest);font-family:'Radley',Georgia,serif;font-size:18px;line-height:1.65}
a{color:inherit}
.nav{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 24px;background:#fff;border-bottom:1px solid var(--line)}
.nav img{height:56px;width:auto;display:block}
.nav .links{display:flex;gap:22px;font-size:12px;letter-spacing:.14em;text-transform:uppercase}
.nav .links a{text-decoration:none}
.wrap{max-width:880px;margin:0 auto;padding:48px 20px 64px;position:relative}
.flower{position:absolute;right:-90px;top:10px;width:260px;opacity:.35;pointer-events:none;transform:rotate(-20deg)}
.eyebrow{font-size:13px;letter-spacing:.2em;text-transform:uppercase;color:var(--goldtext);margin:0 0 10px}
h1,.script{font-family:'Lavender Lullaby',cursive;font-weight:400;line-height:.95;margin:0}
h1{font-size:clamp(48px,9vw,80px)}
h2{font-family:'Lavender Lullaby',cursive;font-weight:400;font-size:clamp(38px,6vw,54px);line-height:1;margin:48px 0 18px}
h3{font-size:22px;margin:0 0 6px;color:var(--forest)}
.pill{display:inline-block;padding:4px 14px;border-radius:999px;background:var(--sage);font-size:13px;letter-spacing:.06em;margin-top:18px}
.hero-img{width:100%;max-height:460px;object-fit:cover;border-radius:20px;display:block;margin:28px 0}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:28px 0;padding:0;list-style:none}
.facts li{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 18px}
.facts b{display:block;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--goldtext);font-weight:400}
.desc{font-size:20px;font-style:italic;max-width:680px}
.btn{display:inline-block;padding:15px 32px;background:var(--olive);color:#fff;border-radius:999px;text-decoration:none;letter-spacing:.08em;font-size:15px;margin-top:10px}
.note{background:#fff;border:1px dashed var(--line);border-radius:14px;padding:14px 18px;font-style:italic}
.cards{display:grid;gap:16px;padding:0;margin:0;list-style:none}
.card{display:flex;gap:18px;align-items:center;background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px;text-decoration:none}
.card img{width:110px;height:110px;object-fit:cover;border-radius:12px;flex:none}
.date{flex:none;width:76px;text-align:center;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--goldtext)}
.date span{display:block;font-family:'Lavender Lullaby',cursive;font-size:44px;line-height:1;letter-spacing:0;color:var(--forest);text-transform:none}
.card p{margin:4px 0 0;font-size:16px}
.muted{color:#6b7558}
footer{background:var(--sage);padding:36px 20px;text-align:center;font-size:15px}
footer a{margin:0 10px}
@media (max-width:620px){.nav{flex-direction:column;padding:12px 16px}.nav .links{gap:14px;flex-wrap:wrap;justify-content:center}.flower{display:none}.card{align-items:flex-start}.card img{width:80px;height:80px}.wrap{padding:32px 16px 48px}}
</style>
${schema.map(jsonLd).join('\n')}
</head>
<body>
<header class="nav">
  <a href="/" aria-label="EVE home">${logo ? `<img src="/${esc(logo)}" alt="EVE — Empower · Value · Elevate">` : '<span class="script" style="font-size:44px">EVE</span>'}</a>
  <nav class="links"><a href="/?p=mission">Mission</a><a href="/?p=about">About</a><a href="/events/">Events</a><a href="/">Join</a></nav>
</header>
<main class="wrap">
${flower ? `<img class="flower" src="/${esc(flower)}" alt="" aria-hidden="true">` : ''}
${body}
</main>
<footer>
  <p class="script" style="font-size:40px;margin:0 0 6px">EVE</p>
  <p style="margin:0 0 12px">A women's community in San Francisco — Empower · Value · Elevate</p>
  <p style="margin:0"><a href="${esc(ORG.instagram)}">Instagram @welcometoeve</a><a href="mailto:${esc(ORG.email)}">Email us</a><a href="/events/">All events</a></p>
</footer>
</body>
</html>
`;
}

function eventCard(ev) {
  const [y, m, d] = (ev.event_date || '').split('-');
  const mon = m ? new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) : 'TBA';
  return `<li><a class="card" href="/events/${esc(ev.slug)}/">
  <div class="date">${esc(mon)}<span>${esc(d ? +d : '')}</span>${esc(y || '')}</div>
  ${ev.hasOwnImage ? `<img src="${esc(ev.image.replace(SITE, ''))}" alt="${esc(ev.title)}" loading="lazy">` : ''}
  <div><h3>${esc(ev.title)}</h3><p class="muted">${esc(ev.category || '')}${ev.location ? ' · ' + esc(ev.location) : ''}</p>${ev.description ? `<p>${esc(ev.description.length > 140 ? ev.description.slice(0, 137) + '…' : ev.description)}</p>` : ''}</div>
</a></li>`;
}

function eventPage(ev, all, common) {
  const when = longDate(ev.event_date) + (ev.start_time ? ' · ' + ev.start_time + (ev.end_time ? ' – ' + ev.end_time : '') : '');
  const where = [ev.location, ev.location_detail].filter(Boolean).join(', ');
  const adv = money(ev.price_advance), door = money(ev.price_door);
  const price = adv && door && adv !== door ? `${adv} in advance · ${door} at the door` : adv || door || '';
  const others = all.filter((o) => !o.past && o.id !== ev.id);
  const title = `${ev.title} — ${longDate(ev.event_date).replace(/^\w+, /, '')} | EVE San Francisco`;
  const description = (
    (ev.description ? ev.description + ' ' : '') +
    `An EVE women's community event in San Francisco${ev.location ? ' at ' + ev.location : ''}.`
  ).slice(0, 300);
  const body = `
<p class="eyebrow">EVE · Women's event in San Francisco</p>
<h1>${esc(ev.title)}</h1>
${ev.category ? `<span class="pill">${esc(ev.category)}</span>` : ''}
${ev.hasOwnImage ? `<img class="hero-img" src="${esc(ev.image.replace(SITE, ''))}" alt="${esc(ev.title)} — EVE event in San Francisco">` : ''}
<ul class="facts">
  <li><b>When</b>${esc(when)}</li>
  <li><b>Where</b>${esc(where || 'San Francisco')}</li>
  ${price ? `<li><b>Tickets</b>${esc(price)}</li>` : ''}
  ${ev.rsvp_deadline && !ev.past ? `<li><b>RSVP by</b>${esc(longDate(ev.rsvp_deadline))}</li>` : ''}
</ul>
${ev.description ? `<p class="desc">${esc(ev.description)}</p>` : ''}
${ev.past
    ? `<p class="note">This gathering has already happened — thank you to everyone who came! See what's coming up next below.</p>`
    : `<a class="btn" href="${SITE}/?e=${encodeURIComponent(ev.id)}">Reserve your spot</a>`}
<p class="muted" style="margin-top:28px">EVE is a San Francisco community for women and femme-expressing people — every gathering is a chance to learn, restore, or connect. <a href="/?p=about">Learn about EVE</a>.</p>
${others.length ? `<h2>More upcoming gatherings</h2><ul class="cards">${others.map(eventCard).join('\n')}</ul>` : `<h2>More gatherings blooming soon</h2><p><a href="/">Join the community</a> to hear first when the next event opens.</p>`}
`;
  return shell({ ...common, title, description, canonical: ev.url, image: ev.imageOrFallback, body, schema: [eventSchema(ev)] });
}

function eventsIndexPage(events, common) {
  const upcoming = events.filter((e) => !e.past);
  const past = events.filter((e) => e.past).reverse();
  const body = `
<p class="eyebrow">Calendar of events</p>
<h1>Women's events in San Francisco</h1>
<p class="desc">Hands-on workshops, pampering socials, outings, and networking for women and femme-expressing people — hosted by EVE. Every event is a chance to learn, restore, or connect.</p>
<h2>Upcoming</h2>
${upcoming.length ? `<ul class="cards">${upcoming.map(eventCard).join('\n')}</ul>` : `<p class="note">No events are open for sign-up just yet — <a href="/">join the community</a> to be the first to know.</p>`}
${past.length ? `<h2>Past gatherings</h2><ul class="cards">${past.map(eventCard).join('\n')}</ul>` : ''}
`;
  return shell({
    ...common,
    title: PAGES.events.title,
    description: PAGES.events.description,
    canonical: SITE + '/events/',
    image: common.ogImage,
    body,
    schema: [{
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'EVE events in San Francisco',
      itemListElement: upcoming.map((e, i) => ({ '@type': 'ListItem', position: i + 1, url: e.url })),
    }],
  });
}

// ── 4. Main site page: head tags + per-section titles ──────────────────────
function seoHead(ogImage, logo) {
  const p = PAGES.home;
  const org = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': SITE + '/#org',
    name: ORG.name,
    alternateName: ORG.alternateName,
    url: SITE + '/',
    logo: logo ? SITE + '/' + logo : undefined,
    image: ogImage || undefined,
    description: ORG.description,
    email: ORG.email,
    areaServed: { '@type': 'City', name: 'San Francisco' },
    address: { '@type': 'PostalAddress', addressLocality: 'San Francisco', addressRegion: 'CA', addressCountry: 'US' },
    founder: ORG.founders.map((n) => ({ '@type': 'Person', name: n })),
    sameAs: [ORG.instagram],
  };
  const site = { '@context': 'https://schema.org', '@type': 'WebSite', name: 'EVE', alternateName: 'EVE San Francisco', url: SITE + '/' };
  return `
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="EVE">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${SITE}/">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">\n<meta name="twitter:card" content="summary_large_image">` : ''}
${jsonLd(JSON.parse(JSON.stringify(org)))}
${jsonLd(site)}
`;
}

// Keeps the title/description/canonical right as visitors (and Google) move between ?p= sections.
function seoRuntime(eventMap) {
  const pages = {};
  for (const [k, v] of Object.entries(PAGES)) pages[k] = { t: v.title, d: v.description, n: !!v.noindex };
  return `<script>
(function(){
  var SITE=${JSON.stringify(SITE)}, P=${JSON.stringify(pages)}, EV=${JSON.stringify(eventMap)};
  function tag(sel,make){var el=document.head.querySelector(sel);if(!el){el=make();document.head.appendChild(el);}return el;}
  function meta(name){return tag('meta[name="'+name+'"]',function(){var m=document.createElement('meta');m.setAttribute('name',name);return m;});}
  function apply(){
    var q=new URLSearchParams(location.search), p=q.get('p')||'home', e=q.get('e');
    if(!P[p]) p='home';
    var info=P[p], canon=SITE+'/'+(p==='home'?'':'?p='+p);
    if(e){ canon = EV[e] || SITE+'/events/'; info=P.events; }
    if(document.title!==info.t) document.title=info.t;
    if(info.d) meta('description').setAttribute('content',info.d);
    tag('link[rel="canonical"]',function(){var l=document.createElement('link');l.rel='canonical';return l;}).setAttribute('href',canon);
    var r=document.head.querySelector('meta[name="robots"]');
    if(info.n){ meta('robots').setAttribute('content','noindex'); } else if(r){ r.parentNode.removeChild(r); }
  }
  ['pushState','replaceState'].forEach(function(m){var o=history[m];history[m]=function(){var r=o.apply(this,arguments);try{apply();}catch(x){}return r;};});
  window.addEventListener('popstate',apply);
  apply();
  // the page app can rewrite the title while it loads; put ours back
  try{new MutationObserver(function(){var q=new URLSearchParams(location.search),p=q.get('p')||'home';var t=(P[q.get('e')?'events':(P[p]?p:'home')]).t;if(document.title!==t)document.title=t;}).observe(document.querySelector('title')||document.head,{childList:true,subtree:true,characterData:true});}catch(x){}
})();
</script>`;
}

function patchHero(html) {
  const homeAt = html.indexOf('{{ isHome }}');
  if (homeAt < 0) { log('WARN: homepage section not found — hero left as is'); return html; }
  const h1At = html.indexOf('<h1', homeAt);
  const close = h1At >= 0 ? html.indexOf('>', h1At) : -1;
  if (HERO_EYEBROW && close > 0 && !html.includes('eve-seo-eyebrow')) {
    const eyebrow = `<span class="eve-seo-eyebrow" style="display:block; margin:0 0 18px; font-family:'Radley',Georgia,serif; font-size:14px; line-height:1.4; letter-spacing:.22em; text-transform:uppercase; color:#8a6f2a;">${esc(HERO_EYEBROW)}</span>`;
    html = html.slice(0, close + 1) + eyebrow + html.slice(close + 1);
    log('added homepage headline line');
  }
  if (HERO_TEXT_SWAP) {
    const i = html.indexOf(HERO_TEXT_SWAP[0], homeAt);
    if (i > 0) html = html.slice(0, i) + HERO_TEXT_SWAP[1] + html.slice(i + HERO_TEXT_SWAP[0].length);
  }
  return html;
}

// ── 5. Write everything ─────────────────────────────────────────────────────
function write(rel, data) {
  const p = path.join(ROOT, OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}
function copyRepo() {
  const skip = new Set(['.git', '.github', 'seo', OUT, 'node_modules', INPUT]);
  for (const name of fs.readdirSync(ROOT)) {
    if (skip.has(name)) continue;
    fs.cpSync(path.join(ROOT, name), path.join(ROOT, OUT, name), { recursive: true });
  }
}

async function main() {
  fs.rmSync(path.join(ROOT, OUT), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, OUT), { recursive: true });
  copyRepo();

  const src = fs.readFileSync(path.join(ROOT, INPUT), 'utf8');
  let { html, assets } = unpack(src);

  // Supabase details come straight from the page so they never go stale.
  const sbUrl = (html.match(/SB_URL\s*=\s*'([^']+)'/) || [])[1] || process.env.SUPABASE_URL;
  const sbKey = (html.match(/SB_KEY\s*=\s*'([^']+)'/) || [])[1] || process.env.SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) throw new Error('Could not find the Supabase URL/key in index.html');

  const logo = imgSrc(html, 'alt="EVE — Empower') || imgSrc(html, 'eve-nav-logo');
  const photo = imgSrc(html, 'data-eve-slide="1"') || imgSrc(html, 'alt="Women gathered');
  const flower = imgSrc(html, 'eve-fl-hero');
  const ogImage = photo ? SITE + '/' + photo : null;
  const fontsCss = extractFonts(html, assets);

  const rows = await fetchEvents(sbUrl, sbKey);
  const events = prepareEvents(rows, assets, ogImage);
  log('published events:', events.length);

  // main page
  html = html.replace(/<html(?![^>]*\blang=)/i, '<html lang="en"');
  html = html.replace(/(<head[^>]*>[\s\S]*?)<title>[\s\S]*?<\/title>/i, (m, a) => (a.includes('</head>') ? m : a)); // drop an old head <title>
  html = insertAfterHeadOpen(html, seoHead(ogImage, logo));
  html = patchHero(html);
  const eventMap = {};
  for (const e of events) eventMap[e.id] = e.url;
  const bodyEnd = html.toLowerCase().lastIndexOf('</body>');
  const runtime = seoRuntime(eventMap) + '\n';
  html = bodyEnd >= 0 ? html.slice(0, bodyEnd) + runtime + html.slice(bodyEnd) : html + runtime;
  write('index.html', html);
  for (const a of assets) write(a.file, a.bytes);

  // event pages
  const common = { fontsCss, logo, flower, ogImage };
  for (const ev of events) write(`events/${ev.slug}/index.html`, eventPage(ev, events, common));
  write('events/index.html', eventsIndexPage(events, common));

  // sitemap + robots
  const lastmod = (d) => (d ? `<lastmod>${String(d).slice(0, 10)}</lastmod>` : '');
  const today = todayLA();
  const urls = [
    [SITE + '/', today], [SITE + '/?p=mission'], [SITE + '/?p=about'],
    [SITE + '/events/', today],
    ...events.map((e) => [e.url, e.updated_at || e.created_at]),
  ];
  write('sitemap.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(([u, d]) => `  <url><loc>${esc(u)}</loc>${lastmod(d)}</url>`).join('\n') + '\n</urlset>\n');
  if (!fs.existsSync(path.join(ROOT, 'robots.txt'))) {
    write('robots.txt', `User-agent: *\nAllow: /\nDisallow: /*?p=portal\n\nSitemap: ${SITE}/sitemap.xml\n`);
  }
  log('done →', OUT);
}

main().catch((e) => { console.error('[eve-build] FAILED:', e.message); process.exit(1); });
