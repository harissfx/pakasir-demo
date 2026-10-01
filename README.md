# Demo Alur Kerja Pakasir Payment Gateway

Proyek kecil untuk belajar cara kerja integrasi payment gateway [Pakasir](https://app.pakasir.com) (QRIS & Virtual Account Indonesia).

## Alur kerja

```
User klik "Bayar"
      |
      v
POST /checkout  --------->  Pakasir API (create transaction)
      |                             |
      |  <--------------------------
      v
payment_url dikembalikan ke user (QRIS / VA)
      |
      v
User membayar di halaman Pakasir
      |
      v
Pakasir kirim POST -> /webhook/pakasir (di server kita)
      |
      v
Server re-check status transaksi ke API detail Pakasir (double-check)
      |
      v
Status order diupdate jadi "completed", saldo/akses user diproses
```

## Cara menjalankan

1. Daftar & buat project di https://app.pakasir.com untuk dapat `PAKASIR_PROJECT` (slug) dan `PAKASIR_API_KEY`.
2. Salin `.env.example` jadi `.env`, isi dengan slug dan API key kamu.
3. Install dependensi:
   ```
   npm install
   ```
4. Jalankan server:
   ```
   npm start
   ```
5. Buka `http://localhost:3000` di browser — ada halaman sederhana (`public/index.html`) untuk isi nominal & metode pembayaran, lalu klik "Bayar Sekarang" untuk memicu `/checkout` dan diarahkan ke halaman bayar Pakasir.

   Atau tanpa browser, langsung lewat curl:
   ```
   curl -X POST http://localhost:3000/checkout \
     -H "Content-Type: application/json" \
     -d '{"amount": 10000, "method": "qris"}'
   ```
6. Untuk webhook, server kamu harus bisa diakses dari internet (pakai `ngrok` misalnya saat development), lalu daftarkan URL webhook di dashboard Pakasir: `https://<domain-publik>/webhook/pakasir`.
7. Untuk simulasi pembayaran tanpa scan QR beneran (mode testing), Pakasir menyediakan endpoint simulasi:
   ```
   curl -X POST https://app.pakasir.com/api/paymentsimulation \
     -H "Content-Type: application/json" \
     -d '{"project":"slug-project-anda","order_id":"ORDER-xxx","amount":10000,"api_key":"api-key-anda"}'
   ```

## Poin penting yang perlu dipahami

- **order_id harus unik** — dipakai Pakasir & kita untuk melacak transaksi yang sama.
- **Jangan percaya webhook mentah-mentah.** Body POST ke endpoint webhook bisa saja dipalsukan kalau URL-nya bocor/ketebak. Selalu konfirmasi ulang status transaksi lewat API detail Pakasir sebelum update saldo/akses user (lihat komentar di `app.js`).
- **Respons webhook harus 200 OK** kalau sudah diproses, supaya Pakasir tidak retry terus-menerus.
- Di kode ini, "database" cuma pakai `Map()` di memori supaya alurnya gampang dibaca — di aplikasi nyata ganti dengan database sungguhan (Postgres, MySQL, dll).

## Catatan

- Proyek ini hanya **demo untuk belajar**: database in-memory, tanpa autentikasi, tanpa rate limiting. Jangan dipakai langsung di production.
- Butuh Node.js 18+ (memakai `fetch` bawaan).
- Jangan pernah commit file `.env`. Kalau API key sempat ter-commit, ganti key-nya di dashboard Pakasir.
