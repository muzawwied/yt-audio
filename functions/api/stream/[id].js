import { resolveAudio } from '../../_lib/youtube.js';

// URL audio di-cache per-colo (Cache API) supaya permintaan stream berikutnya
// tidak perlu resolve ulang — resolve ulang itulah yang paling sering kena blokir bot.
const TTL_SECONDS = 45 * 60;
const CACHE_ORIGIN = 'https://yt-audio-cache.internal';

function jsonErr(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cacheKey(id) {
  return new Request(CACHE_ORIGIN + '/audio/' + id, { method: 'GET' });
}

async function readCache(id) {
  try {
    const hit = await caches.default.match(cacheKey(id));
    if (!hit) return null;
    const data = await hit.json();
    return data && data.audioUrl && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

async function writeCache(entry) {
  try {
    const body = JSON.stringify({ audioUrl: entry.audioUrl, mime: entry.mime, exp: Date.now() + TTL_SECONDS * 1000 });
    await caches.default.put(
      cacheKey(entry.id),
      new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + TTL_SECONDS },
      })
    );
  } catch {
    /* cache opsional */
  }
}

/** Resolve dengan beberapa percobaan: blokir bot bersifat acak. */
async function resolveWithRetry(id, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const a = await resolveAudio(id);
      await writeCache({ id, audioUrl: a.audioUrl, mime: a.mime });
      return { audioUrl: a.audioUrl, mime: a.mime };
    } catch (e) {
      lastErr = e;
      if (!/bot|sign in|login/i.test(e.message || '')) break;
      if (i < attempts - 1) await sleep(250 + i * 350);
    }
  }
  throw lastErr || new Error('Gagal menyiapkan audio.');
}

const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

const CHUNK = 2 * 1024 * 1024; // 2 MB per permintaan

/**
 * Rentang terbuka ("bytes=0-") membuat sumber memotong stream di tengah,
 * jadi selalu kita minta potongan berukuran tetap. Browser akan meminta
 * potongan berikutnya sendiri saat butuh.
 */
function boundedRange(range) {
  if (!range) return { range: 'bytes=0-' + (CHUNK - 1), bounded: true, start: 0 };
  const m = String(range).match(/bytes=(\d*)-(\d*)/);
  if (!m) return { range: 'bytes=0-' + (CHUNK - 1), bounded: true, start: 0 };
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const endGiven = m[2] ? parseInt(m[2], 10) : null;
  const end = endGiven === null || endGiven - start + 1 > CHUNK ? start + CHUNK - 1 : endGiven;
  return { range: 'bytes=' + start + '-' + end, bounded: true, start, end };
}

async function fetchUpstream(audioUrl, range) {
  const headers = { 'User-Agent': BROWSER_UA, Accept: '*/*' };
  if (range) headers.Range = range;
  return fetch(audioUrl, { headers, redirect: 'follow' });
}

export async function onRequestGet({ params, request }) {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return jsonErr('ID video tidak valid.');

  const clientRange = request.headers.get('Range') || '';
  const span = boundedRange(clientRange);
  const range = span.range;

  let src = await readCache(id);
  if (!src) {
    try {
      src = await resolveWithRetry(id);
    } catch (e) {
      return jsonErr(e.message || 'Gagal menyiapkan audio.', 502);
    }
  }

  let upstream;
  try {
    upstream = await fetchUpstream(src.audioUrl, range);
  } catch {
    upstream = null;
  }

  // URL bisa kedaluwarsa atau terikat IP colo lain: resolve ulang lalu coba sekali lagi.
  if (!upstream || (!upstream.ok && upstream.status !== 206)) {
    try {
      src = await resolveWithRetry(id);
      upstream = await fetchUpstream(src.audioUrl, range);
    } catch (e) {
      return jsonErr(e.message || 'Gagal menyiapkan audio.', 502);
    }
  }

  if (!upstream.ok && upstream.status !== 206) {
    return jsonErr('Sumber audio menolak permintaan (' + upstream.status + ').', 502);
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || src.mime || 'audio/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'no-store');
  const len = upstream.headers.get('content-length');
  const crange = upstream.headers.get('content-range');
  if (len) headers.set('Content-Length', len);
  if (crange) headers.set('Content-Range', crange);

  // Kalau klien tidak minta range apa pun, tetap balas 200 dengan potongan pertama
  // supaya pemutar bisa mulai, lalu meminta sisanya lewat Range.
  if (!clientRange) {
    headers.set('Content-Range', 'bytes 0-' + (CHUNK - 1) + '/*');
  }
  return new Response(upstream.body, { status: 206, headers });
}

export async function onRequestHead(context) {
  const res = await onRequestGet(context);
  return new Response(null, { status: res.status, headers: res.headers });
}
