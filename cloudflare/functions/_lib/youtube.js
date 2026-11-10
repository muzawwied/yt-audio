// Ekstraksi audio YouTube langsung dari API player (client IOS) — tanpa yt-dlp.
// Dipakai bareng oleh /api/resolve dan /api/stream/:id.

const IOS_UA = 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)';
const CLIENT_VERSION = '20.10.4';

export const MIME_BY_TYPE = {
  'audio/mp4': 'audio/mp4',
  'audio/webm': 'audio/webm',
};

export function videoIdFromUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const okHost = ['youtube.com', 'youtu.be', 'music.youtube.com', 'youtube-nocookie.com'].includes(host);
  if (!okHost) return null;
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1);
  else if (u.searchParams.get('v')) id = u.searchParams.get('v');
  else {
    const m = u.pathname.match(/\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,})/);
    if (m) id = m[1];
  }
  if (!id) return null;
  id = id.split(/[?&/]/)[0];
  return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
}

/** Ambil detail + URL audio langsung untuk sebuah video id. */
export async function resolveAudio(id) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': IOS_UA,
      'X-Goog-Api-Format-Version': '2',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify({
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
      context: {
        client: {
          clientName: 'IOS',
          clientVersion: CLIENT_VERSION,
          deviceModel: 'iPhone16,2',
          osName: 'iPhone',
          osVersion: '18.1.0.22B83',
          hl: 'en',
          gl: 'US',
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error('YouTube menolak permintaan (HTTP ' + res.status + ').');
  }
  const data = await res.json();
  const status = data?.playabilityStatus?.status;
  if (status && status !== 'OK') {
    const reason = data?.playabilityStatus?.reason || status;
    throw new Error('Video tidak bisa diputar: ' + reason);
  }

  const details = data?.videoDetails || {};
  const formats = data?.streamingData?.adaptiveFormats || [];
  const audio = formats.filter(
    (f) => typeof f.mimeType === 'string' && f.mimeType.startsWith('audio/') && typeof f.url === 'string'
  );
  if (!audio.length) throw new Error('Audio untuk video ini tidak tersedia.');

  const score = (f) => {
    let s = Number(f.bitrate) || 0;
    if (f.mimeType.includes('mp4a')) s += 100000; // AAC paling kompatibel
    return s;
  };
  audio.sort((a, b) => score(b) - score(a));
  const pick = audio[0];
  const mime = pick.mimeType.split(';')[0].trim();

  const thumbs = Array.isArray(details.thumbnail?.thumbnails) ? details.thumbnail.thumbnails : [];
  const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';

  return {
    id,
    audioUrl: pick.url,
    mime,
    title: details.title || 'Tanpa judul',
    artist: details.author || 'YouTube',
    thumb,
    duration: Number(details.lengthSeconds) || 0,
  };
}
