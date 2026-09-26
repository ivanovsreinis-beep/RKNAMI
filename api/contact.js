/* RK NAMI — kontaktformas endpoint (Vercel serverless funkcija)
   POST /api/contact  →  validācija  →  Mailjet Send API v3.1  →  CONTACT_EMAIL

   Env: MAILJET_API_KEY, MAILJET_SECRET_KEY, CONTACT_EMAIL, CONTACT_FROM_EMAIL

   Aizsardzība:
   - saņēmējs un sūtītājs ir fiksēti serverī (nav atvērts relay);
   - pieņem tikai same-origin JSON pieprasījumus ar ierobežotu izmēru;
   - honeypot lauks + minimālais aizpildīšanas laiks (botiem atbild ar "ok", neko nesūtot);
   - visi lauki tiek validēti, apgriezti un HTML e-pastā escapoti;
   - rate limit un dublikātu filtrs dzīvo instances atmiņā (best-effort — bez
     ārējas krātuves serverless instances to nedala); galvenā aizsardzība pret
     dubultklikšķi ir klienta pusē (poga atspējota + viens submissionId). */

'use strict';

var mailjetModule = require('node-mailjet');
var Mailjet = mailjetModule.default || mailjetModule;

var MAX_BODY_BYTES = 20 * 1024;
var MIN_FILL_MS = 3000;
var RATE_WINDOW_MS = 10 * 60 * 1000;
var RATE_MAX = 5;
var DEDUPE_MS = 10 * 60 * 1000;

var LIMITS = {
  name: 100,
  email: 254,
  phone: 30,
  address: 200,
  subject: 150,
  message: 5000
};

var EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
var PHONE_RE = /^[0-9+()\-.\s]{6,30}$/;

var rateHits = new Map();   // ip -> [timestamps]
var recent = new Map();     // submissionId / satura atslēga -> derīguma termiņš

/* ---------- Palīgfunkcijas ---------- */

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// Nulles platuma atstarpes, BOM un U+2028/2029 (veidoti no kodiem, lai failā nebūtu neredzamu rakstzīmju)
var INVISIBLE = new RegExp('[' + String.fromCharCode(0x200B) + '-' + String.fromCharCode(0x200F, 0x2028, 0x2029, 0xFEFF) + ']', 'g');

