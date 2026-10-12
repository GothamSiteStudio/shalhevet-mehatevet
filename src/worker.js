/**
 * Shalhevet Mehatevet - site Worker (Cloudflare Workers + static assets).
 *
 * Order of handling:
 *   1. www.shalhevetmehatevet.com  -> 301 to the apex domain
 *   2. /api/lead                   -> the lead form (JSON from the page script, urlencoded without JS)
 *      any other /api/*            -> JSON 404
 *   3. everything else             -> static assets from ./public
 * Every response gets the security headers, and static files get their cache policy.
 *
 * Bindings (see wrangler.jsonc):
 *   ASSETS        static assets
 *   EMAIL         send_email binding (Email Routing: verified destination addresses only)
 *   LEADS         KV namespace, 90-day backup copy of every lead        (optional)
 *   LEAD_LIMITER  rate limiting binding, 5 submissions a minute per IP  (optional)
 *   LEAD_FROM     var: sender address on the site's own domain
 *   LEAD_TO       secret: comma-separated list of verified destination addresses
 */
import { EmailMessage } from "cloudflare:email";

/* ------------------------------------------------------------------ constants */

const SITE_HOST = "shalhevetmehatevet.com";
const SITE_ORIGIN = `https://${SITE_HOST}`;
const WWW_HOST = `www.${SITE_HOST}`;
const WHATSAPP_NUMBER = "972542213199";

const MAX_BODY_BYTES = 10 * 1024;
const MAX_DRAIN_BYTES = 1024 * 1024;
const MIN_FILL_MS = 1500;
const BACKUP_TTL_SECONDS = 90 * 24 * 60 * 60;
const SEND_TIMEOUT_MS = 15000;
const BACKUP_TIMEOUT_MS = 5000;
const MAX_RECIPIENTS = 5;

const DEFAULT_FROM = `leads@${SITE_HOST}`;
const FROM_NAME = "אתר שלהבת מחטבת";

/** Program values of the form, with the Hebrew labels used in the email to the coach. */
const PROGRAM_LABELS = {
  full: "ליווי אישי מלא",
  zoom: "אימוני זום וקהילה",
  unsure: "עוד לא בטוחה",
};
const LANGUAGE_LABELS = { he: "עברית", en: "אנגלית" };

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://matomo.alphalockandsafe.com",
  "style-src 'self'",
  "img-src 'self' data: https://matomo.alphalockandsafe.com",
  "font-src 'self'",
  "connect-src 'self' https://matomo.alphalockandsafe.com",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

/**
 * Texts of the small HTML pages answered to a form posted without JavaScript.
 * Taken from the CONTACT section of the copy decks; the few lines the decks do not
 * cover (page heading for missing details, back links, two fallback messages) are UI micro-copy.
 * `labels` and `programs` build the WhatsApp message that carries her details when delivery failed;
 * they match the data-l-* attributes on #lead-error and the form's program options in the pages.
 */
