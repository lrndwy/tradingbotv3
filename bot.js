// Memuat environment variables dari file .env
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();

// Mengambil kredensial dari process.env
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Validasi: Pastikan variabel lingkungan sudah diatur
if (!TELEGRAM_BOT_TOKEN) {
    console.error("Error: Pastikan TELEGRAM_BOT_TOKEN sudah diatur di dalam file .env");
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- Database Setup ---
const db = new sqlite3.Database('./crypto_bot_data.db', (err) => {
    if (err) {
        console.error("Error opening database", err.message);
    } else {
        console.log("Database connected successfully.");
        // Tabel untuk data pasar
        db.run(`CREATE TABLE IF NOT EXISTS market_data (
            symbol TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL,
            PRIMARY KEY (symbol, timestamp)
        )`);
        // Tabel untuk pengguna
        db.run(`CREATE TABLE IF NOT EXISTS users (
            telegram_id INTEGER PRIMARY KEY,
            chat_id INTEGER NOT NULL,
            first_name TEXT,
            notification_interval TEXT DEFAULT '4h',
            notifications_enabled INTEGER DEFAULT 1
        )`);
    }
});

// --- Variabel Global ---
const CRYPTOS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'];
let fearAndGreedIndex = { value: 50, classification: 'Neutral' };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Fungsi Manajemen Pengguna (Tidak ada perubahan) ---
function findOrCreateUser(msg) {
    return new Promise((resolve, reject) => {
        const { id, first_name } = msg.from;
        const chat_id = msg.chat.id;
        db.get("SELECT * FROM users WHERE telegram_id = ?", [id], (err, user) => {
            if (err) return reject(err);
            if (user) {
                resolve(user);
            } else {
                db.run("INSERT INTO users (telegram_id, chat_id, first_name) VALUES (?, ?, ?)", [id, chat_id, first_name], function (err) {
                    if (err) return reject(err);
                    console.log(`\nNew user registered: ${first_name} (ID: ${id})`);
                    db.get("SELECT * FROM users WHERE telegram_id = ?", [id], (err, newUser) => {
                        if (err) return reject(err);
                        resolve(newUser);
                    });
                });
            }
        });
    });
}
function getUser(telegram_id) {
     return new Promise((resolve, reject) => {
        db.get("SELECT * FROM users WHERE telegram_id = ?", [telegram_id], (err, user) => {
            if (err) return reject(err);
            resolve(user);
        });
    });
}
function updateUserSetting(telegram_id, setting, value) {
    return new Promise((resolve, reject) => {
        db.run(`UPDATE users SET ${setting} = ? WHERE telegram_id = ?`, [value, telegram_id], function(err) {
            if (err) return reject(err);
            resolve();
        });
    });
}

// --- Fungsi Pengambilan & Penyimpanan Data (Tidak ada perubahan) ---
async function getFearAndGreedIndex() {
    try {
        const response = await axios.get('https://api.alternative.me/fng/?limit=1');
        const data = response.data.data[0];
        fearAndGreedIndex = { value: parseInt(data.value), classification: data.value_classification };
    } catch (error) {
        console.error('❌ Could not fetch F&G Index:', error.message);
    }
}
async function fetchAndStoreHistoricalData(symbol, interval = '1h', limit = 200) {
    const symbols = { 'BTC': 'BTCUSDT', 'ETH': 'ETHUSDT', 'SOL': 'SOLUSDT', 'BNB': 'BNBUSDT', 'XRP': 'XRPUSDT' };
    try {
        const response = await axios.get(
            `https://api.binance.com/api/v3/klines?symbol=${symbols[symbol]}&interval=${interval}&limit=${limit}`,
            { timeout: 30000 }
        );
        const stmt = db.prepare("INSERT OR IGNORE INTO market_data (symbol, timestamp, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)");
        response.data.forEach(kline => {
            stmt.run(symbol, kline[0], parseFloat(kline[1]), parseFloat(kline[2]), parseFloat(kline[3]), parseFloat(kline[4]), parseFloat(kline[5]));
        });
        stmt.finalize();
        // Log ini tidak lagi diperlukan di sini agar CLI lebih bersih
        // console.log(`✅ Fetched and stored ${response.data.length} data points for ${symbol} (${interval})`);
        return true;
    } catch (error) {
        console.error(`\n❌ Gagal mengambil data historis untuk ${symbol}:`, error.message);
        return false;
    }
}
function getDataFromDB(symbol, interval = '1h', limit = 100) {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM market_data WHERE symbol = ? ORDER BY timestamp DESC LIMIT ?`, [symbol, limit], (err, rows) => {
            if (err) reject(err);
            resolve(rows.reverse());
        });
    });
}

// --- Analisis Engine (Tidak ada perubahan) ---
function technicalAnalysis(data) {
    if (!data || data.length < 50) return null;
    const closes = data.map(d => d.close);
    const rsi = (()=>{
        let gains = 0; let losses = 0;
        for (let i = data.length - 14; i < data.length; i++) {
            const change = closes[i] - closes[i - 1];
            if (change > 0) gains += change; else losses -= change;
        }
        const avgGain = gains / 14; const avgLoss = losses / 14;
        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    })();
    const bb = (()=>{
        const period = 20;
        if(closes.length < period) return null;
        const slice = closes.slice(-period);
        const sma = slice.reduce((a, b) => a + b, 0) / period;
        const stdDev = Math.sqrt(slice.map(x => Math.pow(x - sma, 2)).reduce((a, b) => a + b) / period);
        return { middle: sma, upper: sma + (stdDev * 2), lower: sma - (stdDev * 2) };
    })();
     if (!bb) return null;
    const macd = (()=>{
        const ema = (data, period) => {
            const k = 2 / (period + 1); let result = [data[0]];
            for (let i = 1; i < data.length; i++) { result.push(data[i] * k + result[i-1] * (1 - k)); }
            return result;
        };
        const ema12 = ema(closes, 12); const ema26 = ema(closes, 26);
        const macdLine = ema12.map((val, i) => val - ema26[i]);
        const signalLine = ema(macdLine, 9);
        const histogram = macdLine.map((val, i) => val - signalLine[i]);
        return { macd: macdLine.at(-1), signal: signalLine.at(-1), histogram: histogram.at(-1), prev_histogram: histogram.at(-2) || 0 };
    })();
    return { rsi, bb, macd };
}
function predictPriceMovement(symbol, analysis, longTermTrend, fngIndex) {
    if (!analysis) return null;
    let buyPoints = 0; let sellPoints = 0; let reasons = [];
    const lastDataPoint = analysis.bb.middle;
    if (analysis.rsi < 30) { buyPoints += 2; reasons.push("RSI Oversold"); }
    if (analysis.rsi > 70) { sellPoints += 2; reasons.push("RSI Overbought"); }
    if (lastDataPoint < analysis.bb.lower) { buyPoints += 3; reasons.push("Harga di bawah Lower BB"); }
    if (lastDataPoint > analysis.bb.upper) { sellPoints += 2; reasons.push("Harga di atas Upper BB"); }
    if (analysis.macd.histogram > 0 && analysis.macd.prev_histogram < 0) { buyPoints += 2; reasons.push("MACD Bullish Crossover"); }
    if (analysis.macd.histogram < 0 && analysis.macd.prev_histogram > 0) { sellPoints += 2; reasons.push("MACD Bearish Crossover"); }
    if (longTermTrend.trend === 'Bullish') { buyPoints += 2; reasons.push("Tren 4H Bullish"); }
    if (longTermTrend.trend === 'Bearish') { sellPoints += 2; reasons.push("Tren 4H Bearish"); }
    if (fngIndex.value < 25) { buyPoints += 2; reasons.push("Pasar Extreme Fear"); }
    if (fngIndex.value > 75) { sellPoints += 2; reasons.push("Pasar Extreme Greed"); }
    const confidence = Math.max(buyPoints, sellPoints) / 13 * 100;
    if (buyPoints > sellPoints && buyPoints >= 5) return { action: 'BUY', confidence: confidence, reason: reasons.join(', ') };
    if (sellPoints > buyPoints && sellPoints >= 5) return { action: 'SELL', confidence: confidence, reason: reasons.join(', ') };
    return { action: 'HOLD', confidence: 0, reason: "Sinyal tidak cukup kuat" };
}

// --- FUNGSI ANALISIS UTAMA (DIPERBARUI) ---
// Fungsi ini sekarang tidak lagi mengambil data dari internet, tapi langsung dari DB.
async function runFullAnalysis() {
    let report = `<b>🚨 Laporan Analisis Sinyal 🚨</b>\n<i>${new Date().toLocaleString('id-ID')}</i>\n--------------------------------------\n`;
    let signalFound = false;

    console.log(`\n🔍 Menjalankan analisis penuh dari data yang ada...`);
    await getFearAndGreedIndex();
    report += `\n<b>Indeks Pasar:</b> ${fearAndGreedIndex.value} (${fearAndGreedIndex.classification})\n--------------------------------------\n`;

    for (const symbol of CRYPTOS) {
        // MENGAMBIL DATA DARI DATABASE LOKAL (BUKAN FETCH BARU)
        const data1h = await getDataFromDB(symbol, '1h', 100);
        const data4h = await getDataFromDB(symbol, '4h', 100);

        if (!data1h || data1h.length < 50 || !data4h || data4h.length < 50) {
            console.log(`⚠️ Data di DB tidak cukup untuk ${symbol}, analisis dilewati.`);
            continue;
        }

        const analysis1h = technicalAnalysis(data1h);
        const analysis4h = technicalAnalysis(data4h);

        if (!analysis1h || !analysis4h) {
            console.log(`⚠️ Gagal melakukan analisis teknikal untuk ${symbol}`);
            continue;
        }

        const longTermTrend = { trend: analysis4h.rsi > 50 ? 'Bullish' : 'Bearish' };
        const prediction = predictPriceMovement(symbol, analysis1h, longTermTrend, fearAndGreedIndex);
        const currentPrice = data1h[data1h.length - 1].close;

        if (prediction && prediction.action !== 'HOLD') {
            signalFound = true;
            const emoji = prediction.action === 'BUY' ? '🟢' : '🔴';
            report += `${emoji} <b>${symbol}</b> - Sinyal: <b>${prediction.action}</b>\n`;
            report += `   - <b>Harga:</b> $${currentPrice.toFixed(2)}\n`;
            report += `   - <b>Keyakinan:</b> ${prediction.confidence.toFixed(0)}%\n`;
            report += `   - <b>Alasan:</b> ${prediction.reason}\n--------------------------------------\n`;
        }
    }

    console.log('✅ Analisis Komprehensif Selesai.');
    return { report, signalFound };
}

// --- Bot Interaction & Handlers (Tidak ada perubahan signifikan) ---
// (Kode dari bagian ini hingga sebelum "Penjadwal (Cron Job) Cerdas" tetap sama)
const mainMenuKeyboard = {
    inline_keyboard: [
        [{ text: '⚡ Analisis Manual', callback_data: 'run_analysis' }, { text: '📈 Status Pasar', callback_data: 'market_status' }],
        [{ text: '⚙️ Pengaturan Notifikasi', callback_data: 'open_settings' }],
        [{ text: '❓ Bantuan', callback_data: 'show_help' }]
    ]
};
async function getSettingsKeyboard(telegram_id) {
    const user = await getUser(telegram_id);
    const interval = user.notification_interval;
    const notifStatus = user.notifications_enabled ? '✅ AKTIF' : '❌ NONAKTIF';
    const toggleNotifText = user.notifications_enabled ? 'Matikan Notifikasi' : 'Aktifkan Notifikasi';

    return {
        inline_keyboard: [
            [{ text: `Status Notifikasi: ${notifStatus}`, callback_data: 'do_nothing' }],
            [{ text: toggleNotifText, callback_data: 'toggle_notifications' }],
            [{ text: 'Ubah Interval Notifikasi', callback_data: 'do_nothing' }],
            [
                { text: interval === '15m' ? '✅ 15m' : '15m', callback_data: 'set_interval_15m' },
                { text: interval === '30m' ? '✅ 30m' : '30m', callback_data: 'set_interval_30m' }
            ],
            [
                { text: interval === '1h' ? '✅ 1j' : '1j', callback_data: 'set_interval_1h' },
                { text: interval === '4h' ? '✅ 4j' : '4j', callback_data: 'set_interval_4h' }
            ],
            [{ text: '⬅️ Kembali ke Menu Utama', callback_data: 'back_to_main' }]
        ]
    };
}
bot.setMyCommands([
    { command: '/start', description: '🚀 Mulai bot & tampilkan menu utama' },
    { command: '/analyze', description: '⚡ Jalankan analisis penuh sekarang' },
    { command: '/status', description: '📈 Tampilkan harga pasar saat ini' },
    { command: '/settings', description: '⚙️ Buka pengaturan notifikasi' },
    { command: '/help', description: '❓ Tampilkan bantuan' },
]);
const sendMainMenu = async (chatId, text) => {
    bot.sendMessage(chatId, text, { reply_markup: mainMenuKeyboard, parse_mode: 'HTML' });
};
bot.onText(/\/start/, async (msg) => {
    await findOrCreateUser(msg);
    const text = `👋 Halo, <b>${msg.from.first_name}</b>!\n\nSelamat datang di Bot Trading Cerdas (v4.1).\nBot ini akan menganalisis pasar crypto dan mengirimkan sinyal berdasarkan beberapa indikator teknikal. Gunakan menu di bawah untuk memulai.`;
    sendMainMenu(msg.chat.id, text);
});
bot.onText(/\/help/, (msg) => {
    const helpText = `<b>Bantuan Bot Trading Cerdas</b>\n\n` +
        `/start - Menampilkan menu utama.\n` +
        `/analyze - Menjalankan analisis mendalam untuk semua koin secara manual.\n` +
        `/status - Menampilkan daftar harga terakhir dari koin yang dipantau.\n` +
        `/settings - Mengubah frekuensi notifikasi sinyal otomatis.\n\n` +
        `Bot ini secara otomatis menyimpan data pasar setiap 3 menit untuk memastikan analisis yang cepat dan akurat.`;
    bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'HTML' });
});
bot.onText(/\/analyze/, (msg) => { handleCallbackQuery({ data: 'run_analysis', message: msg, from: msg.from }); });
bot.onText(/\/status/, (msg) => { handleCallbackQuery({ data: 'market_status', message: msg, from: msg.from }); });
bot.onText(/\/settings/, (msg) => { handleCallbackQuery({ data: 'open_settings', message: msg, from: msg.from }); });
bot.on('callback_query', handleCallbackQuery);
async function handleCallbackQuery(query) {
    const { data, message, from } = query;
    const chatId = message.chat.id;
    const userId = from.id;
    await findOrCreateUser({ from, chat: { id: chatId } });
    switch (data) {
        case 'run_analysis':
            bot.sendMessage(chatId, "⏳ Memulai analisis dari data terbaru...");
            try {
                const { report, signalFound } = await runFullAnalysis();
                if (!signalFound) {
                    bot.sendMessage(chatId, "✅ Analisis selesai. Saat ini tidak ada sinyal BUY/SELL yang kuat ditemukan.", { parse_mode: 'HTML' });
                } else {
                    bot.sendMessage(chatId, report, { parse_mode: 'HTML' });
                }
            } catch (error) {
                console.error("Error during manual analysis:", error);
                bot.sendMessage(chatId, "Terjadi kesalahan saat menjalankan analisis.");
            }
            break;
        case 'market_status':
            let statusText = '<b>📊 Status Harga Terkini (dari cache):</b>\n';
            for (const symbol of CRYPTOS) {
                const data = await getDataFromDB(symbol, '1h', 1);
                if (data && data.length > 0) { statusText += `${symbol}: $${data[0].close.toFixed(2)}\n`; }
                else { statusText += `${symbol}: Data tidak tersedia\n`; }
            }
             await getFearAndGreedIndex();
             statusText += `\n<b>Indeks F&G:</b> ${fearAndGreedIndex.value} (${fearAndGreedIndex.classification})`
            bot.sendMessage(chatId, statusText, { parse_mode: 'HTML' });
            break;
        case 'show_help':
            const helpText = `<b>Bantuan Bot Trading Cerdas</b>\n\n/start - Menampilkan menu utama.\n/analyze - Menjalankan analisis mendalam.\n/status - Menampilkan harga terakhir.\n/settings - Mengubah frekuensi notifikasi.\n\nBot ini secara otomatis menyimpan data pasar setiap 3 menit.`;
            bot.sendMessage(chatId, helpText, { parse_mode: 'HTML' });
            break;
        case 'open_settings':
            const settingsKeyboard = await getSettingsKeyboard(userId);
            bot.editMessageText('⚙️ <b>Pengaturan Notifikasi</b>\n\nAtur frekuensi sinyal otomatis dan aktifkan/nonaktifkan notifikasi.', { chat_id: chatId, message_id: message.message_id, reply_markup: settingsKeyboard, parse_mode: 'HTML' })
               .catch(() => { bot.sendMessage(chatId, '⚙️ <b>Pengaturan Notifikasi</b>\n\nAtur frekuensi sinyal otomatis.', { reply_markup: settingsKeyboard, parse_mode: 'HTML' }); });
            break;
        case 'toggle_notifications':
            const user = await getUser(userId);
            const newStatus = user.notifications_enabled ? 0 : 1;
            await updateUserSetting(userId, 'notifications_enabled', newStatus);
            bot.answerCallbackQuery(query.id, { text: `Notifikasi telah ${newStatus ? 'diaktifkan' : 'dimatikan'}.` });
            const refreshedSettingsKeyboard = await getSettingsKeyboard(userId);
            bot.editMessageReplyMarkup(refreshedSettingsKeyboard, { chat_id: chatId, message_id: message.message_id });
            break;
        case 'set_interval_15m': case 'set_interval_30m': case 'set_interval_1h': case 'set_interval_4h':
            const interval = data.split('_')[2];
            await updateUserSetting(userId, 'notification_interval', interval);
            const intervalText = interval.replace('m', ' Menit').replace('h', ' Jam');
            bot.answerCallbackQuery(query.id, { text: `Interval diatur ke ${intervalText}.` });
            const updatedKeyboard = await getSettingsKeyboard(userId);
            bot.editMessageReplyMarkup(updatedKeyboard, { chat_id: chatId, message_id: message.message_id });
            break;
        case 'back_to_main':
            bot.editMessageText("Anda kembali ke menu utama.", { chat_id: chatId, message_id: message.message_id, reply_markup: mainMenuKeyboard });
            break;
        case 'do_nothing':
             bot.answerCallbackQuery(query.id);
             break;
    }
    if (!['do_nothing', 'toggle_notifications', 'set_interval_15m', 'set_interval_30m', 'set_interval_1h', 'set_interval_4h'].includes(data)) {
        bot.answerCallbackQuery(query.id).catch(()=>{});
    }
}


// --- Penjadwal Notifikasi Pengguna (Cron Job) ---
cron.schedule('*/15 * * * *', async () => {
    // ... (Kode di dalam penjadwal ini tidak berubah)
    const now = new Date();
    const minute = now.getMinutes();
    const hour = now.getHours();
    console.log(`\n🕒 Menjalankan Penjadwal Notifikasi Pengguna pada ${now.toLocaleTimeString('id-ID')}...`);
    try {
        const users = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM users WHERE notifications_enabled = 1", (err, rows) => { if (err) reject(err); resolve(rows); });
        });
        if (users.length === 0) { console.log("Tidak ada pengguna aktif untuk dinotifikasi."); return; }
        const { report, signalFound } = await runFullAnalysis();
        if (!signalFound) { console.log("Tidak ada sinyal kuat untuk dikirim sebagai notifikasi."); return; }
        for (const user of users) {
            let shouldSend = false;
            switch (user.notification_interval) {
                case '15m': shouldSend = true; break;
                case '30m': if (minute === 0 || minute === 30) shouldSend = true; break;
                case '1h': if (minute === 0) shouldSend = true; break;
                case '4h': if (minute === 0 && hour % 4 === 0) shouldSend = true; break;
            }
            if (shouldSend) {
                try {
                    await bot.sendMessage(user.chat_id, report, { parse_mode: 'HTML' });
                    console.log(`✅ Notifikasi sinyal berhasil dikirim ke ${user.first_name} (ID: ${user.telegram_id})`);
                } catch (error) {
                    console.error(`❌ Gagal mengirim pesan ke ${user.first_name}: ${error.message}`);
                    if (error.response && error.response.statusCode === 403) {
                         console.log(`Bot diblokir oleh ${user.first_name}. Menonaktifkan notifikasi.`);
                         await updateUserSetting(user.telegram_id, 'notifications_enabled', 0);
                    }
                }
                await delay(300);
            }
        }
    } catch (error) {
        console.error("Error during scheduled notification dispatcher:", error);
    }
});


// --- BARU: Siklus Pengambilan Data Otomatis dengan Countdown ---

const DATA_FETCH_INTERVAL_SECONDS = 3 * 60; // 3 menit

/**
 * Fungsi untuk mengambil data semua koin dan menyimpannya ke DB.
 */
async function fetchAndCacheAllMarketData() {
    console.log(`\n\n[${new Date().toLocaleString('id-ID')}] 🔄 Memulai siklus pembaruan data pasar...`);
    for (const symbol of CRYPTOS) {
        await fetchAndStoreHistoricalData(symbol, '1h', 200);
        await fetchAndStoreHistoricalData(symbol, '4h', 100);
        await delay(500); // Penundaan kecil antar API call
    }
    console.log(`[${new Date().toLocaleString('id-ID')}] ✅ Siklus pembaruan data pasar selesai.`);
}

/**
 * Fungsi untuk menampilkan countdown di CLI.
 */
function startCliCountdown(seconds) {
    let remaining = seconds;
    const intervalId = setInterval(() => {
        const minutes = Math.floor(remaining / 60);
        const secs = remaining % 60;
        // process.stdout.write akan menimpa baris yang sama di console
        process.stdout.write(`⏳ Pembaruan data berikutnya dalam: ${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')} \r`);
        remaining--;
        if (remaining < 0) {
            clearInterval(intervalId);
        }
    }, 1000);
}

/**
 * Loop utama yang mengatur siklus pengambilan data dan countdown.
 */
async function dataFetchLoop() {
    await fetchAndCacheAllMarketData();
    startCliCountdown(DATA_FETCH_INTERVAL_SECONDS);
    // Menjadwalkan eksekusi berikutnya setelah interval selesai
    setTimeout(dataFetchLoop, DATA_FETCH_INTERVAL_SECONDS * 1000);
}

// --- Mulai Bot ---
console.log("🚀 Bot Cerdas (v4.1) Dimulai... Siap untuk umum!");
// Memulai siklus pengambilan data untuk pertama kali
dataFetchLoop();
