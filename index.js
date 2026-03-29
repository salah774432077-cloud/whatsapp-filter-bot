const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const TelegramBot = require('node-telegram-bot-api');
const pino = require('pino');

// --- Bot Configuration ---
const token = '8767224260:AAHBpHNMqXGHgm72ouue1MHsc0Hw-ahg46A'; 
const bot = new TelegramBot(token, { polling: true });

const phoneNumber = "967702490802"; 
const sessionFolder = 'auth_session_bot3'; 

let sock;
let checkQueue = [];
let isProcessing = false;
let pairingRequested = false;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "120.0.6099.109"], 
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    if (!sock.authState.creds.registered && !pairingRequested) {
        pairingRequested = true;
        console.log(`⏳ Stabilizing for ${phoneNumber}...`);
        
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                console.log("\n" + "=".repeat(40));
                console.log("✅ YOUR PAIRING CODE: " + code);
                console.log("=".repeat(40) + "\n");
            } catch (err) {
                console.log("❌ Pairing Error:", err.message);
                pairingRequested = false;
            }
        }, 15000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log("✅ Connected Successfully!");
            pairingRequested = false;
        }
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`🔄 Connection closed (Code: ${reason}).`);
            if (reason !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 5000);
            }
        }
    });
}

// --- Fast Filter System ---
async function processQueue(chatId) {
    if (isProcessing) return; 
    isProcessing = true;

    bot.sendMessage(chatId, "🔍 Filtering... sending ONLY numbers NOT on WhatsApp.");

    while (checkQueue.length > 0) {
        const batch = checkQueue.splice(0, 3); 
        
        await Promise.all(batch.map(async (number) => {
            const cleanNumber = number.replace(/[^0-9]/g, '');
            if (!cleanNumber) return;

            try {
                const [result] = await sock.onWhatsApp(cleanNumber);
                if (!result || !result.exists) {
                    await bot.sendMessage(chatId, `❌ \`+${cleanNumber}\``, { parse_mode: 'MarkdownV2' });
                }
            } catch (e) {
                console.log("Check failed for:", cleanNumber);
            }
        }));
        await sleep(1500); 
    }

    isProcessing = false;
    bot.sendMessage(chatId, "🏁 Process Completed!");
}

// --- Telegram Commands ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (msg.text === '/start') {
        bot.sendMessage(chatId, "🚀 Bot Active! Send a list of numbers to filter.");
        return;
    }

    const numbers = msg.text?.match(/\d+/g);
    if (numbers) {
        checkQueue.push(...numbers);
        bot.sendMessage(chatId, `⏳ Queued ${numbers.length} numbers.`);
        processQueue(chatId);
    }
});

bot.on('polling_error', (error) => {
    console.log("Polling Error:", error.message);
});

startBot();