const TEXT = {
  he: {
    dir: "rtl",
    home: "/he",
    brand: "שלהבת מחטבת",
    successTitle: "קיבלתי, תודה!",
    successLine: "אחזור אלייך לשיחת היכרות קצרה 🤍",
    errorTitle: "משהו השתבש והפרטים לא נשלחו.",
    errorLine: "אפשר לשלוח לי אותם בוואטסאפ, בלחיצה אחת.",
    errorButton: "שליחה בוואטסאפ",
    whatsappButton: "כתבי לי בוואטסאפ",
    whatsappPrefill: "היי שלהבת, הגעתי מהאתר ואשמח לשיחת היכרות קצרה.",
    validationTitle: "חסרים כמה פרטים",
    backToForm: "חזרה לטופס",
    backHome: "חזרה לדף הבית",
    newTab: "נפתח בלשונית חדשה",
    labels: { name: "שם", phone: "טלפון", program: "מה מעניין אותי", note: "הערה" },
    programs: PROGRAM_LABELS,
    fields: {
      name: "חסר לי השם שלך.",
      phone: "המספר לא נראה תקין. הקלידי מספר נייד מלא, למשל 050-1234567.",
      program: "בחרי באחת מהתוכניות שבטופס.",
      note: "ההודעה ארוכה מדי. אפשר לכתוב עד 500 תווים.",
      consent: "כדי שאוכל לחזור אלייך, סמני את תיבת האישור.",
    },
  },
  en: {
    dir: "ltr",
    home: "/",
    brand: "Shalhevet Mehatevet",
    successTitle: "Got it, thank you!",
    successLine: "I'll get back to you for a short intro chat 🤍",
    errorTitle: "Something went wrong and your details weren't sent.",
    errorLine: "You can send them to me on WhatsApp instead, in one tap.",
    errorButton: "Send on WhatsApp",
    whatsappButton: "Message me on WhatsApp",
    whatsappPrefill: "Hi Shalhevet, I found you through your website and I'd love a short intro chat.",
    validationTitle: "A few details are missing",
    backToForm: "Back to the form",
    backHome: "Back to home",
    newTab: "opens in a new tab",
    labels: { name: "Name", phone: "Phone", program: "I'm interested in", note: "Note" },
    programs: { full: "Full personal coaching", zoom: "Zoom workouts & community", unsure: "Not sure yet" },
    fields: {
      name: "I still need your name.",
      phone: "That number doesn't look right. Please enter your full mobile number, including the country code.",
      program: "Please choose one of the programs in the form.",
      note: "The note is too long. Please keep it to 500 characters.",
      consent: "So I can get back to you, please check the consent box.",
    },
  },
};

/* ------------------------------------------------------------------ entry point */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const local = isLocalHost(url.hostname);
    let response;
    try {
      response = await route(request, env, url, local);
    } catch (err) {
      console.error("unhandled error:", errorMessage(err));
      response = unexpectedError(request, url);
    }
    return withSiteHeaders(response, url, local);
  },
};

