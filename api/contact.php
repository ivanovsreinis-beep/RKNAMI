<?php
/*
  RK NAMI — pieteikuma formas apstrāde (PHP 7.4+)
  Saņem POST no js/main.js un nosūta pieteikumu uz info@rknami.lv.
  Atbilde vienmēr ir JSON: {"ok": true} vai {"ok": false, "error": "..."}.

  FROM_EMAIL jābūt adresei tavā domēnā (rknami.lv), citādi hostinga
  pasta serveris vai saņēmēja SPF/DMARC pārbaude vēstuli var noraidīt.
*/

const TO_EMAIL   = 'info@rknami.lv';
const FROM_EMAIL = 'noreply@rknami.lv';
const FROM_NAME  = 'RK NAMI mājaslapa';
const SUBJECT    = 'Jauns konsultācijas pieteikums no mājaslapas';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

function respond(int $code, array $body): void {
    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}

// Viena rinda bez vadības simboliem (novērš galvenes injekciju)
function line(string $key, int $max): string {
    $value = trim((string)($_POST[$key] ?? ''));
    $value = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $value);
    return mb_substr($value, 0, $max);
}

function text(string $key, int $max): string {
    $value = trim(str_replace("\r\n", "\n", (string)($_POST[$key] ?? '')));
    $value = preg_replace('/[\x00-\x08\x0B-\x1F\x7F]+/u', '', $value);
    return mb_substr($value, 0, $max);
}

function h(string $s): string {
    return htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    respond(405, ['ok' => false, 'error' => 'method']);
}

// Surogātpasta slazds: roboti aizpilda slēpto lauku — izliekamies, ka viss kārtībā
if (!empty($_POST['_gotcha'])) {
    respond(200, ['ok' => true]);
}

$roles = ['Dzīvokļa īpašnieks', 'Mājas vecākais / pilnvarotā persona', 'Dzīvokļu īpašnieku biedrības pārstāvis', 'Cits'];
$units = ['Līdz 20', '21–50', '51–100', 'Vairāk nekā 100'];

$data = [
    'name'    => line('name', 120),
    'phone'   => line('phone', 40),
    'email'   => line('email', 160),
    'role'    => line('role', 80),
    'address' => line('address', 200),
    'units'   => line('units', 40),
    'message' => text('message', 5000),
    'consent' => !empty($_POST['consent']),
];

$errors = [];
if (!filter_var($data['email'], FILTER_VALIDATE_EMAIL)) $errors[] = 'email';
if ($data['address'] === '')                            $errors[] = 'address';
if (!$data['consent'])                                  $errors[] = 'consent';
if ($data['phone'] !== '' && !preg_match('/^[0-9+()\s\-]{6,}$/', $data['phone'])) $errors[] = 'phone';
if (!in_array($data['role'], $roles, true))             $data['role'] = '—';
if (!in_array($data['units'], $units, true))            $data['units'] = '—';

if ($errors) {
    respond(422, ['ok' => false, 'error' => 'validation', 'fields' => $errors]);
}

$who = $data['name'] !== '' ? $data['name'] : $data['email'];

$rows = [
    'Vārds, uzvārds'       => $data['name'],
    'Tālrunis'             => $data['phone'],
    'E-pasts'              => $data['email'],
    'Jūs esat'             => $data['role'],
    'Mājas adrese'         => $data['address'],
    'Dzīvokļu skaits mājā' => $data['units'],
    'Ziņojums'             => $data['message'],
    'Piekrišana datu apstrādei' => 'Jā',
];

// --- Vēstules saturs: HTML + teksta versija ---
$htmlRows = '';
$textRows = '';
foreach ($rows as $label => $value) {
    $shown = $value !== '' ? $value : '—';
    $htmlValue = nl2br(h($shown));
    if ($label === 'E-pasts')  $htmlValue = '<a href="mailto:' . h($shown) . '">' . h($shown) . '</a>';
    if ($label === 'Tālrunis' && $value !== '') $htmlValue = '<a href="tel:' . h(preg_replace('/[^0-9+]/', '', $value)) . '">' . h($shown) . '</a>';
    $htmlRows .= '<tr>'
        . '<th style="text-align:left;vertical-align:top;padding:10px 16px 10px 0;border-top:1px solid #D8DEDC;color:#5A646E;font-weight:600;white-space:nowrap">' . h($label) . '</th>'
        . '<td style="padding:10px 0;border-top:1px solid #D8DEDC;color:#222A31">' . $htmlValue . '</td>'
        . '</tr>';
    $textRows .= $label . ': ' . $shown . "\n";
}

$sent = date('d.m.Y H:i');
$html = '<!doctype html><html lang="lv"><body style="margin:0;padding:24px;background:#F3F5F4;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5">'
    . '<div style="max-width:640px;margin:0 auto;padding:28px;background:#FFFFFF;border-radius:10px">'
    . '<h1 style="margin:0 0 4px;font-size:20px;color:#222A31">Jauns konsultācijas pieteikums</h1>'
    . '<p style="margin:0 0 20px;color:#5A646E">Saņemts no rknami.lv ' . h($sent) . '</p>'
    . '<table role="presentation" style="width:100%;border-collapse:collapse">' . $htmlRows . '</table>'
    . '<p style="margin:20px 0 0;color:#5A646E;font-size:13px">Lai atbildētu, spiediet “Atbildēt” — vēstule aizies uz ' . h($data['email']) . '.</p>'
    . '</div></body></html>';

$text = "Jauns konsultācijas pieteikums (rknami.lv, $sent)\n\n" . $textRows;

// --- Nosūtīšana (multipart/alternative) ---
$boundary = 'b_' . bin2hex(random_bytes(12));
$encode = function (string $s): string {
    return '=?UTF-8?B?' . base64_encode($s) . '?=';
};

$headers = [
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
    'From: ' . $encode(FROM_NAME) . ' <' . FROM_EMAIL . '>',
    'Reply-To: ' . ($data['name'] !== '' ? $encode($data['name']) . ' ' : '') . '<' . $data['email'] . '>',
    'X-Mailer: PHP/' . PHP_VERSION,
];

$body = "--$boundary\r\n"
    . "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
    . chunk_split(base64_encode($text)) . "\r\n"
    . "--$boundary\r\n"
    . "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
    . chunk_split(base64_encode($html)) . "\r\n"
    . "--$boundary--";

$ok = mail(
    TO_EMAIL,
    $encode(SUBJECT . ' - ' . $who),
    $body,
    implode("\r\n", $headers),
    '-f' . FROM_EMAIL
);

if (!$ok) {
    error_log('RK NAMI contact form: mail() failed for ' . $data['email']);
    respond(500, ['ok' => false, 'error' => 'mail']);
}

respond(200, ['ok' => true]);
