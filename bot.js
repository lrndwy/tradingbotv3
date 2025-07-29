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
const db = new sqlite3.Database('./crypto_bot_data_v6_3.db', (err) => {
    if (err) {
        console.error("Error opening database", err.message);
    } else {
        console.log("Database connected successfully.");
        db.run(`CREATE TABLE IF NOT EXISTS market_data (symbol TEXT NOT NULL, timestamp INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, PRIMARY KEY (symbol, timestamp))`);
        db.run(`CREATE TABLE IF NOT EXISTS users (telegram_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, first_name TEXT, notification_interval TEXT DEFAULT '4h', notifications_enabled INTEGER DEFAULT 1, fiat_balance REAL DEFAULT 0)`);
        db.run(`CREATE TABLE IF NOT EXISTS portfolios (telegram_id INTEGER NOT NULL, symbol TEXT NOT NULL, amount REAL NOT NULL, avg_buy_price REAL NOT NULL, PRIMARY KEY (telegram_id, symbol))`);
        db.run(`CREATE TABLE IF NOT EXISTS transactions (transaction_id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id INTEGER NOT NULL, symbol TEXT NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, price REAL NOT NULL, timestamp INTEGER NOT NULL)`);
    }
});

// --- Variabel Global & Fungsi Helper ---
const CRYPTOS = [
    { pair: 'BTC/USDT', symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT' },
    { pair: 'ETH/USDT', symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT' },
    { pair: 'SOL/USDT', symbol: 'SOLUSDT', base: 'SOL', quote: 'USDT' },
    { pair: 'BNB/USDT', symbol: 'BNBUSDT', base: 'BNB', quote: 'USDT' },
    { pair: 'XRP/USDT', symbol: 'XRPUSDT', base: 'XRP', quote: 'USDT' }
];
let fearAndGreedIndex = { value: 50, classification: 'Neutral' };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const userActionStates = {};


// --- Fungsi Manajemen Pengguna ---
function findOrCreateUser(msg) {
    return new Promise((resolve, reject) => {
        const { id, first_name } = msg.from;
        const chat_id = msg.chat.id;
        db.get("SELECT * FROM users WHERE telegram_id = ?", [id], (err, user) => {
            if (err) return reject(err);
            if (user) { resolve(user); }
            else {
                db.run("INSERT INTO users (telegram_id, chat_id, first_name, fiat_balance) VALUES (?, ?, ?, 10000)", [id, chat_id, first_name], function (err) {
                    if (err) return reject(err);
                    console.log(`\nNew user registered: ${first_name} (ID: ${id}), initial balance 10000 USDT.`);
                    db.get("SELECT * FROM users WHERE telegram_id = ?", [id], (err, newUser) => {
                        if (err) return reject(err);
                        resolve(newUser);
                    });
                });
            }
        });
    });
}
function getUser(telegram_id) { return new Promise((resolve, reject) => { db.get("SELECT * FROM users WHERE telegram_id = ?", [telegram_id], (err, user) => { if (err) reject(err); resolve(user); }); }); }
function updateUserSetting(telegram_id, setting, value) { return new Promise((resolve, reject) => { db.run(`UPDATE users SET ${setting} = ? WHERE telegram_id = ?`, [value, telegram_id], function(err) { if (err) reject(err); resolve(); }); }); }


// --- Fungsi Pengambilan & Penyimpanan Data ---
async function getFearAndGreedIndex() { try { const r = await axios.get('https://api.alternative.me/fng/?limit=1'); fearAndGreedIndex = { value: parseInt(r.data.data[0].value), classification: r.data.data[0].value_classification }; } catch (e) { console.error('❌ Could not fetch F&G Index:', e.message); } }
async function fetchAndStoreHistoricalData(crypto, interval = '1h') { const limit = interval === '1h' ? 500 : 250; try { const r = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${crypto.symbol}&interval=${interval}&limit=${limit}`, { timeout: 30000 }); const stmt = db.prepare("INSERT OR IGNORE INTO market_data (symbol, timestamp, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)"); r.data.forEach(k => { stmt.run(crypto.symbol, k[0], parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5])); }); stmt.finalize(); return true; } catch (e) { console.error(`\n❌ Gagal mengambil data historis untuk ${crypto.symbol}:`, e.message); return false; } }
function getDataFromDB(symbol, limit = 500) { return new Promise((resolve, reject) => { db.all(`SELECT * FROM market_data WHERE symbol = ? ORDER BY timestamp DESC LIMIT ?`, [symbol, limit], (err, rows) => { if (err) reject(err); resolve(rows.reverse()); }); }); }

// ## DIPERBARUI: Fungsi untuk mendapatkan harga real-time
async function getRealTimePrice(symbol) {
    try {
        const response = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
        return parseFloat(response.data.price);
    } catch (error) {
        console.error(`❌ Gagal mengambil harga real-time untuk ${symbol}:`, error.message);
        return null; // Kembalikan null jika gagal
    }
}


// --- Analisis Engine (Logika tidak berubah) ---
function calculateStochasticRSI(rsiValues, period = 14) { if (rsiValues.length < period) return null; const relevantRsi = rsiValues.slice(-period); const lowestRsi = Math.min(...relevantRsi); const highestRsi = Math.max(...relevantRsi); if (highestRsi === lowestRsi) return { k: 50, d: 50 }; const stochRSI = 100 * ((relevantRsi.at(-1) - lowestRsi) / (highestRsi - lowestRsi)); const last3StochRSI = rsiValues.slice(-(period + 2)).map((_, i, arr) => { if (i < period -1) return null; const slice = arr.slice(i - period + 1, i + 1); const low = Math.min(...slice); const high = Math.max(...slice); if (high === low) return 50; return 100 * ((slice.at(-1) - low) / (high - low)); }).filter(v => v !== null); const d_line = last3StochRSI.slice(-3).reduce((a, b) => a + b, 0) / 3; return { k: stochRSI, d: d_line }; }
function technicalAnalysis(data) { if (!data || data.length < 50) return null; const closes = data.map(d => d.close); const rsiPeriod = 14; const rsiValues = []; for (let i = rsiPeriod; i < closes.length; i++) { let gains = 0, losses = 0; for (let j = i - rsiPeriod + 1; j <= i; j++) { const change = closes[j] - closes[j - 1]; if (change > 0) gains += change; else losses -= change; } const avgGain = gains / rsiPeriod; const avgLoss = losses / rsiPeriod; if (avgLoss === 0) { rsiValues.push(100); continue; } const rs = avgGain / avgLoss; rsiValues.push(100 - (100 / (1 + rs))); } const currentRsi = rsiValues.at(-1); const stochRSI = calculateStochasticRSI(rsiValues, rsiPeriod); const prevStochRSI = calculateStochasticRSI(rsiValues.slice(0, -1), rsiPeriod); const bbPeriod = 20; const slice = closes.slice(-bbPeriod); const sma = slice.reduce((a, b) => a + b, 0) / bbPeriod; const stdDev = Math.sqrt(slice.map(x => Math.pow(x - sma, 2)).reduce((a, b) => a + b) / bbPeriod); const bb = { middle: sma, upper: sma + (stdDev * 2), lower: sma - (stdDev * 2) }; const ema = (s, p) => { let r = [s[0]]; for (let i = 1; i < s.length; i++) { r.push(s[i] * (2 / (p + 1)) + r[i-1] * (1 - (2 / (p + 1)))); } return r; }; const ema12 = ema(closes, 12); const ema26 = ema(closes, 26); const macdLine = ema12.map((v, i) => v - ema26[i]); const signalLine = ema(macdLine, 9); const macd = { macd: macdLine.at(-1), signal: signalLine.at(-1), prev_macd: macdLine.at(-2), prev_signal: signalLine.at(-2) }; return { currentPrice: closes.at(-1), rsi: currentRsi, bb, macd, stochRSI: { current: stochRSI, previous: prevStochRSI } }; }
function predictPriceMovement(crypto, analysis, longTermTrend, fngIndex) { if (!analysis) return null; let buyScore = 0, sellScore = 0, reasons = []; const { currentPrice, rsi, bb, macd, stochRSI } = analysis; if (currentPrice < bb.lower) { buyScore += 3; reasons.push("Harga menembus Lower BB"); } if (currentPrice > bb.upper) { sellScore += 3; reasons.push("Harga menembus Upper BB"); } if (stochRSI.current.k > stochRSI.current.d && stochRSI.previous.k <= stochRSI.previous.d && stochRSI.current.k < 30) { buyScore += 3; reasons.push("StochRSI Bullish Crossover di area oversold"); } if (stochRSI.current.k < stochRSI.current.d && stochRSI.previous.k >= stochRSI.previous.d && stochRSI.current.k > 70) { sellScore += 3; reasons.push("StochRSI Bearish Crossover di area overbought"); } if (macd.macd > macd.signal && macd.prev_macd <= macd.prev_signal) { buyScore += 2; reasons.push("MACD Bullish Crossover"); } if (macd.macd < macd.signal && macd.prev_macd >= macd.prev_signal) { sellScore += 2; reasons.push("MACD Bearish Crossover"); } if (rsi < 35) { buyScore += 1; reasons.push("RSI mendekati oversold"); } if (rsi > 65) { sellScore += 1; reasons.push("RSI mendekati overbought"); } if (longTermTrend.trend === 'Bullish') { buyScore += 2; reasons.push("Tren 4H Bullish"); } if (longTermTrend.trend === 'Bearish') { sellScore += 2; reasons.push("Tren 4H Bearish"); } if (fngIndex.value < 25) { buyScore += 1; reasons.push("Pasar Extreme Fear"); } if (fngIndex.value > 75) { sellScore += 1; reasons.push("Pasar Extreme Greed"); } const confidence = (Math.max(buyScore, sellScore) / 12) * 100; if (buyScore >= 6 && buyScore > sellScore) return { action: 'BUY', confidence, reason: reasons.join(', ') }; if (sellScore >= 6 && sellScore > buyScore) return { action: 'SELL', confidence, reason: reasons.join(', ') }; return { action: 'HOLD', confidence: 0, reason: "Tidak ada sinyal konfirmasi yang kuat." }; }


// --- Fungsi Analisis Utama ---
async function runFullAnalysis(logCallback = null) {
    const updateLog = async (text) => { if (logCallback) await logCallback(text); };
    await updateLog("<code>[1/4]</code> Mengambil indeks pasar...");
    await getFearAndGreedIndex();
    // ## DIPERBARUI: Menggunakan zona waktu WIB
    let fullReport = `<b>Analisis Pasar Komprehensif</b>\n<i>${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}</i>\n\n`;
    fullReport += `<b>Indeks Pasar:</b> ${fearAndGreedIndex.value} (${fearAndGreedIndex.classification})\n--------------------------------------\n`;
    await updateLog("<code>[2/4]</code> Memeriksa data historis...");
    await delay(500);
    await updateLog("<code>[3/4]</code> Menganalisis setiap aset...");
    for (const crypto of CRYPTOS) {
        if (logCallback) await updateLog(`<code>[3/4]</code> Menganalisis <b>${crypto.pair}</b>...`);
        const data1h = await getDataFromDB(crypto.symbol, 500);
        const data4h = await getDataFromDB(crypto.symbol, 250);
        if (!data1h || data1h.length < 50 || !data4h || data4h.length < 50) continue;
        const analysis1h = technicalAnalysis(data1h);
        const analysis4h = technicalAnalysis(data4h);
        if (!analysis1h || !analysis4h) continue;
        const longTermTrend = { trend: analysis4h.rsi > 55 ? 'Bullish' : (analysis4h.rsi < 45 ? 'Bearish' : 'Netral') };
        const prediction = predictPriceMovement(crypto, analysis1h, longTermTrend, fearAndGreedIndex);

        // ## DIPERBARUI: Mengambil harga real-time untuk ditampilkan
        const currentPrice = await getRealTimePrice(crypto.symbol);
        if (currentPrice === null) continue; // Lewati jika gagal mengambil harga

        let emoji, actionText;
        if (prediction.action === 'BUY') { emoji = '🟢'; actionText = `<b>Sinyal: ${prediction.action}</b>`; }
        else if (prediction.action === 'SELL') { emoji = '🔴'; actionText = `<b>Sinyal: ${prediction.action}</b>`; }
        else { emoji = '⚪️'; actionText = `<b>Sinyal: ${prediction.action}</b>`; }
        fullReport += `${emoji} <b>${crypto.pair}</b> - ${actionText}\n`;
        const priceFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
        fullReport += `   - <b>Harga:</b> ${priceFormat.format(currentPrice)}\n`;
        if (prediction.action !== 'HOLD') { fullReport += `   - <b>Keyakinan:</b> ${prediction.confidence.toFixed(0)}%\n`; }
        fullReport += `   - <b>Alasan:</b> ${prediction.reason}\n`;
        fullReport += `--------------------------------------\n`;
    }
    await updateLog("<code>[4/4]</code> Laporan selesai disusun.");
    await delay(500);
    return fullReport;
}


// --- BOT INTERACTION & SIMULATION ---

const mainMenuKeyboard = { inline_keyboard: [ [{ text: '⚡ Analisis Sinyal', callback_data: 'run_analysis' }], [{ text: '💼 Portofolio & Trading', callback_data: 'portfolio_menu' }], [{ text: '⚙️ Pengaturan', callback_data: 'open_settings' }], [{ text: '❓ Bantuan', callback_data: 'show_help' }] ] };
async function getSettingsKeyboard(telegram_id) { const user = await getUser(telegram_id); const interval = user.notification_interval; const notifStatus = user.notifications_enabled ? '✅ AKTIF' : '❌ NONAKTIF'; const toggleNotifText = user.notifications_enabled ? 'Matikan Notifikasi' : 'Aktifkan Notifikasi'; return { inline_keyboard: [ [{ text: `Status Notifikasi: ${notifStatus}`, callback_data: 'do_nothing' }], [{ text: toggleNotifText, callback_data: 'toggle_notifications' }], [{ text: 'Ubah Interval Notifikasi', callback_data: 'do_nothing' }], [ { text: interval === '15m' ? '✅ 15m' : '15m', callback_data: 'set_interval_15m' }, { text: interval === '30m' ? '✅ 30m' : '30m', callback_data: 'set_interval_30m' } ], [ { text: interval === '1h' ? '✅ 1j' : '1j', callback_data: 'set_interval_1h' }, { text: interval === '4h' ? '✅ 4j' : '4j', callback_data: 'set_interval_4h' } ], [{ text: '⬅️ Kembali ke Menu Utama', callback_data: 'back_to_main' }] ] }; }

// ## DIPERBARUI: Menggunakan harga real-time untuk transaksi
async function handleBuy(userId, symbol, usdtAmount) {
    const price = await getRealTimePrice(symbol);
    if (!price) return "Gagal mendapatkan harga terkini. Coba lagi.";

    const user = await getUser(userId);
    if (user.fiat_balance < usdtAmount) {
        return `❌ Saldo tidak cukup! Saldo Anda: <b>${user.fiat_balance.toFixed(2)} USDT</b>, dibutuhkan: <b>${usdtAmount} USDT</b>.\n\nGunakan <code>/deposit [jumlah]</code> untuk menambah saldo.`;
    }

    const cryptoAmount = usdtAmount / price;
    const newFiatBalance = user.fiat_balance - usdtAmount;

    return new Promise((resolve) => {
        db.get("SELECT * FROM portfolios WHERE telegram_id = ? AND symbol = ?", [userId, symbol], (err, row) => {
            if (err) { console.error(err); resolve("Error database."); return; }
            if (row) {
                const newTotalAmount = row.amount + cryptoAmount;
                const newAvgPrice = ((row.avg_buy_price * row.amount) + (price * cryptoAmount)) / newTotalAmount;
                db.run("UPDATE portfolios SET amount = ?, avg_buy_price = ? WHERE telegram_id = ? AND symbol = ?", [newTotalAmount, newAvgPrice, userId, symbol]);
            } else {
                db.run("INSERT INTO portfolios (telegram_id, symbol, amount, avg_buy_price) VALUES (?, ?, ?, ?)", [userId, symbol, cryptoAmount, price]);
            }
            db.run("UPDATE users SET fiat_balance = ? WHERE telegram_id = ?", [newFiatBalance, userId]);
            db.run("INSERT INTO transactions (telegram_id, symbol, type, amount, price, timestamp) VALUES (?, ?, 'buy', ?, ?, ?)", [userId, symbol, cryptoAmount, price, Date.now()]);
            resolve(`✅ Berhasil membeli <b>${cryptoAmount.toFixed(6)} ${symbol}</b>.\nSaldo USDT Anda sekarang: <b>${newFiatBalance.toFixed(2)}</b>.`);
        });
    });
}

async function handleSell(userId, symbol, cryptoAmountToSell) {
    const price = await getRealTimePrice(symbol);
    if (!price) return "Gagal mendapatkan harga terkini. Coba lagi.";

    return new Promise((resolve) => {
        db.get("SELECT * FROM portfolios WHERE telegram_id = ? AND symbol = ?", [userId, symbol], async (err, row) => {
            if (err || !row || row.amount <= 0) { resolve(`❌ Anda tidak memiliki aset <b>${symbol}</b>.`); return; }
            if (row.amount < cryptoAmountToSell) { resolve(`❌ Aset tidak cukup. Anda hanya memiliki <b>${row.amount.toFixed(6)} ${symbol}</b>.`); return; }

            const remainingAmount = row.amount - cryptoAmountToSell;
            const realizedValue = cryptoAmountToSell * price;
            const costOfSoldAmount = cryptoAmountToSell * row.avg_buy_price;
            const profit = realizedValue - costOfSoldAmount;

            const user = await getUser(userId);
            const newFiatBalance = user.fiat_balance + realizedValue;

            if (remainingAmount <= 0.000001) {
                db.run("DELETE FROM portfolios WHERE telegram_id = ? AND symbol = ?", [userId, symbol]);
            } else {
                db.run("UPDATE portfolios SET amount = ? WHERE telegram_id = ? AND symbol = ?", [remainingAmount, userId, symbol]);
            }
            db.run("UPDATE users SET fiat_balance = ? WHERE telegram_id = ?", [newFiatBalance, userId]);
            db.run("INSERT INTO transactions (telegram_id, symbol, type, amount, price, timestamp) VALUES (?, ?, 'sell', ?, ?, ?)", [userId, symbol, cryptoAmountToSell, price, Date.now()]);

            const profitText = profit >= 0 ? `Keuntungan: $${profit.toFixed(2)}` : `Kerugian: $${Math.abs(profit).toFixed(2)}`;
            resolve(`✅ Berhasil menjual <b>${cryptoAmountToSell.toFixed(6)} ${symbol}</b>.\n${profitText}\nSaldo USDT Anda sekarang: <b>${newFiatBalance.toFixed(2)}</b>.`);
        });
    });
}

async function displayPortfolio(userId) {
    return new Promise(async (resolve) => {
        const user = await getUser(userId);
        let portfolioText = `<b>💼 Portofolio & Trading</b>\n\n💰 Saldo Tersedia: <b>${user.fiat_balance.toFixed(2)} USDT</b>\n--------------------------------------\n`;

        db.all("SELECT * FROM portfolios WHERE telegram_id = ?", [userId], async (err, rows) => {
            if (err) { resolve("Error database."); return; }

            if (rows.length === 0) {
                portfolioText += "Anda tidak memiliki aset kripto.\n\n";
            } else {
                let totalPortfolioValue = 0, totalCost = 0;
                for (const asset of rows) {
                    // ## DIPERBARUI: Menggunakan harga real-time untuk P&L
                    const currentPrice = await getRealTimePrice(asset.symbol);
                    if (!currentPrice) continue;
                    const currentValue = asset.amount * currentPrice;
                    const cost = asset.amount * asset.avg_buy_price;
                    const pnl = currentValue - cost;
                    const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;
                    const pnlEmoji = pnl >= 0 ? '📈' : '📉';
                    portfolioText += `<b>${asset.symbol}</b>: ${asset.amount.toFixed(6)} | ${pnlEmoji} P&L: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)\n`;
                    totalPortfolioValue += currentValue;
                    totalCost += cost;
                }
                const totalAssetsValue = totalPortfolioValue;
                const totalEquity = totalAssetsValue + user.fiat_balance;
                portfolioText += `\n<b>Total Nilai Aset:</b> $${totalAssetsValue.toFixed(2)}\n`;
                portfolioText += `<b>Total Ekuitas Akun:</b> $${totalEquity.toFixed(2)}\n\n`;
            }

            portfolioText += "Pilih aset untuk ditransaksikan:";
            const tradeButtons = CRYPTOS.map(crypto => ({ text: crypto.base, callback_data: `trade_${crypto.symbol}` }));
            const keyboard = [];
            for (let i = 0; i < tradeButtons.length; i += 5) {
                keyboard.push(tradeButtons.slice(i, i + 5));
            }
            keyboard.push([{ text: '⬅️ Kembali ke Menu Utama', callback_data: 'back_to_main' }]);

            resolve({ text: portfolioText, keyboard: { inline_keyboard: keyboard } });
        });
    });
}


// --- Handler Perintah & Callback ---
bot.setMyCommands([
    { command: '/start', description: '🚀 Mulai bot & tampilkan menu' },
    { command: '/analyze', description: '⚡ Jalankan analisis sinyal' },
    { command: '/portfolio', description: '💼 Lihat portofolio & trading' },
    { command: '/buy', description: '� Beli Aset. Contoh: /buy BTC 100' },
    { command: '/sell', description: '💸 Jual Aset. Contoh: /sell BTC 0.01' },
    { command: '/deposit', description: '🏦 Tambah saldo USDT simulasi' },
    { command: '/settings', description: '⚙️ Buka pengaturan notifikasi' },
    { command: '/help', description: '❓ Tampilkan bantuan' },
]);

const sendMainMenu = async (chatId, text) => { bot.sendMessage(chatId, text, { reply_markup: mainMenuKeyboard, parse_mode: 'HTML' }); };
bot.onText(/\/start/, async (msg) => { await findOrCreateUser(msg); const text = `👋 Halo, <b>${msg.from.first_name}</b>!\n\nSelamat datang di Bot Trading Cerdas (v6.3).\nBot ini kini dilengkapi trading manual dengan harga real-time. Anda diberi modal awal 10,000 USDT. Gunakan menu di bawah.`; sendMainMenu(msg.chat.id, text); });
bot.onText(/\/help/, (msg) => { const helpText = `<b>Bantuan Bot Trading Cerdas v6.3</b>\n\n/start - Menampilkan menu utama.\n/analyze - Menjalankan analisis sinyal.\n/portfolio - Melihat aset dan melakukan trading manual.\n/buy [SIMBOL] [JUMLAH_USDT] - Contoh: <code>/buy BTC 100</code>\n/sell [SIMBOL] [JUMLAH_ASET] - Contoh: <code>/sell BTC 0.01</code>\n/deposit [jumlah] - Menambah saldo USDT. Contoh: <code>/deposit 500</code>\n/settings - Mengubah frekuensi notifikasi.`; bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'HTML' }); });
bot.onText(/\/settings/, (msg) => { handleCallbackQuery({ data: 'open_settings', message: msg, from: msg.from }); });
bot.onText(/\/analyze/, (msg) => { handleCallbackQuery({ data: 'run_analysis', message: msg, from: msg.from }); });
bot.onText(/\/portfolio/, (msg) => { handleCallbackQuery({ data: 'portfolio_menu', message: msg, from: msg.from }); });

bot.onText(/\/buy (\w+) (.+)/, async (msg, match) => {
    const userId = msg.from.id;
    const symbolQuery = match[1].toUpperCase();
    const amount = parseFloat(match[2]);
    const crypto = CRYPTOS.find(c => c.base === symbolQuery || c.symbol === symbolQuery);

    if (!crypto) { bot.sendMessage(msg.chat.id, `❌ Simbol tidak ditemukan. Gunakan simbol dasar (misal: BTC).`); return; }
    if (isNaN(amount) || amount <= 0) { bot.sendMessage(msg.chat.id, `❌ Jumlah tidak valid.`); return; }

    const result = await handleBuy(userId, crypto.symbol, amount);
    bot.sendMessage(msg.chat.id, result, { parse_mode: 'HTML' });
});

bot.onText(/\/sell (\w+) (.+)/, async (msg, match) => {
    const userId = msg.from.id;
    const symbolQuery = match[1].toUpperCase();
    const amount = parseFloat(match[2]);
    const crypto = CRYPTOS.find(c => c.base === symbolQuery || c.symbol === symbolQuery);

    if (!crypto) { bot.sendMessage(msg.chat.id, `❌ Simbol tidak ditemukan. Gunakan simbol dasar (misal: BTC).`); return; }
    if (isNaN(amount) || amount <= 0) { bot.sendMessage(msg.chat.id, `❌ Jumlah tidak valid.`); return; }

    const result = await handleSell(userId, crypto.symbol, amount);
    bot.sendMessage(msg.chat.id, result, { parse_mode: 'HTML' });
});

bot.onText(/\/deposit (.+)/, async (msg, match) => {
    const userId = msg.from.id;
    const amount = parseFloat(match[1]);
    if (isNaN(amount) || amount <= 0) { bot.sendMessage(msg.chat.id, "❌ Jumlah deposit tidak valid. Gunakan format: <code>/deposit 500</code>", { parse_mode: 'HTML' }); return; }
    const user = await getUser(userId);
    const newBalance = user.fiat_balance + amount;
    db.run("UPDATE users SET fiat_balance = ? WHERE telegram_id = ?", [newBalance, userId]);
    db.run("INSERT INTO transactions (telegram_id, symbol, type, amount, price, timestamp) VALUES (?, 'USDT', 'deposit', ?, 1, ?)", [userId, amount, Date.now()]);
    bot.sendMessage(msg.chat.id, `✅ Deposit <b>${amount} USDT</b> berhasil.\nSaldo Anda sekarang: <b>${newBalance.toFixed(2)} USDT</b>.`, { parse_mode: 'HTML' });
});

bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) return;

    const userId = msg.from.id;
    const state = userActionStates[userId];

    if (state) {
        const amount = parseFloat(msg.text);
        if (isNaN(amount) || amount <= 0) {
            bot.sendMessage(msg.chat.id, "❌ Jumlah tidak valid. Silakan masukkan angka positif.");
            return;
        }

        let result;
        if (state.action === 'buy') {
            result = await handleBuy(userId, state.symbol, amount);
        } else if (state.action === 'sell') {
            result = await handleSell(userId, state.symbol, amount);
        }

        bot.sendMessage(msg.chat.id, result, { parse_mode: 'HTML' });
        delete userActionStates[userId];
    }
});


bot.on('callback_query', handleCallbackQuery);

async function handleCallbackQuery(query) {
    const { data, message, from } = query;
    const chatId = message.chat.id;
    const userId = from.id;
    await findOrCreateUser({ from, chat: { id: chatId } });

    if (data.startsWith('trade_')) {
        const symbol = data.split('_')[1];
        const keyboard = { inline_keyboard: [
            [{ text: `💰 Beli ${symbol}`, callback_data: `prompt_buy_${symbol}` }, { text: `💸 Jual ${symbol}`, callback_data: `prompt_sell_${symbol}` }],
            [{ text: '⬅️ Kembali ke Portofolio', callback_data: 'portfolio_menu' }]
        ]};
        bot.editMessageText(`Pilih aksi untuk <b>${symbol}</b>:`, { chat_id: chatId, message_id: message.message_id, reply_markup: keyboard, parse_mode: 'HTML' });
        bot.answerCallbackQuery(query.id);
        return;
    }

    if (data.startsWith('prompt_buy_')) {
        const symbol = data.split('_')[2];
        userActionStates[userId] = { action: 'buy', symbol: symbol };
        bot.sendMessage(chatId, `💰 Berapa banyak <b>USDT</b> yang ingin Anda gunakan untuk membeli <b>${symbol}</b>?`, { parse_mode: 'HTML' });
        bot.answerCallbackQuery(query.id, { text: `Masukkan jumlah USDT` });
        return;
    }

    if (data.startsWith('prompt_sell_')) {
        const symbol = data.split('_')[2];
        userActionStates[userId] = { action: 'sell', symbol: symbol };
        bot.sendMessage(chatId, `💸 Berapa banyak <b>${symbol}</b> yang ingin Anda jual?`, { parse_mode: 'HTML' });
        bot.answerCallbackQuery(query.id, { text: `Masukkan jumlah aset` });
        return;
    }


    switch (data) {
        case 'run_analysis':
            const sentMsg = await bot.sendMessage(chatId, "<code>[0/4]</code> ⏳ Memulai analisis...", { parse_mode: 'HTML' });
            const logCallback = async (text) => { try { await bot.editMessageText(text, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'HTML' }); } catch (e) { /* Abaikan */ } };
            try {
                const report = await runFullAnalysis(logCallback);
                await bot.editMessageText(report, { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'HTML'});
            } catch (error) { console.error("Error during manual analysis:", error); await bot.editMessageText("❌ Terjadi kesalahan saat menjalankan analisis.", { chat_id: chatId, message_id: sentMsg.message_id }); }
            break;
        case 'portfolio_menu':
            const { text, keyboard } = await displayPortfolio(userId);
            bot.editMessageText(text, { chat_id: chatId, message_id: message.message_id, reply_markup: keyboard, parse_mode: 'HTML' }).catch(() => {
                bot.sendMessage(chatId, text, { reply_markup: keyboard, parse_mode: 'HTML' });
            });
            break;
        case 'open_settings': const settingsKeyboard = await getSettingsKeyboard(userId); bot.editMessageText('⚙️ <b>Pengaturan Notifikasi</b>...', { chat_id: chatId, message_id: message.message_id, reply_markup: settingsKeyboard, parse_mode: 'HTML' }).catch(() => { bot.sendMessage(chatId, '⚙️ <b>Pengaturan Notifikasi</b>...', { reply_markup: settingsKeyboard, parse_mode: 'HTML' }); }); break;
        case 'toggle_notifications': const user = await getUser(userId); const newStatus = user.notifications_enabled ? 0 : 1; await updateUserSetting(userId, 'notifications_enabled', newStatus); bot.answerCallbackQuery(query.id, { text: `Notifikasi telah ${newStatus ? 'diaktifkan' : 'dimatikan'}.` }); const refreshedSettingsKeyboard = await getSettingsKeyboard(userId); bot.editMessageReplyMarkup(refreshedSettingsKeyboard, { chat_id: chatId, message_id: message.message_id }); break;
        case 'set_interval_15m': case 'set_interval_30m': case 'set_interval_1h': case 'set_interval_4h': const interval = data.split('_')[2]; await updateUserSetting(userId, 'notification_interval', interval); const intervalText = interval.replace('m', ' Menit').replace('h', ' Jam'); bot.answerCallbackQuery(query.id, { text: `Interval diatur ke ${intervalText}.` }); const updatedKeyboard = await getSettingsKeyboard(userId); bot.editMessageReplyMarkup(updatedKeyboard, { chat_id: chatId, message_id: message.message_id }); break;
        case 'back_to_main': bot.editMessageText("Anda kembali ke menu utama.", { chat_id: chatId, message_id: message.message_id, reply_markup: mainMenuKeyboard }); break;
        case 'do_nothing': bot.answerCallbackQuery(query.id); break;
        case 'show_help': const helpText = `<b>Bantuan Bot Trading Cerdas v6.3</b>...`; bot.sendMessage(chatId, helpText, { parse_mode: 'HTML' }); break;
    }
    bot.answerCallbackQuery(query.id).catch(()=>{});
}


// --- Penjadwal Notifikasi Pengguna ---
cron.schedule('*/15 * * * *', async () => {
    // ## DIPERBARUI: Menggunakan zona waktu WIB
    const now = new Date();
    console.log(`\n🕒 Menjalankan Penjadwal Notifikasi pada ${now.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}...`);
    try {
        const users = await new Promise((resolve, reject) => { db.all("SELECT * FROM users WHERE notifications_enabled = 1", (err, rows) => { if (err) reject(err); resolve(rows); }); });
        if (users.length === 0) { console.log("Tidak ada pengguna aktif untuk dinotifikasi."); return; }
        const report = await runFullAnalysis();
        console.log("Laporan dihasilkan, mengirim ke pengguna terjadwal...");
        for (const user of users) {
            let shouldSend = false;
            const minute = now.getMinutes(); const hour = now.getHours();
            switch (user.notification_interval) {
                case '15m': shouldSend = true; break;
                case '30m': if (minute === 0 || minute === 30) shouldSend = true; break;
                case '1h': if (minute === 0) shouldSend = true; break;
                case '4h': if (minute === 0 && hour % 4 === 0) shouldSend = true; break;
            }
            if (shouldSend) {
                try {
                    await bot.sendMessage(user.chat_id, report, { parse_mode: 'HTML' });
                    console.log(`✅ Notifikasi berhasil dikirim ke ${user.first_name}`);
                } catch (error) {
                    console.error(`❌ Gagal mengirim pesan ke ${user.first_name}: ${error.message}`);
                    if (error.response && error.response.statusCode === 403) { await updateUserSetting(user.telegram_id, 'notifications_enabled', 0); }
                }
                await delay(300);
            }
        }
    } catch (error) { console.error("Error during scheduled notification dispatcher:", error); }
});


// --- Siklus Pengambilan Data Otomatis ---
const DATA_FETCH_INTERVAL_SECONDS = 3 * 60;
async function fetchAndCacheAllMarketData() {
    // ## DIPERBARUI: Menggunakan zona waktu WIB
    const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    console.log(`\n\n[${now}] 🔄 Memulai siklus pembaruan data...`);
    for (const crypto of CRYPTOS) {
        await fetchAndStoreHistoricalData(crypto, '1h');
        await fetchAndStoreHistoricalData(crypto, '4h');
        await delay(500);
    }
    console.log(`[${now}] ✅ Siklus pembaruan data selesai.`);
}
function startCliCountdown(seconds) { let r = seconds; const i = setInterval(() => { const m = Math.floor(r / 60); const s = r % 60; process.stdout.write(`⏳ Pembaruan data berikutnya dalam: ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')} \r`); r--; if (r < 0) clearInterval(i); }, 1000); }
async function dataFetchLoop() { await fetchAndCacheAllMarketData(); startCliCountdown(DATA_FETCH_INTERVAL_SECONDS); setTimeout(dataFetchLoop, DATA_FETCH_INTERVAL_SECONDS * 1000); }

// --- Mulai Bot ---
console.log("🚀 Bot Cerdas (v6.3) Dimulai... Harga real-time & WIB aktif!");
dataFetchLoop();