/** Last resort. A visitor who posted the form without JavaScript still gets the WhatsApp fallback page. */
function unexpectedError(request, url) {
  if (url.pathname === "/api/lead" && mediaTypeOf(request) === "application/x-www-form-urlencoded") {
    return html(statusPage(languageFromReferer(request), "error"), 500);
  }
  if (isApiPath(url.pathname)) {
    return json({ ok: false, error: "server" }, 500);
  }
  return new Response("Internal error", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function mediaTypeOf(request) {
  return (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
}

async function route(request, env, url, local) {
  if (url.hostname === WWW_HOST) {
    return new Response(null, { status: 301, headers: { Location: `${SITE_ORIGIN}${url.pathname}${url.search}` } });
  }
  if (url.pathname === "/api/lead") {
    return handleLead(request, env, url, local);
  }
  if (isApiPath(url.pathname)) {
    return json({ ok: false, error: "not_found" }, 404);
  }
  return env.ASSETS.fetch(request);
}

function isApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/* ------------------------------------------------------------------ response headers */

function withSiteHeaders(response, url, local) {
  const out = new Response(response.body, response);
  const headers = out.headers;

  headers.set("Content-Security-Policy", local ? CSP : `${CSP}; upgrade-insecure-requests`);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  if (!local) {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (url.hostname.endsWith(".workers.dev")) {
    headers.set("X-Robots-Tag", "noindex"); // preview deployments must not be indexed
  }

  const cacheControl = cacheControlFor(url.pathname, out.status);
  if (cacheControl) {
    headers.set("Cache-Control", cacheControl);
  }
  return out;
}

/** Cache policy by path. HTML keeps the asset server's default revalidation. */
function cacheControlFor(pathname, status) {
  if (isApiPath(pathname)) return "no-store";
  if (status !== 200 && status !== 206 && status !== 304) return null; // never pin a 404 or a redirect
  if (pathname.startsWith("/assets/fonts/")) return "public, max-age=31536000, immutable";
  if (pathname.startsWith("/assets/img/") || pathname === "/favicon.ico") return "public, max-age=604800";
  if (pathname.startsWith("/assets/css/") || pathname.startsWith("/assets/js/")) return "public, max-age=3600";
  return null;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function html(markup, status = 200) {
  return new Response(markup, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/* ------------------------------------------------------------------ lead form */

async function handleLead(request, env, url, local) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: "POST" });
  }

  // "json" = the page script, "form" = a native form post without JavaScript (answered with an HTML page)
  const mediaType = mediaTypeOf(request);
  const mode =
    mediaType === "application/json" ? "json" : mediaType === "application/x-www-form-urlencoded" ? "form" : null;
  if (!mode) {
    return json({ ok: false, error: "unsupported_media_type" }, 415);
  }

  let lang = languageFromReferer(request);
  const diagnostics = (outcome) => (local ? { "X-Lead-Outcome": outcome } : {});
  const fail = (status, error) =>
    mode === "json" ? json({ ok: false, error }, status) : html(statusPage(lang, "error"), status);
  const succeed = (outcome) =>
    mode === "json"
      ? json({ ok: true }, 200, diagnostics(outcome))
      : new Response(statusPage(lang, "success"), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", ...diagnostics(outcome) },
        });

  const origin = request.headers.get("Origin");
  if (origin !== null && !isAllowedOrigin(origin, url, local)) {
    return fail(403, "forbidden");
  }

  const body = await readBody(request, MAX_BODY_BYTES);
  if (body.tooLarge) {
    return fail(413, "too_large");
  }

  const input = parseInput(body.text, mode);
  if (!input) {
    return fail(400, "bad_request");
  }
  lang = pickLanguage(input, lang);

  if (await isRateLimited(request, env, local)) {
    return fail(429, "rate_limited");
  }

  // Bots: a filled honeypot or an impossibly fast submit gets a plain "ok" and nothing is delivered.
  if (isFilled(input.website) || isTooFast(input.t, mode)) {
    console.log(JSON.stringify({ event: "lead", outcome: "dropped" }));
    return succeed("dropped");
  }

  const { lead, fields } = validateLead(input, lang);
  if (fields) {
    return mode === "json"
      ? json({ ok: false, error: "validation", fields }, 400)
      : html(statusPage(lang, "validation", fields), 400);
  }

  const now = new Date();
  const backupKey = await backupLead(env, lead, now);
  const delivery = await deliverLead(request, env, lead, now, local);

  console.log(
    JSON.stringify({
      event: "lead",
      outcome: delivery.outcome,
      mode,
      lang: lead.lang,
      program: lead.program,
      backup: backupKey,
      recipients: delivery.recipients,
      accepted: delivery.accepted,
    }),
  );

  if (delivery.outcome === "failed") {
    return mode === "json"
      ? json({ ok: false, error: "delivery" }, 502, diagnostics("failed"))
      : html(statusPage(lang, "error", {}, lead), 502);
  }
  return succeed(delivery.outcome);
}

/**
 * Allowed browser origins for the form. A request without an Origin header is accepted.
 *   - the site's two hostnames, always;
 *   - a workers.dev address only when it is this very deployment posting to itself (preview URLs),
 *     so a page hosted by someone else on workers.dev cannot submit the form from its visitors' browsers;
 *   - plain http://localhost and http://127.0.0.1 only while developing locally.
 */
function isAllowedOrigin(origin, url, local) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const { protocol, hostname } = parsed;
  if (protocol === "https:") {
    if (hostname === SITE_HOST || hostname === WWW_HOST) return true;
    return hostname.endsWith(".workers.dev") && parsed.origin === url.origin;
  }
  return local && protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1");
}

/** Reads the body as text, giving up as soon as it grows past the limit. */
async function readBody(request, limit) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) {
    return { tooLarge: true };
  }
  if (!request.body) {
    return { text: "" };
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // Too large. Read (and drop) what is left, within reason, so the connection ends cleanly,
      // then answer; anything bigger than that is simply cut off.
      while (total <= MAX_DRAIN_BYTES) {
        const rest = await reader.read();
        if (rest.done) return { tooLarge: true };
        total += rest.value.byteLength;
      }
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8").decode(bytes) };
}

