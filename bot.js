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

// --- Database Setup (DIPERBARUI DENGAN TABEL SIMULASI) ---
const db = new sqlite3.Database('./crypto_bot_data_v5.db', (err) => {
    if (err) {
        console.error("Error opening database", err.message);
    } else {
        console.log("Database connected successfully.");
        // Tabel data pasar
        db.run(`CREATE TABLE IF NOT EXISTS market_data (
            symbol TEXT NOT NULL, timestamp INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, PRIMARY KEY (symbol, timestamp)
        )`);
        // Tabel pengguna
        db.run(`CREATE TABLE IF NOT EXISTS users (
            telegram_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, first_name TEXT, notification_interval TEXT DEFAULT '4h', notifications_enabled INTEGER DEFAULT 1
        )`);
        // ## BARU: Tabel untuk portofolio simulasi
        db.run(`CREATE TABLE IF NOT EXISTS portfolios (
            telegram_id INTEGER NOT NULL,
            symbol TEXT NOT NULL,
            amount REAL NOT NULL,
            avg_buy_price REAL NOT NULL,
            PRIMARY KEY (telegram_id, symbol)
        )`);
        // ## BARU: Tabel untuk riwayat transaksi
        db.run(`CREATE TABLE IF NOT EXISTS transactions (
            transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id INTEGER NOT NULL,
            symbol TEXT NOT NULL,
            type TEXT NOT NULL, -- 'buy' or 'sell'
            amount REAL NOT NULL,
            price REAL NOT NULL,
            timestamp INTEGER NOT NULL
        )`);
    }
});

