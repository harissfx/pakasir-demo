/**
 * DEMO ALUR KERJA PAKASIR PAYMENT GATEWAY
 * ----------------------------------------
 * Tujuan: belajar alur integrasi payment gateway Pakasir (app.pakasir.com)
 *
 * Alur lengkap:
 *  1. User klik "Bayar" di aplikasi kita  -> POST /checkout
 *  2. Server bikin order_id unik, lalu request "create transaction" ke Pakasir
 *  3. Pakasir balikin payment_url (QRIS/VA) -> user diarahkan ke sana untuk bayar
 *  4. Setelah user bayar, Pakasir kirim POST ke webhook kita -> /webhook/pakasir
 *  5. Server JANGAN langsung percaya webhook mentah-mentah:
 *     -> kita re-check status transaksi via API detail Pakasir (double-check)
 *     -> baru update status order di database kita
 *
 * Env yang dibutuhkan (lihat .env.example):
 *  PAKASIR_PROJECT  = slug project di dashboard Pakasir
 *  PAKASIR_API_KEY  = api key project di dashboard Pakasir
 *  PORT             = port server lokal, default 3000
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('public')); // menyajikan public/index.html di http://localhost:3000/

const PAKASIR_BASE = 'https://app.pakasir.com/api';
const { PAKASIR_PROJECT, PAKASIR_API_KEY, PORT = 3000 } = process.env;

if (!PAKASIR_PROJECT || !PAKASIR_API_KEY) {
  console.error('PAKASIR_PROJECT dan PAKASIR_API_KEY wajib diisi di file .env (lihat .env.example)');
  process.exit(1);
}

// Whitelist metode pembayaran, supaya input user tidak masuk mentah ke URL API
const ALLOWED_METHODS = ['qris', 'bni_va', 'bri_va'];

// "Database" sementara pakai object in-memory, cukup buat belajar alurnya
const orders = new Map();

/**
 * STEP 1: User memulai checkout dari aplikasi kita.
 * Kita generate order_id unik lalu minta Pakasir buatkan transaksi.
 */
app.post('/checkout', async (req, res) => {
  try {
    const { amount, method = 'qris' } = req.body;

    if (!Number.isInteger(amount) || amount < 1000) {
      return res.status(400).json({ error: 'amount harus bilangan bulat, minimal Rp1.000' });
    }
    if (!ALLOWED_METHODS.includes(method)) {
      return res.status(400).json({ error: 'metode pembayaran tidak didukung' });
    }

    // order_id harus unik di sisi kita
    const orderId = `ORDER-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    // Endpoint resmi: POST /api/transactioncreate/{method}  (method masuk di URL, bukan di body)
    const response = await fetch(`${PAKASIR_BASE}/transactioncreate/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: PAKASIR_PROJECT,
        api_key: PAKASIR_API_KEY,
        order_id: orderId,
        amount: amount,
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.payment) {
      console.error('Gagal membuat transaksi:', data);
      return res.status(502).json({ error: 'Gagal membuat transaksi di Pakasir', detail: data });
    }

    // Simpan order lokal dengan status "pending" sebelum user membayar
    orders.set(orderId, {
      orderId,
      amount,
      status: 'pending',
      createdAt: new Date(),
    });

    // API transactioncreate TIDAK mengirim payment_url langsung, hanya payment_number
    // (QR string atau nomor VA). Untuk redirect ke halaman bayar visual Pakasir,
    // kita bangun sendiri URL-nya lewat pola: /pay/{slug}/{amount}?order_id={order_id}
    const paymentUrl = `https://app.pakasir.com/pay/${PAKASIR_PROJECT}/${amount}?order_id=${orderId}`;

    // STEP 2: Kirim payment_url ke frontend supaya user diarahkan ke sana
    return res.json({
      order_id: orderId,
      payment_url: paymentUrl,
      payment_number: data.payment.payment_number, // QR string / nomor VA mentah, kalau mau ditampilkan sendiri
      total_payment: data.payment.total_payment,
      expired_at: data.payment.expired_at,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * STEP 3: Endpoint ini didaftarkan sebagai Webhook URL di dashboard Pakasir.
 * Contoh payload yang dikirim Pakasir saat status transaksi berubah:
 * {
 *   "amount": 22000,
 *   "order_id": "ORDER-...",
 *   "project": "slug-project-anda",
 *   "status": "completed",
 *   "payment_method": "qris",
 *   "completed_at": "2026-09-03T08:07:02.819+07:00"
 * }
 *
 * PENTING: webhook mentah bisa dipalsukan siapa saja kalau URL-nya ketebak.
 * Praktik amannya: setelah terima webhook, cocokkan project slug-nya,
 * lalu tetap konfirmasi status transaksi lewat API detail Pakasir
 * (bukan cuma percaya body request yang masuk).
 */
app.post('/webhook/pakasir', async (req, res) => {
  const { order_id, project } = req.body;

  // Validasi dasar: pastikan notifikasi ini memang untuk project kita
  if (project !== PAKASIR_PROJECT) {
    return res.status(400).json({ error: 'project tidak cocok' });
  }

  const localOrder = orders.get(order_id);
  if (!localOrder) {
    return res.status(404).json({ error: 'order tidak ditemukan' });
  }

  // Idempoten: kalau Pakasir kirim ulang webhook untuk order yang sudah lunas, abaikan
  if (localOrder.status === 'completed') {
    return res.status(200).json({ received: true });
  }

  try {
    // STEP 4: Double-check langsung ke server Pakasir, jangan percaya webhook mentah
    const detailUrl = `${PAKASIR_BASE}/transactiondetail?project=${PAKASIR_PROJECT}&order_id=${order_id}&amount=${localOrder.amount}&api_key=${PAKASIR_API_KEY}`;
    const detailRes = await fetch(detailUrl);
    const detail = await detailRes.json();

    // Fail closed: kalau verifikasi gagal, JANGAN fallback ke status dari body webhook
    const verifiedStatus = detail.transaction?.status;
    if (!detailRes.ok || !verifiedStatus) {
      console.error('Verifikasi gagal untuk order', order_id, detail);
      return res.status(502).json({ error: 'verifikasi ke Pakasir gagal' });
    }

    if (verifiedStatus === 'completed') {
      localOrder.status = 'completed';
      localOrder.completedAt = new Date();
      console.log(`✅ Order ${order_id} lunas, saldo/akses user bisa di-update di sini`);
    } else {
      console.log(`ℹ️ Order ${order_id} status: ${verifiedStatus}`);
    }

    orders.set(order_id, localOrder);

    // Pakasir mengharapkan respons 200 supaya tidak retry terus-menerus
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Gagal verifikasi webhook:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * STEP 5 (opsional): endpoint untuk frontend polling status pembayaran,
 * dipakai kalau webhook belum masuk atau untuk cek manual.
 */
app.get('/order/:orderId', (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'tidak ditemukan' });
  res.json(order);
});

app.listen(PORT, () => {
  console.log(`Demo Pakasir jalan di http://localhost:${PORT}`);
  console.log(`Webhook URL untuk didaftarkan di dashboard Pakasir: http://<domain-publik-anda>:${PORT}/webhook/pakasir`);
});
