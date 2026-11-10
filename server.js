// Server kecil: tempel link YouTube -> putar audio di latar belakang.
// Tanpa dependency npm. Butuh: node >= 18, yt-dlp, ffmpeg (opsional).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // URL googlevideo ±6 jam, ambil aman 4 jam
const MAX_BODY = 16 * 1024; // bytes

/** id video -> { audioUrl, mime, exp, title, artist, thumb, duration } */
const cache = new Map();

const MIME_BY_EXT = {
  m4a: 'audio/mp4',
  webm: 'audio/webm',
  opus: 'audio/webm',
  mp4: 'audio/mp4',
};

function isYouTubeUrl(input) {
  try {
    const u = new URL(input);
    const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (!['youtube.com', 'youtu.be', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) return false;
    if (host === 'youtu.be') return u.pathname.length > 1;
    return u.searchParams.has('v') || u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/live/');
  } catch {
    return false;
  }
}

function runYtDlp(url, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const args = ['-J', '--no-playlist', '--no-warnings', '--no-call-home', '--socket-timeout', '15', url];
    const child = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timeout saat mengambil data video.'));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.length > 12 * 1024 * 1024) {
        child.kill('SIGKILL');
        reject(new Error('Metadata video terlalu besar.'));
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('yt-dlp tidak bisa dijalankan: ' + e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(cleanErr(err) || ('yt-dlp keluar dengan kode ' + code)));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('Gagal membaca metadata video.'));
      }
    });
  });
}

function cleanErr(text) {
  return String(text || '')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('[debug]'))
    .slice(-3)
    .join(' ')
    .replace(/^ERROR:\s*/i, '')
    .slice(0, 300);
}

/** Pilih format audio terbaik yang bisa diputar browser. */
function pickAudioFormat(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const candidates = formats.filter(
    (f) => f && f.url && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && f.protocol !== 'mhtml'
  );
  const pool = candidates.length ? candidates : formats.filter((f) => f && f.url && f.acodec && f.acodec !== 'none' && f.protocol !== 'mhtml');
  if (!pool.length) return null;
  const score = (f) => {
    let s = Number(f.abr) || 0;
    if (f.ext === 'm4a') s += 40; // paling kompatibel (iOS + Android + desktop)
    if (f.ext === 'webm') s += 20;
    if (f.protocol && String(f.protocol).startsWith('m3u8')) s -= 100; // butuh proxy khusus
    return s;
  };
  return pool.sort((a, b) => score(b) - score(a))[0];
}

async function resolveVideo(url) {
  const info = await runYtDlp(url);
  if (!info || !info.id) throw new Error('Video tidak dikenali.');
  if (info.is_live) throw new Error('Siaran langsung belum didukung.');
  const fmt = pickAudioFormat(info);
  if (!fmt) throw new Error('Audio untuk video ini tidak tersedia.');

  const entry = {
    id: info.id,
    audioUrl: fmt.url,
    mime: MIME_BY_EXT[fmt.ext] || 'audio/mp4',
    ext: fmt.ext,
    title: info.title || 'Tanpa judul',
    artist: info.uploader || info.channel || 'YouTube',
    thumb: info.thumbnail || (Array.isArray(info.thumbnails) && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : ''),
    duration: Number(info.duration) || 0,
    exp: Date.now() + CACHE_TTL_MS,
  };
  cache.set(entry.id, entry);
  return entry;
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body terlalu besar.'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('JSON tidak valid.'));
      }
    });
    req.on('error', reject);
  });
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel.includes('..')) return json(res, 400, { error: 'Path tidak valid.' });
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 400, { error: 'Path tidak valid.' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA fallback
      if (rel !== 'index.html') return serveStatic(res, '/');
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const type = STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(buf);
  });
}

async function handleStream(req, res, id) {
  let entry = cache.get(id);
  if (!entry || entry.exp < Date.now() + 60 * 1000) {
    // coba segarkan lewat URL kanonis
    try {
      entry = await resolveVideo('https://www.youtube.com/watch?v=' + encodeURIComponent(id));
    } catch (e) {
      return json(res, 502, { error: 'Audio kedaluwarsa dan gagal diperbarui: ' + e.message });
    }
  }

  let target;
  try {
    target = new URL(entry.audioUrl);
  } catch {
    return json(res, 502, { error: 'URL audio tidak valid.' });
  }
  if (!/(^|\.)googlevideo\.com$/i.test(target.hostname)) {
    return json(res, 502, { error: 'Sumber audio tidak dikenal.' });
  }

  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(target.toString(), { headers, redirect: 'follow' });
  } catch (e) {
    return json(res, 502, { error: 'Gagal menyambung ke sumber audio.' });
  }

  if (!upstream.ok && upstream.status !== 206) {
    // URL bisa jadi sudah mati: paksa resolve ulang sekali
    try {
      entry = await resolveVideo('https://www.youtube.com/watch?v=' + encodeURIComponent(id));
      upstream = await fetch(entry.audioUrl, { headers });
    } catch (e) {
      return json(res, 502, { error: 'Sumber audio menolak permintaan (' + upstream.status + ').' });
    }
    if (!upstream.ok && upstream.status !== 206) {
      return json(res, 502, { error: 'Sumber audio menolak permintaan (' + upstream.status + ').' });
    }
  }

  const passHeaders = {
    'Content-Type': upstream.headers.get('content-type') || entry.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h);
    if (v) passHeaders[h] = v;
  }
  res.writeHead(upstream.status === 206 ? 206 : 200, passHeaders);

  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (res.writableEnded || res.destroyed) {
          try { await reader.cancel(); } catch {}
          return;
        }
        if (!res.write(Buffer.from(value))) {
          await new Promise((r) => res.once('drain', r));
        }
      }
    } catch {
      /* klien menutup koneksi */
    } finally {
      try { res.end(); } catch {}
    }
  };
  req.on('close', () => {
    try { reader.cancel(); } catch {}
  });
  pump();
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(u.pathname);

  if (pathname === '/health') return json(res, 200, { ok: true, cached: cache.size });

  if (pathname === '/api/resolve' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const url = String(body.url || '').trim();
      if (!isYouTubeUrl(url)) return json(res, 400, { error: 'Itu bukan tautan YouTube yang valid.' });
      const entry = await resolveVideo(url);
      return json(res, 200, {
        id: entry.id,
        title: entry.title,
        artist: entry.artist,
        thumb: entry.thumb,
        duration: entry.duration,
        stream: '/api/stream/' + entry.id,
      });
    } catch (e) {
      return json(res, 502, { error: e.message || 'Gagal mengambil audio.' });
    }
  }

  if (pathname.startsWith('/api/stream/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const id = pathname.slice('/api/stream/'.length).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) return json(res, 400, { error: 'ID video tidak valid.' });
    return handleStream(req, res, id);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Metode tidak didukung.' });
  return serveStatic(res, pathname);
});

server.listen(PORT, () => {
  console.log('yt-audio jalan di http://localhost:' + PORT);
});
