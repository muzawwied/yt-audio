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
