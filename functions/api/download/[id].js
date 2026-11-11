import { resolveAudio } from '../../_lib/youtube.js';

// Unduh audio utuh sebagai satu file. Sumber menolak permintaan rentang terbuka
// (stream terpotong), jadi kita ambil per potongan lalu sambung berurutan.

const CHUNK = 4 * 1024 * 1024;
const MAX_TOTAL = 120 * 1024 * 1024; // batas aman 120 MB per file
const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonErr(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function resolveWithRetry(id, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await resolveAudio(id);
    } catch (e) {
      lastErr = e;
      if (!/bot|sign in|login/i.test(e.message || '')) break;
      if (i < attempts - 1) await sleep(200 + i * 300);
    }
  }
  throw lastErr || new Error('Gagal menyiapkan audio.');
}

function fetchChunk(url, start, end) {
  return fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, Range: 'bytes=' + start + '-' + end, Accept: '*/*' },
    redirect: 'follow',
  });
}

function safeName(title, ext) {
  const base = String(title || 'audio')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'audio';
  return base + '.' + ext;
}

export async function onRequestGet({ params }) {
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return jsonErr('ID video tidak valid.');

  let info;
  try {
    info = await resolveWithRetry(id);
  } catch (e) {
    return jsonErr(e.message || 'Gagal menyiapkan audio.', 502);
  }

  const ext = (info.mime || '').includes('webm') ? 'webm' : 'm4a';
  const filename = safeName(info.title, ext);

  // Potongan pertama: sekaligus ambil ukuran total dari Content-Range.
  let first;
  try {
    first = await fetchChunk(info.audioUrl, 0, CHUNK - 1);
  } catch {
    first = null;
  }
  if (!first || (!first.ok && first.status !== 206)) {
    try {
      info = await resolveWithRetry(id);
      first = await fetchChunk(info.audioUrl, 0, CHUNK - 1);
    } catch (e) {
      return jsonErr(e.message || 'Gagal mengunduh audio.', 502);
    }
  }
  if (!first.ok && first.status !== 206) {
    return jsonErr('Sumber audio menolak permintaan (' + first.status + ').', 502);
  }

  const crange = first.headers.get('content-range') || '';
  const m = crange.match(/\/(\d+)/);
  const total = m ? parseInt(m[1], 10) : parseInt(first.headers.get('content-length') || '0', 10) || 0;
  if (total > MAX_TOTAL) {
    return jsonErr('File terlalu besar untuk diunduh (' + Math.round(total / 1048576) + ' MB).', 413);
  }

  const contentType = first.headers.get('content-type') || info.mime || 'audio/mp4';
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition':
      'attachment; filename="' + filename.replace(/[^\x20-\x7E]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename),
    'Cache-Control': 'no-store',
  });
  if (total) headers.set('Content-Length', String(total));

  let sent = 0;
  let audioUrl = info.audioUrl;
  let pending = first;

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        // Kalau tidak ada ukuran total, berhenti saat potongan kosong.
        if (total && sent >= total) {
          controller.close();
          return;
        }
        let res = pending;
        pending = null;
        if (!res) {
          const start = sent;
          const end = total ? Math.min(start + CHUNK - 1, total - 1) : start + CHUNK - 1;
          res = await fetchChunk(audioUrl, start, end);
          if (!res.ok && res.status !== 206) {
            // URL bisa kedaluwarsa di tengah unduhan: resolve ulang sekali
            const fresh = await resolveWithRetry(id, 2);
            audioUrl = fresh.audioUrl;
            res = await fetchChunk(audioUrl, start, end);
          }
          if (!res.ok && res.status !== 206) {
            controller.error(new Error('Sumber audio menolak permintaan (' + res.status + ')'));
            return;
          }
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!buf.byteLength) {
          controller.close();
          return;
        }
        sent += buf.byteLength;
        controller.enqueue(buf);
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(stream, { status: 200, headers });
}