const INPUT_FIELDS = ["name", "phone", "program", "note", "consent", "lang", "website", "t", "page"];

/** Returns the raw submitted fields, or null when the body is not a JSON object / form. */
function parseInput(text, mode) {
  const input = {};
  if (mode === "json") {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    for (const field of INPUT_FIELDS) {
      input[field] = Object.hasOwn(data, field) ? data[field] : undefined;
    }
    return input;
  }
  const params = new URLSearchParams(text);
  for (const field of INPUT_FIELDS) {
    const value = params.get(field);
    input[field] = value === null ? undefined : value;
  }
  return input;
}

function pickLanguage(input, fallback) {
  if (input.lang === "he" || input.lang === "en") return input.lang;
  if (typeof input.page === "string" && /^\/he(\/|$)/.test(input.page)) return "he";
  return fallback;
}

/** Language guess for failures that happen before the form fields are read. */
function languageFromReferer(request) {
  try {
    return /^\/he(\/|$)/.test(new URL(request.headers.get("Referer")).pathname) ? "he" : "en";
  } catch {
    return "en";
  }
}

async function isRateLimited(request, env, local) {
  const limiter = env.LEAD_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") return false;

  let key;
  if (local) {
    // Local development: limiting is off unless a test asks for it, so the form can be tried freely.
    const testKey = request.headers.get("X-Test-Rate-Limit");
    if (!testKey) return false;
    key = `test:${testKey.slice(0, 64)}`;
  } else {
    key = request.headers.get("CF-Connecting-IP") || "unknown"; // used for the counter only, never stored
  }
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch (err) {
    console.error("rate limiter error:", errorMessage(err));
    return false;
  }
}

function isFilled(value) {
  if (typeof value === "string") return value.trim() !== "";
  return value !== undefined && value !== null && value !== false;
}

/** `t` = milliseconds the form was open, set by the page script on submit. */
function isTooFast(t, mode) {
  if (typeof t !== "number" && typeof t !== "string") return false;
  if (typeof t === "string" && t.trim() === "") return false;
  const ms = Number(t);
  if (!Number.isFinite(ms)) return false;
  if (mode === "form" && ms === 0) return false; // posted without JavaScript: the field was never filled
  return ms < MIN_FILL_MS;
}

/* ------------------------------------------------------------------ validation */

const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

function asText(value, maxLength) {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") return "";
  return value.slice(0, maxLength).toWellFormed();
}

