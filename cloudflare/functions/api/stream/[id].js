import { resolveAudio } from '../../_lib/youtube.js';

// Cache URL audio per isolate: hemat 1 subrequest dan bikin seek cepat.
// URL googlevideo terikat IP egress Worker, jadi kalau pindah colo/kedaluwarsa
// kita resolve ulang otomatis di bawah.
const cache = new Map(); // id -> { audioUrl, mime, exp }
const TTL_MS = 45 * 60 * 1000;

function badRequest(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function getSource(id) {
  const hit = cache.get(id);
  if (hit && hit.exp > Date.now()) return hit;
  const a = await resolveAudio(id);
  const entry = { audioUrl: a.audioUrl, mime: a.mime, exp: Date.now() + TTL_MS };
  cache.set(id, entry);
  return entry;
}

async function fetchAudio(id, range, forceRefresh) {
  if (forceRefresh) cache.delete(id);
  const src = await getSource(id);
  const headers = {};
  if (range) headers.Range = range;
  // UA browser biasa: sebagian endpoint menolak UA kosong
  headers['User-Agent'] = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
  const res = await fetch(src.audioUrl, { headers, redirect: 'follow' });
  return { res, mime: src.mime };
}

export async function onRequestGet({ params, request }) {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return badRequest('ID video tidak valid.');

  const range = request.headers.get('Range') || '';
  let attempt;
  try {
    attempt = await fetchAudio(id, range, false);
  } catch (e) {
    return badRequest(e.message || 'Gagal menyiapkan audio.', 502);
  }

  if ((!attempt.res.ok && attempt.res.status !== 206) || [403, 410].includes(attempt.res.status)) {
    try {
      attempt = await fetchAudio(id, range, true);
    } catch (e) {
      return badRequest(e.message || 'Gagal menyiapkan audio.', 502);
    }
  }

  const upstream = attempt.res;
  if (!upstream.ok && upstream.status !== 206) {
    return badRequest('Sumber audio menolak permintaan (' + upstream.status + ').', 502);
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || attempt.mime || 'audio/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'no-store');
  const len = upstream.headers.get('content-length');
  const crange = upstream.headers.get('content-range');
  if (len) headers.set('Content-Length', len);
  if (crange) headers.set('Content-Range', crange);

  return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
}

export async function onRequestHead(context) {
  const res = await onRequestGet(context);
  return new Response(null, { status: res.status, headers: res.headers });
}
