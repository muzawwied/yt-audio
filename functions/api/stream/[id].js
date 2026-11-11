import { resolveAudio } from '../../_lib/youtube.js';

// Sumber audio (googlevideo) memotong permintaan rentang terbuka, dan URL-nya
// terikat IP server yang me-resolve. Karena itu aliran disusun per potongan
// internal lalu dikirim sebagai satu respons utuh.

const CHUNK = 4 * 1024 * 1024;
const MAX_TOTAL = 120 * 1024 * 1024;
const CACHE_TTL = 45 * 60 * 1000;
const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** id -> { audioUrl, mime, total, exp } */
const mem = new Map();

function jsonErr(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function cacheKey(id) {
  return new Request('https://yt-audio-cache.internal/audio/' + id, { method: 'GET' });
}

async function readCache(id) {
  const hit = mem.get(id);
  if (hit && hit.exp > Date.now()) return hit;
  try {
    const res = await caches.default.match(cacheKey(id));
    if (!res) return null;
    const data = await res.json();
    if (!data || !data.audioUrl || data.exp < Date.now()) return null;
    mem.set(id, data);
    return data;
  } catch {
    return null;
  }
}

async function writeCache(entry) {
  mem.set(entry.id, entry);
  try {
    await caches.default.put(
      cacheKey(entry.id),
      new Response(JSON.stringify(entry), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=2700' },
      })
    );
  } catch {
    /* cache opsional */
  }
}

async function resolveWithRetry(id, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const a = await resolveAudio(id);
      const head = await fetch(a.audioUrl, {
        headers: { 'User-Agent': BROWSER_UA, Range: 'bytes=0-' + (CHUNK - 1), Accept: '*/*' },
        redirect: 'follow',
      });
      if (!head.ok && head.status !== 206) {
        lastErr = new Error('Sumber audio menolak permintaan (' + head.status + ').');
        continue;
      }
      const crange = head.headers.get('content-range') || '';
      const m = crange.match(/\/(\d+)/) || crange.match(/^bytes \d+-\d+\/(\d+)/);
      const total = m ? parseInt(m[1], 10) : parseInt(head.headers.get('content-length') || '0', 10) || 0;
      const firstBuf = new Uint8Array(await head.arrayBuffer());
      const entry = {
        id,
        audioUrl: a.audioUrl,
        mime: head.headers.get('content-type') || a.mime,
        total,
        exp: Date.now() + CACHE_TTL,
      };
      await writeCache(entry);
      return { entry, firstBuf };
    } catch (e) {
      lastErr = e;
      if (!/bot|sign in|login|menolak/i.test(e.message || '')) break;
      if (i < attempts - 1) await sleep(200 + i * 300);
    }
  }
  throw lastErr || new Error('Gagal menyiapkan audio.');
}

function fetchRange(url, start, end) {
  return fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, Range: 'bytes=' + start + '-' + end, Accept: '*/*' },
    redirect: 'follow',
  });
}

/** Aliran utuh: potongan pertama sudah di tangan, sisanya diambil berurutan. */
function fullStream(id, entry, firstBuf) {
  let offset = firstBuf.byteLength;
  const total = entry.total || 0;
  return new ReadableStream({
    start(controller) {
      if (firstBuf.byteLength) controller.enqueue(firstBuf);
      if (total && offset >= total) controller.close();
    },
    async pull(controller) {
      try {
        if (total && offset >= total) {
          controller.close();
          return;
        }
        const end = total ? Math.min(offset + CHUNK - 1, total - 1) : offset + CHUNK - 1;
        let res = await fetchRange(entry.audioUrl, offset, end);
        if (!res.ok && res.status !== 206) {
          // URL kedaluwarsa di tengah jalan: resolve ulang lalu lanjutkan
          const fresh = await resolveWithRetry(id, 2);
          entry.audioUrl = fresh.entry.audioUrl;
          if (!entry.total) entry.total = fresh.entry.total;
          res = await fetchRange(entry.audioUrl, offset, end);
        }
        if (!res.ok && res.status !== 206) {
          controller.error(new Error('Sumber audio menolak permintaan (' + res.status + ')'));
          return;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!buf.byteLength) {
          controller.close();
          return;
        }
        offset += buf.byteLength;
        controller.enqueue(buf);
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

export async function onRequestGet({ params, request }) {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return jsonErr('ID video tidak valid.');

  const clientRange = request.headers.get('Range') || '';
  const askedFromStart = !clientRange || /^bytes=0-(\d*)$/.test(clientRange);

  let entry = await readCache(id);
  let firstBuf = null;

  if (!entry || askedFromStart) {
    try {
      const fresh = await resolveWithRetry(id);
      entry = fresh.entry;
      firstBuf = fresh.firstBuf;
    } catch (e) {
      if (!entry) return jsonErr(e.message || 'Gagal menyiapkan audio.', 502);
    }
  }

  if (!entry) return jsonErr('Gagal menyiapkan audio.', 502);
  if (entry.total && entry.total > MAX_TOTAL) {
    return jsonErr('File terlalu besar (' + Math.round(entry.total / 1048576) + ' MB).', 413);
  }

  const headers = new Headers({
    'Content-Type': entry.mime || 'audio/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });

  // Mulai dari awal: kirim seluruh file sebagai satu aliran (paling stabil untuk
  // lagu panjang dan untuk pemutaran latar belakang).
  if (askedFromStart) {
    if (entry.total) headers.set('Content-Length', String(entry.total));
    return new Response(fullStream(id, entry, firstBuf || new Uint8Array(0)), { status: 200, headers });
  }

  // Lompat ke posisi tertentu (seek): layani satu potongan berukuran tetap.
  const m = clientRange.match(/bytes=(\d+)-(\d*)/);
  const start = m ? parseInt(m[1], 10) : 0;
  const endGiven = m && m[2] ? parseInt(m[2], 10) : null;
  const end = endGiven === null || endGiven - start + 1 > CHUNK ? start + CHUNK - 1 : endGiven;
  const finalEnd = entry.total ? Math.min(end, entry.total - 1) : end;

  try {
    let res = await fetchRange(entry.audioUrl, start, finalEnd);
    if (!res.ok && res.status !== 206) {
      const fresh = await resolveWithRetry(id, 2);
      entry = fresh.entry;
      res = await fetchRange(entry.audioUrl, start, finalEnd);
    }
    if (!res.ok && res.status !== 206) {
      return jsonErr('Sumber audio menolak permintaan (' + res.status + ').', 502);
    }
    const len = res.headers.get('content-length');
    const crange = res.headers.get('content-range');
    if (len) headers.set('Content-Length', len);
    if (crange) headers.set('Content-Range', crange);
    else if (entry.total) headers.set('Content-Range', 'bytes ' + start + '-' + finalEnd + '/' + entry.total);
    return new Response(res.body, { status: 206, headers });
  } catch (e) {
    return jsonErr(e.message || 'Gagal menyiapkan audio.', 502);
  }
}

export async function onRequestHead(context) {
  const res = await onRequestGet(context);
  return new Response(null, { status: res.status, headers: res.headers });
}