/** One line of text: no control characters, single spaces, trimmed. */
function cleanLine(value) {
  return value
    .replace(BIDI_CONTROLS, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Free text: line breaks are kept (as \n), everything else as in cleanLine. */
function cleanMultiline(value) {
  return value
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(BIDI_CONTROLS, "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Same rule as the page script: after removing spaces, dashes, parentheses (also dots, slashes and
 * invisible direction marks that come along when a number is pasted) and a leading plus,
 * 7 to 15 digits must remain. Returns the compact number ("+972541234567", "0541234567") or null.
 */
export function normalizePhone(raw) {
  const compact = String(raw).replace(/[\s\u200e\u200f\u061c\-\u2010-\u2015\u2212()./]/g, "");
  return /^\+?\d{7,15}$/.test(compact) ? compact : null;
}

/** Best-effort international form: 05XXXXXXXX -> 9725XXXXXXXX. */
export function internationalDigits(compact) {
  const hasPlus = compact.startsWith("+");
  let digits = compact.replace(/\D/g, "");
  let known = hasPlus;
  if (!hasPlus) {
    if (digits.startsWith("00")) {
      digits = digits.slice(2);
      known = true;
    } else if (digits.startsWith("0")) {
      digits = `972${digits.slice(1)}`; // Israeli local format
      known = true;
    } else if (digits.startsWith("972")) {
      known = true;
    }
  }
  if (digits.startsWith("9720")) {
    digits = `972${digits.slice(4)}`; // "+972 054..." typed with the extra zero
  }
  return { digits, known };
}

/**
 * Trims, limits and validates the submitted fields.
 * Returns { lead } when everything is fine, or { fields } with only the failing fields.
 */
function validateLead(input, lang) {
  const fields = {};

  const name = cleanLine(asText(input.name, 400));
  const nameLength = [...name].length;
  if (nameLength === 0) fields.name = "required";
  else if (nameLength < 2 || nameLength > 80) fields.name = "invalid";

  const phone = cleanLine(asText(input.phone, 100));
  const phoneCompact = phone.length <= 40 ? normalizePhone(phone) : null;
  if (phone === "") fields.phone = "required";
  else if (!phoneCompact) fields.phone = "invalid";

  const program = cleanLine(asText(input.program, 40)) || "unsure";
  if (!Object.hasOwn(PROGRAM_LABELS, program)) fields.program = "invalid";

  const note = cleanMultiline(asText(input.note, 4000));
  if (note.length > 500) fields.note = "invalid";

  const consent = input.consent;
  const consented =
    consent === true ||
    (typeof consent === "string" && ["yes", "true", "on", "1"].includes(consent.trim().toLowerCase()));
  if (!consented) fields.consent = "required";

  if (Object.keys(fields).length > 0) {
    return { fields };
  }

  const page = cleanLine(asText(input.page, 200));
  return {
    lead: {
      name,
      phone,
      phoneCompact,
      program,
      note,
      lang,
      page: /^\/[\w\-./]*$/.test(page) ? page : "",
    },
  };
}

/* ------------------------------------------------------------------ backup and delivery */

/** Keeps a copy in KV for 90 days. The IP address is not part of the record. */
async function backupLead(env, lead, now) {
  const kv = env.LEADS;
  if (!kv || typeof kv.put !== "function") return null;
  const key = `lead:${now.toISOString()}:${crypto.randomUUID().slice(0, 8)}`;
  const record = {
    receivedAt: now.toISOString(),
    name: lead.name,
    phone: lead.phone,
    program: lead.program,
    note: lead.note,
    lang: lead.lang,
    page: lead.page,
  };
  try {
    // With a time limit: a backup write that stalls is logged and the email still goes out.
    await withTimeout(kv.put(key, JSON.stringify(record), { expirationTtl: BACKUP_TTL_SECONDS }), BACKUP_TIMEOUT_MS);
    return key;
  } catch (err) {
    console.error("lead backup failed:", errorMessage(err));
    return null;
  }
}

const ADDRESS_PATTERN = /^[^\s@<>()\[\],;:"\\]+@[^\s@<>()\[\],;:"\\]+\.[^\s@<>()\[\],;:"\\]+$/;

function isPlainAddress(value) {
  return typeof value === "string" && value.length <= 254 && ADDRESS_PATTERN.test(value) && !/[^\x21-\x7e]/.test(value);
}

/**
 * LEAD_TO: addresses separated by commas (a semicolon works too). "Name <a@b.c>", quoted addresses and
 * a full stop typed after an address are understood. `ignored` counts the entries that cannot be used,
 * so they can be logged.
 */
function parseRecipients(value) {
  if (typeof value !== "string") return { recipients: [], ignored: 0 };
  const entries = value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const bracketed = part.match(/<([^<>]*)>$/);
      return (bracketed ? bracketed[1] : part).replace(/^["']|["']$/g, "").replace(/\.+$/, "").trim();
    });
  const unique = [...new Set(entries.filter(isPlainAddress))];
  return {
    recipients: unique.slice(0, MAX_RECIPIENTS),
    ignored: entries.filter((entry) => !isPlainAddress(entry)).length + Math.max(0, unique.length - MAX_RECIPIENTS),
  };
}

/**
 * Sends one notification email per address in LEAD_TO.
 * outcome: "sent" (at least one accepted), "logged" (local development without email), "failed".
 */
async function deliverLead(request, env, lead, now, local) {
  const { recipients, ignored } = parseRecipients(env.LEAD_TO);
  const result = { outcome: "failed", recipients: recipients.length, accepted: 0 };
  if (ignored > 0) {
    // Only the count: the addresses themselves stay out of the log.
    console.error(
      `LEAD_TO: ${ignored} entr${ignored === 1 ? "y" : "ies"} ignored (not a plain email address, or over the limit of ${MAX_RECIPIENTS})`,
    );
  }

  if (local && request.headers.get("X-Test-Fail") === "1") {
    return result; // forced failure, for testing the fallback
  }

  const mailer = env.EMAIL;
  if (!mailer || typeof mailer.send !== "function" || recipients.length === 0) {
    if (local) {
      console.log("[local dev] email is not configured, the lead is only logged:", JSON.stringify(lead));
      result.outcome = "logged";
    } else {
      const hasMailer = Boolean(mailer) && typeof mailer.send === "function";
      const hasLeadTo = typeof env.LEAD_TO === "string" && env.LEAD_TO.trim() !== "";
      const reason = !hasMailer
        ? "the EMAIL binding is missing"
        : hasLeadTo
          ? "LEAD_TO contains no valid address"
          : "the LEAD_TO secret is missing";
      console.error(`lead delivery is not configured: ${reason}`);
    }
    return result;
  }

  const from = isPlainAddress(env.LEAD_FROM) ? env.LEAD_FROM : DEFAULT_FROM;
  const sends = await Promise.allSettled(
    recipients.map(async (to) => {
      const { raw } = buildLeadEmail({ from, to, lead, now });
      await withTimeout(mailer.send(new EmailMessage(from, to, raw)), SEND_TIMEOUT_MS);
    }),
  );
  for (const send of sends) {
    if (send.status === "fulfilled") result.accepted += 1;
    else console.error("lead email failed:", errorMessage(send.reason));
  }
  if (result.accepted > 0) result.outcome = "sent";
  return result;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ notification email */

/**
 * The Hebrew notification email for the coach.
 * Returns { raw, subject, text, html, messageId }; `raw` is a complete RFC 5322 message (ASCII only).
 */
export function buildLeadEmail({ from, to, lead, now = new Date(), fromName = FROM_NAME, messageId }) {
  const compact = lead.phoneCompact || normalizePhone(lead.phone) || "";
  const { digits, known } = internationalDigits(compact);
  const telHref = `tel:${known ? "+" : ""}${digits}`;
  const whatsappHref = `https://wa.me/${digits}`;
  const programLabel = PROGRAM_LABELS[lead.program] || PROGRAM_LABELS.unsure;
  const languageLabel = LANGUAGE_LABELS[lead.lang] || LANGUAGE_LABELS.en;
  const received = `${jerusalemTime(now)} (שעון ישראל)`;
  const subject = `ליד חדש מהאתר: ${lead.name}`;

  const text = [
    "ליד חדש מהאתר",
    "",
    `שם: ${lead.name}`,
    `טלפון: ${lead.phone}`,
    `חיוג: ${telHref.slice(4)}`,
    `וואטסאפ: ${whatsappHref}`,
    `התעניינות: ${programLabel}`,
    lead.note ? `הודעה:\n${lead.note}` : "הודעה: (לא נכתבה)",
    `שפת העמוד: ${languageLabel}${lead.page ? ` (${lead.page})` : ""}`,
    `התקבל: ${received}`,
    "",
    `נשלח אוטומטית מטופס יצירת הקשר באתר ${SITE_HOST}`,
  ]
    .join("\n")
    .replace(/\n/g, "\r\n");

  const label = 'style="padding:8px 0 8px 16px;color:#6f6257;white-space:nowrap;vertical-align:top"';
  const value = 'style="padding:8px 0;vertical-align:top;word-break:break-word;overflow-wrap:anywhere"';
  const link = 'style="color:#c2410c;font-weight:bold"';
  const row = (name, content) => `<tr><td ${label}>${name}</td><td ${value} dir="auto">${content}</td></tr>`;
  const noteHtml = lead.note ? escapeHtml(lead.note).replace(/\n/g, "<br>") : "(לא נכתבה)";

  const htmlBody = [
    "<!doctype html>",
    '<html lang="he" dir="rtl">',
    '<head><meta charset="utf-8"><title>ליד חדש מהאתר</title></head>',
    '<body style="margin:0;padding:24px 12px;background:#f6f1eb;font-family:Arial,Helvetica,sans-serif;color:#1e1a17;direction:rtl;text-align:right">',
    '<div style="max-width:520px;margin:0 auto;padding:24px;background:#ffffff;border:1px solid #eadfd3;border-radius:16px">',
    '<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#c2410c">ליד חדש מהאתר</h1>',
    '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:16px;line-height:1.5">',
    row("שם", `<strong>${escapeHtml(lead.name)}</strong>`),
    row("טלפון", `<a ${link} href="${escapeHtml(telHref)}" dir="ltr">${escapeHtml(lead.phone)}</a>`),
    row("וואטסאפ", `<a ${link} href="${escapeHtml(whatsappHref)}">פתיחת שיחה בוואטסאפ</a>`),
    row("התעניינות", escapeHtml(programLabel)),
    row("הודעה", noteHtml),
    row("שפת העמוד", `${escapeHtml(languageLabel)}${lead.page ? ` <span dir="ltr">(${escapeHtml(lead.page)})</span>` : ""}`),
    row("התקבל", escapeHtml(received)),
    "</table>",
    `<p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:#6f6257">נשלח אוטומטית מטופס יצירת הקשר באתר ${SITE_HOST}</p>`,
    "</div>",
    "</body>",
    "</html>",
  ].join("\r\n");

  const message = buildMimeMessage({ from, fromName, to, subject, text, html: htmlBody, date: now, messageId });
  return { raw: message.raw, messageId: message.messageId, subject, text, html: htmlBody };
}

/**
 * Builds a raw multipart/alternative message. Subject, display name and both bodies are
 * always encoded (RFC 2047 words / base64), so no input can add or break a header.
 */
export function buildMimeMessage({ from, fromName = "", to, subject, text, html: htmlBody, date = new Date(), messageId }) {
  if (!isPlainAddress(from) || !isPlainAddress(to)) {
    throw new Error("invalid email address");
  }
  const id = messageId && /^<[\x21-\x7e]+@[\x21-\x7e]+>$/.test(messageId)
    ? messageId
    : `<${crypto.randomUUID()}@${from.slice(from.lastIndexOf("@") + 1)}>`;
  const boundary = `=_lead_${crypto.randomUUID().replace(/-/g, "")}`;

  const lines = [
    fromName ? `From: ${encodeHeaderText(fromName)}\r\n <${from}>` : `From: <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeaderText(subject)}`,
    `Date: ${date.toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: ${id}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative;\r\n boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(htmlBody),
    `--${boundary}--`,
    "",
  ];
  return { raw: lines.join("\r\n"), messageId: id };
}

/**
 * RFC 2047 "B" encoding. The text is split on character boundaries into words of at most
 * 39 bytes, so every header line stays under 76 characters; words are joined by folding.
 */
function encodeHeaderText(text) {
  const encoder = new TextEncoder();
  const words = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) {
      words.push(`=?UTF-8?B?${base64(Uint8Array.from(current))}?=`);
      current = [];
    }
  };
  for (const char of cleanLine(String(text))) {
    const bytes = encoder.encode(char);
    if (current.length + bytes.length > 39) flush();
    current.push(...bytes);
  }
  flush();
  return words.join("\r\n ");
}

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** UTF-8 text as base64, wrapped at 76 characters. */
function base64Lines(text) {
  return base64(new TextEncoder().encode(text)).replace(/.{76}(?=.)/g, "$&\r\n");
}

/** "12.10.2026, 16:07" in Israel time. */
function jerusalemTime(date) {
  try {
    const parts = {};
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
    return `${parts.day}.${parts.month}.${parts.year}, ${parts.hour}:${parts.minute}`;
  } catch {
    return date.toISOString();
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/* ------------------------------------------------------------------ pages for the no-JS form */

/**
 * A small complete HTML document in the form's language.
 * kind: "success" | "error" | "validation" (with the failing fields).
 * lead: the validated lead, when there is one. The error page then puts her details into the WhatsApp
 *       message (the same lines the page script builds), so "send them in one tap" is true without JavaScript too.
 */
function statusPage(lang, kind, fields = {}, lead = null) {
  const t = TEXT[lang] || TEXT.en;
  const message = lead
    ? [
        t.whatsappPrefill,
        `${t.labels.name}: ${lead.name}`,
        `${t.labels.phone}: ${lead.phone}`,
        `${t.labels.program}: ${t.programs[lead.program] || t.programs.unsure}`,
        ...(lead.note ? [`${t.labels.note}: ${lead.note}`] : []),
      ].join("\n")
    : t.whatsappPrefill;
  // Her details only ever land inside this href: percent-encoded (apostrophes too), then escaped as an attribute value.
  const whatsappHref = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message).replace(/'/g, "%27")}`;
  const whatsappLink = (label, className) =>
    `<a class="${className}" href="${escapeHtml(whatsappHref)}" target="_blank" rel="noopener">${escapeHtml(label)}` +
    `<span class="sr-only"> (${escapeHtml(t.newTab)})</span></a>`;
  // An example phone number inside a message stays on one line (and left-to-right inside Hebrew).
  const keepNumbersWhole = (escaped) => escaped.replace(/\d{3}-\d{7}/g, '<span class="text-nowrap" dir="ltr">$&</span>');
  const formHref = `${t.home}#contact`;

  // Markup styled by the site stylesheet: .status-page, .status-page__card (h1, p, ul inside it),
  // .status-page__logo, .status-page__actions, .btn / .btn--primary / .btn--ghost, .sr-only.
  let title;
  let content;
  if (kind === "success") {
    title = t.successTitle;
    content = [
      `<h1>${escapeHtml(t.successTitle)}</h1>`,
      `<p>${escapeHtml(t.successLine)}</p>`,
      '<div class="status-page__actions">',
      `<a class="btn btn--ghost" href="${t.home}">${escapeHtml(t.backHome)}</a>`,
      "</div>",
    ];
  } else if (kind === "validation") {
    title = t.validationTitle;
    const items = ["name", "phone", "program", "note", "consent"]
      .filter((field) => Object.hasOwn(fields, field))
      .map((field) => `<li>${keepNumbersWhole(escapeHtml(t.fields[field]))}</li>`);
    content = [
      `<h1>${escapeHtml(t.validationTitle)}</h1>`,
      `<ul>${items.join("")}</ul>`,
      '<div class="status-page__actions">',
      `<a class="btn btn--primary" href="${formHref}">${escapeHtml(t.backToForm)}</a>`,
      whatsappLink(t.whatsappButton, "btn btn--ghost"),
      "</div>",
    ];
  } else {
    title = t.errorTitle;
    content = [
      `<h1>${escapeHtml(t.errorTitle)}</h1>`,
      `<p>${escapeHtml(t.errorLine)}</p>`,
      '<div class="status-page__actions">',
      whatsappLink(t.errorButton, "btn btn--primary"),
      `<a class="btn btn--ghost" href="${formHref}">${escapeHtml(t.backToForm)}</a>`,
      "</div>",
    ];
  }

  return [
    "<!doctype html>",
    `<html lang="${lang === "he" ? "he" : "en"}" dir="${t.dir}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    '<meta name="theme-color" content="#0e0c0b">',
    `<title>${escapeHtml(title.replace(/[.!]+$/, ""))} | ${escapeHtml(t.brand)}</title>`,
    '<link rel="icon" href="/favicon.ico" sizes="32x32">',
    '<link rel="stylesheet" href="/assets/css/styles.css">',
    "</head>",
    `<body class="status-page status-page--${kind}">`,
    '<main class="status-page__card">',
    `<a class="status-page__logo" href="${t.home}">` +
      `<img src="/assets/img/logo-360.webp" width="360" height="164" alt="${escapeHtml(t.brand)}"></a>`,
    ...content,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
