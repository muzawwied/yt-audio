import { resolveAudio, videoIdFromUrl } from '../_lib/youtube.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost({ request }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Body harus JSON.' }, 400);
  }
  const id = videoIdFromUrl(payload?.url);
  if (!id) return json({ error: 'Itu bukan tautan YouTube yang valid.' }, 400);

  try {
    const a = await resolveAudio(id);
    try {
      // Simpan URL audio di cache colo supaya permintaan /api/stream tidak perlu resolve ulang.
      await caches.default.put(
        new Request('https://yt-audio-cache.internal/audio/' + id),
        new Response(JSON.stringify({ audioUrl: a.audioUrl, mime: a.mime, exp: Date.now() + 45 * 60 * 1000 }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=2700' },
        })
      );
    } catch (e) {}
    return json({
      id: a.id,
      title: a.title,
      artist: a.artist,
      thumb: a.thumb,
      duration: a.duration,
      stream: '/api/stream/' + a.id,
    });
  } catch (e) {
    return json({ error: e.message || 'Gagal mengambil audio.' }, 502);
  }
}

export async function onRequestGet() {
  return json({ error: 'Gunakan POST dengan {"url": "..."}.' }, 405);
}