// Apgriež, normalizē un izmet vadības simbolus (atstāj rindu pārnesumus tikai ziņojumā)
function clean(value, multiline) {
  if (typeof value !== 'string') return '';
  var s = value.normalize('NFC').replace(/\r\n?/g, '\n');
  s = multiline
    ? s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').replace(INVISIBLE, '')
    : s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(INVISIBLE, '');
  s = multiline ? s.replace(/\n{4,}/g, '\n\n\n') : s.replace(/\s+/g, ' ');
  return s.trim();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prune(map, now) {
  map.forEach(function (v, k) {
    var expires = Array.isArray(v) ? (v[v.length - 1] || 0) + RATE_WINDOW_MS : v;
    if (expires <= now) map.delete(k);
  });
}

function clientIp(req) {
  var fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateLimited(ip, now) {
  var hits = (rateHits.get(ip) || []).filter(function (t) { return now - t < RATE_WINDOW_MS; });
  if (hits.length >= RATE_MAX) { rateHits.set(ip, hits); return true; }
  hits.push(now);
  rateHits.set(ip, hits);
  return false;
}

function sameOrigin(req) {
  var origin = req.headers.origin;
  var host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === String(host).split(',')[0].trim();
  } catch (e) {
    return false;
  }
}

function parseBody(req) {
  var b = req.body;
  if (b && typeof b === 'object' && !Array.isArray(b)) return b;
  if (typeof b === 'string') {
    try { var parsed = JSON.parse(b); return parsed && typeof parsed === 'object' ? parsed : null; }
    catch (e) { return null; }
  }
  return null;
}

/* ---------- Validācija ---------- */

function validate(raw) {
  var data = {
    name: clean(raw.name),
    email: clean(raw.email).toLowerCase(),
    phone: clean(raw.phone),
    address: clean(raw.address),
    subject: clean(raw.subject),
    message: clean(raw.message, true),
    consent: raw.consent === true || raw.consent === 'true' || raw.consent === 'on'
  };
  var errors = {};

  if (data.name.length < 2) errors.name = 'required';
  else if (data.name.length > LIMITS.name) errors.name = 'too_long';

  if (!data.email) errors.email = 'required';
  else if (data.email.length > LIMITS.email || !EMAIL_RE.test(data.email)) errors.email = 'invalid';

  if (data.phone && !PHONE_RE.test(data.phone)) errors.phone = 'invalid';

  if (data.address.length > LIMITS.address) errors.address = 'too_long';

  if (data.subject.length < 2) errors.subject = 'required';
  else if (data.subject.length > LIMITS.subject) errors.subject = 'too_long';

  if (data.message.length < 10) errors.message = 'required';
  else if (data.message.length > LIMITS.message) errors.message = 'too_long';

  if (!data.consent) errors.consent = 'required';

  return { data: data, errors: errors };
}

/* ---------- E-pasts ---------- */

function formatDate(date) {
  try {
    return new Intl.DateTimeFormat('lv-LV', {
      timeZone: 'Europe/Riga', dateStyle: 'long', timeStyle: 'short'
    }).format(date);
  } catch (e) {
    return date.toISOString();
  }
}

function buildEmail(d, submittedAt) {
  var rows = [
    ['Vārds, uzvārds', escapeHtml(d.name)],
    ['E-pasts', '<a href="mailto:' + escapeHtml(d.email) + '" style="color:#236455;">' + escapeHtml(d.email) + '</a>'],
    ['Tālrunis', d.phone ? '<a href="tel:' + escapeHtml(d.phone.replace(/[^0-9+]/g, '')) + '" style="color:#236455;">' + escapeHtml(d.phone) + '</a>' : '—'],
    ['Ēkas adrese', d.address ? escapeHtml(d.address) : '—'],
    ['Ziņas tēma', escapeHtml(d.subject)],
    ['Iesniegts', escapeHtml(submittedAt)],
    ['Avots', 'rknami.lv']
  ];

  var rowsHtml = rows.map(function (r) {
    return '<tr>' +
      '<th align="left" valign="top" style="padding:10px 16px 10px 0;border-top:1px solid #D8DEDC;font:600 14px Arial,sans-serif;color:#5A646E;white-space:nowrap;">' + r[0] + '</th>' +
      '<td valign="top" style="padding:10px 0;border-top:1px solid #D8DEDC;font:15px/1.5 Arial,sans-serif;color:#222A31;">' + r[1] + '</td>' +
      '</tr>';
  }).join('');

  var messageHtml = escapeHtml(d.message).replace(/\n/g, '<br>');

  var html =
    '<!doctype html><html lang="lv"><head><meta charset="utf-8"><title>' + escapeHtml(d.subject) + '</title></head>' +
    '<body style="margin:0;padding:0;background:#F3F5F4;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F4;padding:24px 12px;"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#FFFFFF;border:1px solid #D8DEDC;border-radius:10px;">' +
    '<tr><td style="background:#222A31;padding:20px 28px;border-radius:10px 10px 0 0;font:700 18px Arial,sans-serif;color:#EEF2F0;">RK NAMI · jauns pieprasījums no mājaslapas</td></tr>' +
    '<tr><td style="padding:24px 28px 8px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + rowsHtml + '</table>' +
    '</td></tr>' +
    '<tr><td style="padding:8px 28px 28px;">' +
    '<p style="margin:16px 0 8px;font:600 14px Arial,sans-serif;color:#5A646E;">Ziņojums</p>' +
    '<div style="padding:16px;background:#F3F5F4;border-left:3px solid #2E7D6B;border-radius:6px;font:15px/1.6 Arial,sans-serif;color:#222A31;">' + messageHtml + '</div>' +
    '<p style="margin:20px 0 0;font:13px Arial,sans-serif;color:#5A646E;">Lai atbildētu, vienkārši spiediet „Atbildēt“ — atbilde nonāks pie ' + escapeHtml(d.email) + '.</p>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';

  var text = [
    'Jauns pieprasījums no rknami.lv',
    '',
    'Vārds, uzvārds: ' + d.name,
    'E-pasts: ' + d.email,
    'Tālrunis: ' + (d.phone || '—'),
    'Ēkas adrese: ' + (d.address || '—'),
    'Ziņas tēma: ' + d.subject,
    'Iesniegts: ' + submittedAt,
    'Avots: rknami.lv',
    '',
    'Ziņojums:',
    d.message
  ].join('\n');

  return { html: html, text: text };
}

/* ---------- Handler ---------- */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    return send(res, 415, { ok: false, error: 'unsupported_media_type' });
  }

  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) {
    return send(res, 413, { ok: false, error: 'payload_too_large' });
  }

  if (!sameOrigin(req)) {
    return send(res, 403, { ok: false, error: 'forbidden' });
  }

  var raw = parseBody(req);
  if (!raw) return send(res, 400, { ok: false, error: 'bad_request' });

  // Spam filtri: botam izliekamies, ka viss izdevās, bet neko nesūtām
  var startedAt = Number(raw.startedAt);
  if (clean(raw.website) !== '' || !startedAt || Date.now() - startedAt < MIN_FILL_MS) {
    return send(res, 200, { ok: true });
  }

  var now = Date.now();
  prune(recent, now);
  prune(rateHits, now);

  if (rateLimited(clientIp(req), now)) {
    res.setHeader('Retry-After', String(Math.ceil(RATE_WINDOW_MS / 1000)));
    return send(res, 429, { ok: false, error: 'rate_limited' });
  }

  var result = validate(raw);
  if (Object.keys(result.errors).length) {
    return send(res, 400, { ok: false, error: 'validation', fields: result.errors });
  }
  var d = result.data;

  // Idempotence: tas pats submissionId vai identisks saturs → neko nesūtām atkārtoti
  var submissionId = clean(raw.submissionId).slice(0, 64);
  var contentKey = 'c:' + d.email + '|' + d.subject + '|' + d.message.slice(0, 500);
  var idKey = submissionId ? 'id:' + submissionId : null;
  if ((idKey && recent.has(idKey)) || recent.has(contentKey)) {
    return send(res, 200, { ok: true, duplicate: true });
  }
  if (idKey) recent.set(idKey, now + DEDUPE_MS);
  recent.set(contentKey, now + DEDUPE_MS);

  var env = process.env;
  if (!env.MAILJET_API_KEY || !env.MAILJET_SECRET_KEY || !env.CONTACT_EMAIL || !env.CONTACT_FROM_EMAIL) {
    console.error('[contact] Trūkst e-pasta konfigurācijas (env mainīgie).');
    if (idKey) recent.delete(idKey);
    recent.delete(contentKey);
    return send(res, 500, { ok: false, error: 'server_error' });
  }

  var email = buildEmail(d, formatDate(new Date(now)));

  try {
    var mailjet = Mailjet.apiConnect(env.MAILJET_API_KEY, env.MAILJET_SECRET_KEY);
    var response = await mailjet.post('send', { version: 'v3.1' }).request({
      Messages: [{
        From: { Email: env.CONTACT_FROM_EMAIL, Name: 'RK NAMI mājaslapa' },
        To: [{ Email: env.CONTACT_EMAIL, Name: 'RK NAMI' }],
        ReplyTo: { Email: d.email, Name: d.name },
        Subject: 'Jauns pieprasījums no rknami.lv – ' + d.subject,
        TextPart: email.text,
        HTMLPart: email.html,
        CustomID: submissionId || undefined
      }]
    });

    var status = response && response.body && response.body.Messages && response.body.Messages[0] && response.body.Messages[0].Status;
    if (status !== 'success') throw new Error('Mailjet status: ' + status);

    return send(res, 200, { ok: true });
  } catch (err) {
    // Logā tikai statuss un īss ziņojums — bez atslēgām un pieprasījuma konfigurācijas
    console.error('[contact] Mailjet kļūda:', err && err.statusCode, err && err.message ? String(err.message).slice(0, 300) : err);
    if (idKey) recent.delete(idKey);
    recent.delete(contentKey);
    return send(res, 502, { ok: false, error: 'send_failed' });
  }
};

// Tikai testiem
module.exports._validate = validate;
module.exports._buildEmail = buildEmail;
