# Putar Audio YouTube (server kecil)

Tempel tautan YouTube, audio diputar di latar belakang (layar mati pun tetap bunyi).
Server kecil ini mengambil aliran audio lewat `yt-dlp` lalu memproksikannya, jadi
tidak kena blokir background-play seperti embed resmi YouTube.

Isi paket:

```
server.js                  server HTTP tanpa dependency npm
public/index.html          player (antrean, Media Session, bisa di-install sebagai app)
public/manifest.webmanifest
public/icon.svg
Dockerfile                 jalur Docker
deploy.sh                  pasang cepat di VPS Ubuntu/Debian
```

## Syarat server

VPS kecil sudah cukup: 1 vCPU, RAM 512 MB–1 GB, disk 10 GB.
Butuh `node` >= 18, `python3`, `ffmpeg` (opsional tapi disarankan), dan `yt-dlp`.

## Pasang cepat di VPS (Ubuntu/Debian)

```bash
# 1. upload folder ini ke server, lalu masuk ke foldernya
cd yt-audio

# 2. jalankan pemasang
sudo bash deploy.sh
```

Setelah selesai, buka `http://IP-SERVER:8080`.

Supaya bisa di-install sebagai app dan HTTPS-nya aman, pasang domain lalu balik
proxy. Contoh Caddy (paling ringkas, sertifikat otomatis):

```
audio.domainmu.com {
    reverse_proxy 127.0.0.1:8080
}
```

## Jalur Docker

```bash
docker build -t yt-audio .
docker run -d --name yt-audio -p 8080:8080 --restart unless-stopped yt-audio
```

## Menjalankan manual

```bash
node server.js          # default port 8080, ubah dengan env PORT
```

## Perawatan rutin (penting)

YouTube sering mengubah sistemnya. `yt-dlp` harus rutin diperbarui, kalau tidak
resolve akan gagal dengan pesan seperti "sign in to confirm you're not a bot".

Timer otomatis harian (buat sekali):

```bash
sudo tee /etc/cron.daily/ytdlp-update >/dev/null <<'EOF'
#!/bin/sh
/usr/local/bin/yt-dlp -U >/dev/null 2>&1 || true
EOF
sudo chmod +x /etc/cron.daily/ytdlp-update
```

Kalau server berada di IP datacenter dan YouTube menolak, tambahkan cookies dari
browser yang sudah login:

```bash
# ekspor cookies dengan ekstensi "Get cookies.txt", simpan ke /etc/yt-audio/cookies.txt
# lalu jalankan server dengan:
YTDLP_COOKIES=/etc/yt-audio/cookies.txt node server.js
```

## Cara pakai

1. Buka halamannya, tempel satu atau beberapa tautan YouTube.
2. Tekan *Tambahkan*. Lagu pertama langsung diputar.
3. Kunci layar. Audio tetap jalan dan kontrolnya muncul di notifikasi/lockscreen.
4. Daftar putar tersimpan di HP, jadi besok tinggal tekan putar.

## Catatan hukum

Mengunduh/memutar ulang audio YouTube di luar aplikasi resmi melanggar Ketentuan
Layanan YouTube. Pakai untuk keperluan pribadi, jangan didistribusikan sebagai
produk publik atau ke Play Store.