// --- Variabel Global & Fungsi Helper ---
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
            if (user) { resolve(user); }
            else {
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
// (Fungsi getUser dan updateUserSetting tetap sama)
function getUser(telegram_id) { return new Promise((resolve, reject) => { db.get("SELECT * FROM users WHERE telegram_id = ?", [telegram_id], (err, user) => { if (err) reject(err); resolve(user); }); }); }
function updateUserSetting(telegram_id, setting, value) { return new Promise((resolve, reject) => { db.run(`UPDATE users SET ${setting} = ? WHERE telegram_id = ?`, [value, telegram_id], function (err) { if (err) reject(err); resolve(); }); }); }


// --- Fungsi Pengambilan & Penyimpanan Data (Tidak ada perubahan) ---
async function getFearAndGreedIndex() { try { const r = await axios.get('https://api.alternative.me/fng/?limit=1'); fearAndGreedIndex = { value: parseInt(r.data.data[0].value), classification: r.data.data[0].value_classification }; } catch (e) { console.error('❌ Could not fetch F&G Index:', e.message); } }
async function fetchAndStoreHistoricalData(symbol, interval = '1h') { const limit = interval === '1h' ? 500 : 250; const symbols = { 'BTC': 'BTCUSDT', 'ETH': 'ETHUSDT', 'SOL': 'SOLUSDT', 'BNB': 'BNBUSDT', 'XRP': 'XRPUSDT' }; try { const r = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbols[symbol]}&interval=${interval}&limit=${limit}`, { timeout: 30000 }); const stmt = db.prepare("INSERT OR IGNORE INTO market_data (symbol, timestamp, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)"); r.data.forEach(k => { stmt.run(symbol, k[0], parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5])); }); stmt.finalize(); return true; } catch (e) { console.error(`\n❌ Gagal mengambil data historis untuk ${symbol}:`, e.message); return false; } }
function getDataFromDB(symbol, limit = 500) { return new Promise((resolve, reject) => { db.all(`SELECT * FROM market_data WHERE symbol = ? ORDER BY timestamp DESC LIMIT ?`, [symbol, limit], (err, rows) => { if (err) reject(err); resolve(rows.reverse()); }); }); }
async function getLatestPrice(symbol) { const data = await getDataFromDB(symbol, 1); return data && data.length > 0 ? data[0].close : null; }


// --- Analisis Engine (Logika tidak berubah, masih v4.2) ---
function calculateStochasticRSI(rsiValues, period = 14) { if (rsiValues.length < period) return null; const relevantRsi = rsiValues.slice(-period); const lowestRsi = Math.min(...relevantRsi); const highestRsi = Math.max(...relevantRsi); if (highestRsi === lowestRsi) return { k: 50, d: 50 }; const stochRSI = 100 * ((relevantRsi.at(-1) - lowestRsi) / (highestRsi - lowestRsi)); const last3StochRSI = rsiValues.slice(-(period + 2)).map((_, i, arr) => { if (i < period - 1) return null; const slice = arr.slice(i - period + 1, i + 1); const low = Math.min(...slice); const high = Math.max(...slice); if (high === low) return 50; return 100 * ((slice.at(-1) - low) / (high - low)); }).filter(v => v !== null); const d_line = last3StochRSI.slice(-3).reduce((a, b) => a + b, 0) / 3; return { k: stochRSI, d: d_line }; }
function technicalAnalysis(data) { if (!data || data.length < 50) return null; const closes = data.map(d => d.close); const rsiPeriod = 14; const rsiValues = []; for (let i = rsiPeriod; i < closes.length; i++) { let gains = 0, losses = 0; for (let j = i - rsiPeriod + 1; j <= i; j++) { const change = closes[j] - closes[j - 1]; if (change > 0) gains += change; else losses -= change; } const avgGain = gains / rsiPeriod; const avgLoss = losses / rsiPeriod; if (avgLoss === 0) { rsiValues.push(100); continue; } const rs = avgGain / avgLoss; rsiValues.push(100 - (100 / (1 + rs))); } const currentRsi = rsiValues.at(-1); const stochRSI = calculateStochasticRSI(rsiValues, rsiPeriod); const prevStochRSI = calculateStochasticRSI(rsiValues.slice(0, -1), rsiPeriod); const bbPeriod = 20; const slice = closes.slice(-bbPeriod); const sma = slice.reduce((a, b) => a + b, 0) / bbPeriod; const stdDev = Math.sqrt(slice.map(x => Math.pow(x - sma, 2)).reduce((a, b) => a + b) / bbPeriod); const bb = { middle: sma, upper: sma + (stdDev * 2), lower: sma - (stdDev * 2) }; const ema = (s, p) => { let r = [s[0]]; for (let i = 1; i < s.length; i++) { r.push(s[i] * (2 / (p + 1)) + r[i - 1] * (1 - (2 / (p + 1)))); } return r; }; const ema12 = ema(closes, 12); const ema26 = ema(closes, 26); const macdLine = ema12.map((v, i) => v - ema26[i]); const signalLine = ema(macdLine, 9); const macd = { macd: macdLine.at(-1), signal: signalLine.at(-1), prev_macd: macdLine.at(-2), prev_signal: signalLine.at(-2) }; return { currentPrice: closes.at(-1), rsi: currentRsi, bb, macd, stochRSI: { current: stochRSI, previous: prevStochRSI } }; }
function predictPriceMovement(symbol, analysis, longTermTrend, fngIndex) { if (!analysis) return null; let buyScore = 0, sellScore = 0, reasons = []; const { currentPrice, rsi, bb, macd, stochRSI } = analysis; if (currentPrice < bb.lower) { buyScore += 3; reasons.push("Harga menembus Lower BB"); } if (currentPrice > bb.upper) { sellScore += 3; reasons.push("Harga menembus Upper BB"); } if (stochRSI.current.k > stochRSI.current.d && stochRSI.previous.k <= stochRSI.previous.d && stochRSI.current.k < 30) { buyScore += 3; reasons.push("StochRSI Bullish Crossover di area oversold"); } if (stochRSI.current.k < stochRSI.current.d && stochRSI.previous.k >= stochRSI.previous.d && stochRSI.current.k > 70) { sellScore += 3; reasons.push("StochRSI Bearish Crossover di area overbought"); } if (macd.macd > macd.signal && macd.prev_macd <= macd.prev_signal) { buyScore += 2; reasons.push("MACD Bullish Crossover"); } if (macd.macd < macd.signal && macd.prev_macd >= macd.prev_signal) { sellScore += 2; reasons.push("MACD Bearish Crossover"); } if (rsi < 35) { buyScore += 1; reasons.push("RSI mendekati oversold"); } if (rsi > 65) { sellScore += 1; reasons.push("RSI mendekati overbought"); } if (longTermTrend.trend === 'Bullish') { buyScore += 2; reasons.push("Tren 4H Bullish"); } if (longTermTrend.trend === 'Bearish') { sellScore += 2; reasons.push("Tren 4H Bearish"); } if (fngIndex.value < 25) { buyScore += 1; reasons.push("Pasar Extreme Fear"); } if (fngIndex.value > 75) { sellScore += 1; reasons.push("Pasar Extreme Greed"); } const confidence = (Math.max(buyScore, sellScore) / 12) * 100; if (buyScore >= 6 && buyScore > sellScore) return { action: 'BUY', confidence, reason: reasons.join(', ') }; if (sellScore >= 6 && sellScore > buyScore) return { action: 'SELL', confidence, reason: reasons.join(', ') }; return { action: 'HOLD', confidence: 0, reason: "Tidak ada sinyal konfirmasi yang kuat." }; }


// --- FUNGSI ANALISIS UTAMA (DIPERBARUI DENGAN LOGGING & NOTIFIKASI HOLD) ---
async function runFullAnalysis(logCallback = null) {
    const updateLog = async (text) => { if (logCallback) await logCallback(text); };

    await updateLog("<code>[1/4]</code> Mengambil indeks pasar...");
    await getFearAndGreedIndex();

    let fullReport = `<b>Analisis Pasar Komprehensif</b>\n<i>${new Date().toLocaleString('id-ID')}</i>\n\n`;
    fullReport += `<b>Indeks Pasar:</b> ${fearAndGreedIndex.value} (${fearAndGreedIndex.classification})\n--------------------------------------\n`;

    await updateLog("<code>[2/4]</code> Memeriksa data historis...");
    // (Data sudah diambil oleh siklus 3 menit, tahap ini hanya konseptual)
    await delay(500);

    await updateLog("<code>[3/4]</code> Menganalisis setiap aset...");
    for (const symbol of CRYPTOS) {
        if (logCallback) await updateLog(`<code>[3/4]</code> Menganalisis <b>${symbol}</b>...`);

        const data1h = await getDataFromDB(symbol, 500);
        const data4h = await getDataFromDB(symbol, 250);

        if (!data1h || data1h.length < 50 || !data4h || data4h.length < 50) continue;

        const analysis1h = technicalAnalysis(data1h);
        const analysis4h = technicalAnalysis(data4h);

        if (!analysis1h || !analysis4h) continue;

        const longTermTrend = { trend: analysis4h.rsi > 55 ? 'Bullish' : (analysis4h.rsi < 45 ? 'Bearish' : 'Netral') };
        const prediction = predictPriceMovement(symbol, analysis1h, longTermTrend, fearAndGreedIndex);
        const currentPrice = analysis1h.currentPrice;

        let emoji, actionText;
        if (prediction.action === 'BUY') {
            emoji = '🟢';
            actionText = `<b>Sinyal: ${prediction.action}</b>`;
        } else if (prediction.action === 'SELL') {
            emoji = '🔴';
            actionText = `<b>Sinyal: ${prediction.action}</b>`;
        } else {
            emoji = '⚪️';
            actionText = `<b>Sinyal: ${prediction.action}</b>`;
        }

        fullReport += `${emoji} <b>${symbol}</b> - ${actionText}\n`;
        fullReport += `   - <b>Harga:</b> $${currentPrice.toFixed(2)}\n`;
        if (prediction.action !== 'HOLD') {
            fullReport += `   - <b>Keyakinan:</b> ${prediction.confidence.toFixed(0)}%\n`;
        }
        fullReport += `   - <b>Alasan:</b> ${prediction.reason}\n`;

        // ## BARU: Menambahkan tombol aksi simulasi jika ada sinyal
        if (prediction.action !== 'HOLD') {
            fullReport += `   - <b>Aksi Simulasi:</b> [BUY 100 USDT](callback:buy_${symbol}_100) | [SELL 50%](callback:sell_${symbol}_50)\n`;
        }
        fullReport += `--------------------------------------\n`;
    }

    await updateLog("<code>[4/4]</code> Laporan selesai disusun.");
    await delay(500);

    return fullReport;
}


// --- BOT INTERACTION & SIMULATION ---

// Menu & Tombol
const mainMenuKeyboard = {
    inline_keyboard: [
        [{ text: '⚡ Analisis Manual', callback_data: 'run_analysis' }],
        [{ text: '💼 Portofolio & Simulasi', callback_data: 'portfolio_menu' }],
        [{ text: '⚙️ Pengaturan Notifikasi', callback_data: 'open_settings' }],
        [{ text: '❓ Bantuan', callback_data: 'show_help' }]
    ]
};

// ## BARU: Fungsi untuk menangani logika simulasi
async function handleBuy(userId, symbol, usdtAmount) {
    const price = await getLatestPrice(symbol);
    if (!price) return "Gagal mendapatkan harga terkini. Coba lagi.";

    const cryptoAmount = usdtAmount / price;

    db.get("SELECT * FROM portfolios WHERE telegram_id = ? AND symbol = ?", [userId, symbol], (err, row) => {
        if (err) { console.error(err); return "Error database."; }

        let newTotalAmount, newAvgPrice;
        if (row) { // Update portofolio yang ada
            newTotalAmount = row.amount + cryptoAmount;
            newAvgPrice = ((row.avg_buy_price * row.amount) + (price * cryptoAmount)) / newTotalAmount;
            db.run("UPDATE portfolios SET amount = ?, avg_buy_price = ? WHERE telegram_id = ? AND symbol = ?", [newTotalAmount, newAvgPrice, userId, symbol]);
        } else { // Buat entri baru
            newTotalAmount = cryptoAmount;
            newAvgPrice = price;
            db.run("INSERT INTO portfolios (telegram_id, symbol, amount, avg_buy_price) VALUES (?, ?, ?, ?)", [userId, symbol, newTotalAmount, newAvgPrice]);
        }
        // Catat transaksi
        db.run("INSERT INTO transactions (telegram_id, symbol, type, amount, price, timestamp) VALUES (?, ?, 'buy', ?, ?, ?)", [userId, symbol, cryptoAmount, price, Date.now()]);
    });

    return `✅ Berhasil membeli <b>${cryptoAmount.toFixed(6)} ${symbol}</b> dengan harga $${price.toFixed(2)} senilai ${usdtAmount} USDT.`;
}

async function handleSell(userId, symbol, percentage) {
    const price = await getLatestPrice(symbol);
    if (!price) return "Gagal mendapatkan harga terkini. Coba lagi.";

    return new Promise((resolve) => {
        db.get("SELECT * FROM portfolios WHERE telegram_id = ? AND symbol = ?", [userId, symbol], (err, row) => {
            if (err || !row || row.amount <= 0) {
                resolve(`❌ Anda tidak memiliki aset <b>${symbol}</b> untuk dijual.`);
                return;
            }

            const amountToSell = row.amount * (percentage / 100);
            const remainingAmount = row.amount - amountToSell;
            const realizedValue = amountToSell * price;
            const costOfSoldAmount = amountToSell * row.avg_buy_price;
            const profit = realizedValue - costOfSoldAmount;

            if (remainingAmount <= 0.000001) { // Jika sisa sangat kecil, hapus
                db.run("DELETE FROM portfolios WHERE telegram_id = ? AND symbol = ?", [userId, symbol]);
            } else {
                db.run("UPDATE portfolios SET amount = ? WHERE telegram_id = ? AND symbol = ?", [remainingAmount, userId, symbol]);
            }
            db.run("INSERT INTO transactions (telegram_id, symbol, type, amount, price, timestamp) VALUES (?, ?, 'sell', ?, ?, ?)", [userId, symbol, amountToSell, price, Date.now()]);

            const profitText = profit >= 0 ? `Keuntungan: $${profit.toFixed(2)}` : `Kerugian: $${Math.abs(profit).toFixed(2)}`;
            resolve(`✅ Berhasil menjual <b>${percentage}%</b> (${amountToSell.toFixed(6)} ${symbol}) pada harga $${price.toFixed(2)}.\n${profitText}`);
        });
    });
}

async function displayPortfolio(userId) {
    return new Promise(async (resolve) => {
        db.all("SELECT * FROM portfolios WHERE telegram_id = ?", [userId], async (err, rows) => {
            if (err || rows.length === 0) {
                resolve("💼 Portofolio Anda kosong. Mulai beli aset dari sinyal yang muncul!");
                return;
            }

            let portfolioText = "<b>💼 Portofolio Simulasi Anda</b>\n\n";
            let totalPortfolioValue = 0;
            let totalCost = 0;

            for (const asset of rows) {
                const currentPrice = await getLatestPrice(asset.symbol);
                if (!currentPrice) continue;

                const currentValue = asset.amount * currentPrice;
                const cost = asset.amount * asset.avg_buy_price;
                const pnl = currentValue - cost;
                const pnlPercent = (pnl / cost) * 100;

                const pnlEmoji = pnl >= 0 ? '📈' : '📉';

                portfolioText += `<b>${asset.symbol}</b>\n`;
                portfolioText += `   - Jumlah: ${asset.amount.toFixed(6)}\n`;
                portfolioText += `   - Rata² Beli: $${asset.avg_buy_price.toFixed(2)}\n`;
                portfolioText += `   - Harga Saat Ini: $${currentPrice.toFixed(2)}\n`;
                portfolioText += `   - ${pnlEmoji} P&L: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)\n\n`;

                totalPortfolioValue += currentValue;
                totalCost += cost;
            }

            const totalPnl = totalPortfolioValue - totalCost;
            const totalPnlPercent = (totalPnl / totalCost) * 100;
            const totalPnlEmoji = totalPnl >= 0 ? '💹' : '🔻';

            portfolioText += `--------------------------------------\n`;
            portfolioText += `<b>Total Nilai Portofolio:</b> $${totalPortfolioValue.toFixed(2)}\n`;
            portfolioText += `<b>${totalPnlEmoji} Total P&L:</b> $${totalPnl.toFixed(2)} (${totalPnlPercent.toFixed(2)}%)`;

            resolve(portfolioText);
        });
    });
}


// --- Handler Perintah & Callback ---
bot.setMyCommands([
    { command: '/start', description: '🚀 Mulai bot & tampilkan menu utama' },
    { command: '/analyze', description: '⚡ Jalankan analisis penuh sekarang' },
    { command: '/portfolio', description: '💼 Lihat portofolio simulasi Anda' },
    { command: '/settings', description: '⚙️ Buka pengaturan notifikasi' },
    { command: '/help', description: '❓ Tampilkan bantuan' },
]);

// (Fungsi sendMainMenu, onText /start, /help, /settings tidak berubah)
const sendMainMenu = async (chatId, text) => { bot.sendMessage(chatId, text, { reply_markup: mainMenuKeyboard, parse_mode: 'HTML' }); };
bot.onText(/\/start/, async (msg) => { await findOrCreateUser(msg); const text = `👋 Halo, <b>${msg.from.first_name}</b>!\n\nSelamat datang di Bot Trading Cerdas (v5.0).\nBot ini kini dilengkapi fitur simulasi trading. Gunakan menu di bawah.`; sendMainMenu(msg.chat.id, text); });
bot.onText(/\/help/, (msg) => { const helpText = `<b>Bantuan Bot Trading Cerdas v5.0</b>\n\n/start - Menampilkan menu utama.\n/analyze - Menjalankan analisis manual dengan log detail.\n/portfolio - Melihat aset dan keuntungan/kerugian dari trading simulasi.\n/settings - Mengubah frekuensi notifikasi.\n\n<b>Simulasi Trading:</b>\nSaat bot mengirim sinyal BUY/SELL, akan ada tombol aksi untuk melakukan 'pembelian' atau 'penjualan' virtual. Lacak hasilnya di menu portofolio!`; bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'HTML' }); });
bot.onText(/\/settings/, (msg) => { handleCallbackQuery({ data: 'open_settings', message: msg, from: msg.from }); });

// ## DIPERBARUI: Handler untuk perintah cepat
bot.onText(/\/analyze/, (msg) => { handleCallbackQuery({ data: 'run_analysis', message: msg, from: msg.from }); });
bot.onText(/\/portfolio/, (msg) => { handleCallbackQuery({ data: 'portfolio_menu', message: msg, from: msg.from }); });

// Handler utama untuk semua tombol inline
bot.on('callback_query', handleCallbackQuery);

async function handleCallbackQuery(query) {
    const { data, message, from } = query;
    const chatId = message.chat.id;
    const userId = from.id;
    await findOrCreateUser({ from, chat: { id: chatId } });

    // ## BARU: Parsing callback data untuk aksi simulasi
    if (data.startsWith('buy_') || data.startsWith('sell_')) {
        const parts = data.split('_');
        const action = parts[0];
        const symbol = parts[1];
        const value = parseInt(parts[2]);

        let resultMessage = "Aksi tidak diketahui.";
        if (action === 'buy') {
            resultMessage = await handleBuy(userId, symbol, value);
        } else if (action === 'sell') {
            resultMessage = await handleSell(userId, symbol, value);
        }
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, resultMessage, { parse_mode: 'HTML' });
        return;
    }

    switch (data) {
        case 'run_analysis':
            const sentMsg = await bot.sendMessage(chatId, "<code>[0/4]</code> ⏳ Memulai analisis...", { parse_mode: 'HTML' });
            const logCallback = async (text) => {
                try {
                    await bot.editMessageText(text, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'HTML' });
                } catch (e) { /* Abaikan error jika teks sama */ }
            };
            try {
                const report = await runFullAnalysis(logCallback);
                // Mengubah format tautan callback menjadi tombol
                const reportLines = report.split('\n');
                let finalReport = '';
                const buttons = [];
                let buttonRow = [];
                reportLines.forEach(line => {
                    const match = line.match(/\[(.*?)\]\(callback:(.*?)\)/);
                    if (match) {
                        if (buttonRow.length >= 2) {
                            buttons.push(buttonRow);
                            buttonRow = [];
                        }
                        buttonRow.push({ text: match[1], callback_data: match[2] });
                    } else {
                        finalReport += line + '\n';
                    }
                });
                if (buttonRow.length > 0) buttons.push(buttonRow);

                await bot.editMessageText(finalReport, {
                    chat_id: chatId,
                    message_id: sentMsg.message_id,
                    parse_mode: 'HTML',
                    reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : null
                });
            } catch (error) {
                console.error("Error during manual analysis:", error);
                await bot.editMessageText("❌ Terjadi kesalahan saat menjalankan analisis.", { chat_id: chatId, message_id: sentMsg.message_id });
            }
            break;

        case 'portfolio_menu':
            const portfolioText = await displayPortfolio(userId);
            bot.sendMessage(chatId, portfolioText, { parse_mode: 'HTML' });
            break;

        // (Kasus lain seperti open_settings, dll tidak berubah)
        case 'open_settings': const settingsKeyboard = await getSettingsKeyboard(userId); bot.editMessageText('⚙️ <b>Pengaturan Notifikasi</b>...', { chat_id: chatId, message_id: message.message_id, reply_markup: settingsKeyboard, parse_mode: 'HTML' }).catch(() => { bot.sendMessage(chatId, '⚙️ <b>Pengaturan Notifikasi</b>...', { reply_markup: settingsKeyboard, parse_mode: 'HTML' }); }); break;
        case 'toggle_notifications': const user = await getUser(userId); const newStatus = user.notifications_enabled ? 0 : 1; await updateUserSetting(userId, 'notifications_enabled', newStatus); bot.answerCallbackQuery(query.id, { text: `Notifikasi telah ${newStatus ? 'diaktifkan' : 'dimatikan'}.` }); const refreshedSettingsKeyboard = await getSettingsKeyboard(userId); bot.editMessageReplyMarkup(refreshedSettingsKeyboard, { chat_id: chatId, message_id: message.message_id }); break;
        case 'set_interval_15m': case 'set_interval_30m': case 'set_interval_1h': case 'set_interval_4h': const interval = data.split('_')[2]; await updateUserSetting(userId, 'notification_interval', interval); const intervalText = interval.replace('m', ' Menit').replace('h', ' Jam'); bot.answerCallbackQuery(query.id, { text: `Interval diatur ke ${intervalText}.` }); const updatedKeyboard = await getSettingsKeyboard(userId); bot.editMessageReplyMarkup(updatedKeyboard, { chat_id: chatId, message_id: message.message_id }); break;
        case 'back_to_main': bot.editMessageText("Anda kembali ke menu utama.", { chat_id: chatId, message_id: message.message_id, reply_markup: mainMenuKeyboard }); break;
        case 'do_nothing': bot.answerCallbackQuery(query.id); break;
        case 'show_help': const helpText = `<b>Bantuan Bot Trading Cerdas v5.0</b>\n\n/start - Menampilkan menu utama.\n/analyze - Menjalankan analisis manual.\n/portfolio - Melihat aset simulasi.\n/settings - Mengubah frekuensi notifikasi.`; bot.sendMessage(chatId, helpText, { parse_mode: 'HTML' }); break;
    }
    if (!query.data.startsWith('buy_') && !query.data.startsWith('sell_')) {
        bot.answerCallbackQuery(query.id).catch(() => { });
    }
}


// --- Penjadwal Notifikasi Pengguna (DIPERBARUI UNTUK MENGIRIM SEMUA NOTIFIKASI) ---
cron.schedule('*/15 * * * *', async () => {
    const now = new Date();
    console.log(`\n🕒 Menjalankan Penjadwal Notifikasi pada ${now.toLocaleTimeString('id-ID')}...`);
    try {
        const users = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM users WHERE notifications_enabled = 1", (err, rows) => { if (err) reject(err); resolve(rows); });
        });
        if (users.length === 0) { console.log("Tidak ada pengguna aktif untuk dinotifikasi."); return; }

        // Selalu jalankan analisis dan dapatkan laporan
        const report = await runFullAnalysis(); // Tanpa log callback untuk cron

        console.log("Laporan dihasilkan, mengirim ke pengguna terjadwal...");

        for (const user of users) {
            let shouldSend = false;
            const minute = now.getMinutes();
            const hour = now.getHours();
            switch (user.notification_interval) {
                case '15m': shouldSend = true; break;
                case '30m': if (minute === 0 || minute === 30) shouldSend = true; break;
                case '1h': if (minute === 0) shouldSend = true; break;
                case '4h': if (minute === 0 && hour % 4 === 0) shouldSend = true; break;
            }

            if (shouldSend) {
                try {
                    // Mengubah format tautan callback menjadi tombol untuk notifikasi
                    const reportLines = report.split('\n');
                    let finalReport = '';
                    const buttons = [];
                    let buttonRow = [];
                    reportLines.forEach(line => {
                        const match = line.match(/\[(.*?)\]\(callback:(.*?)\)/);
                        if (match) {
                            if (buttonRow.length >= 2) { buttons.push(buttonRow); buttonRow = []; }
                            buttonRow.push({ text: match[1], callback_data: match[2] });
                        } else { finalReport += line + '\n'; }
                    });
                    if (buttonRow.length > 0) buttons.push(buttonRow);

                    await bot.sendMessage(user.chat_id, finalReport, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
                    console.log(`✅ Notifikasi berhasil dikirim ke ${user.first_name}`);
                } catch (error) {
                    console.error(`❌ Gagal mengirim pesan ke ${user.first_name}: ${error.message}`);
                    if (error.response && error.response.statusCode === 403) {
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


// --- Siklus Pengambilan Data Otomatis (Tidak ada perubahan) ---
const DATA_FETCH_INTERVAL_SECONDS = 3 * 60;
async function fetchAndCacheAllMarketData() { console.log(`\n\n[${new Date().toLocaleString('id-ID')}] 🔄 Memulai siklus pembaruan data...`); for (const symbol of CRYPTOS) { await fetchAndStoreHistoricalData(symbol, '1h'); await fetchAndStoreHistoricalData(symbol, '4h'); await delay(500); } console.log(`[${new Date().toLocaleString('id-ID')}] ✅ Siklus pembaruan data selesai.`); }
function startCliCountdown(seconds) { let r = seconds; const i = setInterval(() => { const m = Math.floor(r / 60); const s = r % 60; process.stdout.write(`⏳ Pembaruan data berikutnya dalam: ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')} \r`); r--; if (r < 0) clearInterval(i); }, 1000); }
async function dataFetchLoop() { await fetchAndCacheAllMarketData(); startCliCountdown(DATA_FETCH_INTERVAL_SECONDS); setTimeout(dataFetchLoop, DATA_FETCH_INTERVAL_SECONDS * 1000); }

// --- Mulai Bot ---
console.log("🚀 Bot Cerdas (v5.0) Dimulai... Fitur simulasi & logging aktif!");
dataFetchLoop();
