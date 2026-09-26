/*
  RK NAMI — pieteikuma formas apstrāde Node.js vidē (alternatīva api/contact.php)
  Vercel Function: faila atrašanās vieta api/contact.mjs → maršruts /api/contact.
  Sūta caur Resend (https://resend.com): vides mainīgajā RESEND_API_KEY ieraksti
  atslēgu, un Resend panelī apstiprini domēnu rknami.lv (FROM_EMAIL).
  Lai lietotu, index.html formā nomaini data-endpoint="/api/contact".
*/

const TO_EMAIL = 'info@rknami.lv';
const FROM = 'RK NAMI mājaslapa <noreply@rknami.lv>';
const SUBJECT = 'Jauns konsultācijas pieteikums no mājaslapas';

const ROLES = ['Dzīvokļa īpašnieks', 'Mājas vecākais / pilnvarotā persona', 'Dzīvokļu īpašnieku biedrības pārstāvis', 'Cits'];
const UNITS = ['Līdz 20', '21–50', '51–100', 'Vairāk nekā 100'];

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const h = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function POST(request) {
  const form = await request.formData();
  const line = (key, max) => String(form.get(key) || '').replace(/[\x00-\x1F\x7F]+/g, ' ').trim().slice(0, max);

  if (form.get('_gotcha')) return json(200, { ok: true });

  const data = {
    name: line('name', 120),
    phone: line('phone', 40),
    email: line('email', 160),
    role: ROLES.includes(line('role', 80)) ? line('role', 80) : '—',
    address: line('address', 200),
    units: UNITS.includes(line('units', 40)) ? line('units', 40) : '—',
    message: String(form.get('message') || '').trim().slice(0, 5000),
  };

  const errors = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push('email');
  if (!data.address) errors.push('address');
  if (!form.get('consent')) errors.push('consent');
  if (data.phone && !/^[0-9+()\s-]{6,}$/.test(data.phone)) errors.push('phone');
  if (errors.length) return json(422, { ok: false, error: 'validation', fields: errors });

  const rows = [
    ['Vārds, uzvārds', data.name],
    ['Tālrunis', data.phone],
    ['E-pasts', data.email],
    ['Jūs esat', data.role],
    ['Mājas adrese', data.address],
    ['Dzīvokļu skaits mājā', data.units],
    ['Ziņojums', data.message],
    ['Piekrišana datu apstrādei', 'Jā'],
  ].map(([label, value]) => [label, value || '—']);

  const html =
    '<div style="max-width:640px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222A31">' +
    '<h1 style="margin:0 0 16px;font-size:20px">Jauns konsultācijas pieteikums</h1>' +
    '<table role="presentation" style="width:100%;border-collapse:collapse">' +
    rows.map(([label, value]) =>
      '<tr><th style="text-align:left;vertical-align:top;padding:10px 16px 10px 0;border-top:1px solid #D8DEDC;color:#5A646E;white-space:nowrap">' +
      h(label) + '</th><td style="padding:10px 0;border-top:1px solid #D8DEDC">' + h(value).replace(/\n/g, '<br>') + '</td></tr>'
    ).join('') +
    '</table></div>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [TO_EMAIL],
      reply_to: data.email,
      subject: `${SUBJECT} - ${data.name || data.email}`,
      html,
      text: rows.map(([label, value]) => `${label}: ${value}`).join('\n'),
    }),
  });

  if (!res.ok) {
    console.error('Resend error', res.status, await res.text());
    return json(500, { ok: false, error: 'mail' });
  }
  return json(200, { ok: true });
}
