// Ekstraksi audio YouTube lewat API player, tanpa yt-dlp.
// Beberapa client dipakai bergiliran karena YouTube sesekali menolak satu client
// dengan "Sign in to confirm you're not a bot" (terutama dari IP datacenter).

const IOS_UA = 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)';
const VR_UA = 'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12; GB) gzip';
const ANDROID_UA = 'com.google.android.youtube/19.44.38 (Linux; U; Android 14) gzip';

const CLIENTS = [
  {
    name: 'IOS',
    version: '20.10.4',
    ua: IOS_UA,
    extra: { deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.1.0.22B83' },
  },
  {
    name: 'ANDROID_VR',
    version: '1.61.48',
    ua: VR_UA,
    extra: { androidSdkVersion: 32, osName: 'Android', osVersion: '12', deviceMake: 'Oculus', deviceModel: 'Quest 3' },
  },
  {
    name: 'IOS',
    version: '19.45.4',
    ua: IOS_UA,
    extra: { deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.1.0.22B83' },
  },
  {
    name: 'ANDROID',
    version: '19.44.38',
    ua: ANDROID_UA,
    extra: { androidSdkVersion: 34, osName: 'Android', osVersion: '14' },
  },
];

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

/** visitorData menurunkan peluang blokir bot; diambil sekali per isolate. */
let visitorCache = { value: '', exp: 0 };
async function getVisitorData() {
  if (visitorCache.value && visitorCache.exp > Date.now()) return visitorCache.value;
  try {
    const r = await fetch('https://www.youtube.com/?hl=en&gl=US', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const html = await r.text();
    const m = html.match(/"VISITOR_DATA":"([^"]+)"/) || html.match(/"visitorData":"([^"]+)"/);
    if (m) {
      visitorCache = { value: m[1], exp: Date.now() + 60 * 60 * 1000 };
      return visitorCache.value;
    }
  } catch {
    /* diabaikan: visitorData opsional */
  }
  return '';
}

function pickBestAudio(formats) {
  const audio = formats.filter(
    (f) => typeof f.mimeType === 'string' && f.mimeType.startsWith('audio/') && typeof f.url === 'string'
  );
  if (!audio.length) return null;
  const score = (f) => {
    let s = Number(f.bitrate) || 0;
    if (f.mimeType.includes('mp4a')) s += 100000; // AAC paling kompatibel di browser
    return s;
  };
  audio.sort((a, b) => score(b) - score(a));
  return audio[0];
}

async function callPlayer(id, client, visitorData) {
  const ua = client.ua;
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': ua,
      'X-Goog-Api-Format-Version': '2',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify({
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
      context: {
        client: {
          clientName: client.name,
          clientVersion: client.version,
          hl: 'en',
          gl: 'US',
          ...(visitorData ? { visitorData } : {}),
          ...client.extra,
        },
      },
    }),
  });
  if (!res.ok) throw new Error('YouTube menolak permintaan (HTTP ' + res.status + ').');
  return res.json();
}

/** Ambil detail + URL audio langsung untuk sebuah video id. */
export async function resolveAudio(id) {
  const errors = [];
  let visitorData = '';

  for (let i = 0; i < CLIENTS.length; i++) {
    const client = CLIENTS[i];
    // Visitor data dicoba mulai percobaan kedua
    if (i === 1 && !visitorData) visitorData = await getVisitorData();

    let data;
    try {
      data = await callPlayer(id, client, visitorData);
    } catch (e) {
      errors.push(e.message);
      continue;
    }

    const status = data?.playabilityStatus?.status;
    const reason = data?.playabilityStatus?.reason || '';
    if (status && status !== 'OK') {
      errors.push(reason || status);
      continue;
    }

    const formats = data?.streamingData?.adaptiveFormats || [];
    const pick = pickBestAudio(formats);
    if (!pick) {
      errors.push('audio tidak tersedia');
      continue;
    }

    const details = data?.videoDetails || {};
    const thumbs = Array.isArray(details.thumbnail?.thumbnails) ? details.thumbnail.thumbnails : [];
    return {
      id,
      audioUrl: pick.url,
      mime: pick.mimeType.split(';')[0].trim(),
      title: details.title || 'Tanpa judul',
      artist: details.author || 'YouTube',
      thumb: thumbs.length ? thumbs[thumbs.length - 1].url : 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg',
      duration: Number(details.lengthSeconds) || 0,
      client: client.name,
    };
  }

  const joined = errors.join(' | ');
  if (/bot|sign in|login required/i.test(joined)) {
    throw new Error('YouTube sedang memblokir server ini untuk video tersebut (blokir bot). Coba lagi beberapa saat atau pakai video lain.');
  }
  throw new Error('Gagal mengambil audio: ' + (errors[errors.length - 1] || 'tidak diketahui'));
}
