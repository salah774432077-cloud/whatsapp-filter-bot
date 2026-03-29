const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const TelegramBot = require('node-telegram-bot-api');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const axios = require('axios');

// --- إعداد خادم Express لضمان بقاء البوت 24/7 على الاستضافة ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('WhatsApp Filter Bot is Running 🟢'));
app.listen(port, () => console.log(`🌐 Server is live on port ${port}`));

// --- إعدادات البوت الأساسية ---
const token = '8767224260:AAHBpHNMqXGHgm72ouue1MHsc0Hw-ahg46A'; 
const bot = new TelegramBot(token, { polling: true });
const sessionFolder = 'auth_session_bot3'; 

let sock;
let checkQueue = [];
let isProcessing = false;
let stopSignal = false;
let waitingForPairNumber = false; // متغير لانتظار رقم المستخدم لطلب كود الربط

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
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') console.log("✅ WhatsApp Connected!");
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        }
    });
}

// --- نظام الفحص المتقدم ---
async function processQueue(chatId) {
    if (isProcessing) return;
    isProcessing = true;
    stopSignal = false;

    let total = checkQueue.length;
    let current = 0;
    let notOnWa = [];
    let startTime = Date.now(); // حساب وقت البداية لتقدير الوقت المتبقي

    const statusMsg = await bot.sendMessage(chatId, `⏳ *جاري تهيئة الفحص...*`, { parse_mode: 'Markdown' });

    while (checkQueue.length > 0 && !stopSignal) {
        const number = checkQueue.shift();
        current++;
        const cleanNumber = number.replace(/[^0-9]/g, '');

        if (cleanNumber.length > 5) {
            try {
                const [result] = await sock.onWhatsApp(cleanNumber);
                if (!result || !result.exists) {
                    notOnWa.push(`+${cleanNumber}`);
                }
            } catch (e) { console.log("Error checking:", cleanNumber); }
        }

        // --- نظام Anti-Spam: تحديث شريط التقدم كل 5 أرقام لتجنب حظر تيليجرام ---
        if (current % 5 === 0 || current === total) {
            const percent = Math.floor((current / total) * 100);
            const progress = "▓".repeat(Math.floor(percent / 10)) + "░".repeat(10 - Math.floor(percent / 10));
            
            // حساب الوقت المتبقي تقريبياً
            let elapsed = (Date.now() - startTime) / 1000; 
            let avgTimePerNumber = elapsed / current;
            let timeLeft = Math.ceil(avgTimePerNumber * (total - current));
            let timeString = timeLeft > 60 ? `${Math.floor(timeLeft / 60)} دقيقة و ${timeLeft % 60} ثانية` : `${timeLeft} ثانية`;

            await bot.editMessageText(
                `🔍 *الفحص قيد التشغيل...*\n\n` +
                `📊 التقدم: \`[${progress}]\` ${percent}%\n` +
                `✅ تم فحص: ${current} من ${total}\n` +
                `❌ غير موجودين: ${notOnWa.length}\n` +
                `⏱️ الوقت المتبقي: ${timeString}\n\n` +
                `لإيقاف الفحص اضغط /cancel`,
                { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
            ).catch(() => {}); // التجاهل في حال تعذر التعديل
        }
        await sleep(1000); 
    }

    isProcessing = false;
    
    // إرسال التقرير النهائي كملف TXT
    if (notOnWa.length > 0) {
        const fileName = `results_${chatId}.txt`;
        fs.writeFileSync(fileName, "الأرقام التي لا تملك حسابات واتساب:\n\n" + notOnWa.join('\n'));
        await bot.sendDocument(chatId, fileName, { caption: `🏁 *اكتمل الفحص!*\n\nإجمالي الأرقام: ${total}\n❌ غير موجودين: ${notOnWa.length}`, parse_mode: 'Markdown' });
        fs.unlinkSync(fileName); 
    } else if (stopSignal) {
        bot.sendMessage(chatId, "🛑 *تم إيقاف الفحص اضطرارياً بناءً على طلبك.*", { parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(chatId, "🏁 *اكتمل الفحص.*\nجميع الأرقام المُدخلة تمتلك حسابات واتساب!", { parse_mode: 'Markdown' });
    }
}

// --- إعداد قائمة أوامر البوت في تيليجرام (Bot Menu) ---
bot.setMyCommands([
    { command: 'start', description: '🏠 القائمة الرئيسية ولوحة التحكم' },
    { command: 'status', description: '📊 التحقق من حالة اتصال واتساب' },
    { command: 'pair', description: '🔗 ربط رقم واتساب جديد (كود الربط)' },
    { command: 'reset', description: '🧹 حذف الجلسة الحالية وإعادة الضبط' },
    { command: 'cancel', description: '🛑 إيقاف عملية الفحص فوراً' }
]);

// --- استقبال الرسائل والأوامر ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    // معالجة إدخال رقم الهاتف لاستخراج كود الربط
    if (waitingForPairNumber && !text.startsWith('/')) {
        waitingForPairNumber = false;
        const phone = text.replace(/[^0-9]/g, '');
        bot.sendMessage(chatId, `⏳ جاري طلب كود الربط للرقم ${phone}...\n(الرجاء الانتظار بضع ثوانٍ)`);
        
        try {
            setTimeout(async () => {
                let code = await sock.requestPairingCode(phone);
                bot.sendMessage(chatId, `✅ *تم استخراج كود الربط بنجاح!*\n\nالكود الخاص بك هو:\n\`${code}\`\n\n📌 *طريقة الاستخدام:*\nافتح واتساب > الأجهزة المرتبطة > ربط جهاز > اختر "الربط برقم هاتف بدلاً من ذلك" > أدخل الكود أعلاه.`, { parse_mode: 'Markdown' });
            }, 3000);
        } catch (err) {
            bot.sendMessage(chatId, `❌ حدث خطأ أثناء طلب الكود. تأكد من إدخال الرقم بصيغة صحيحة أو حاول مجدداً.\nالسبب: ${err.message}`);
        }
        return;
    }

    // دعم استلام ملفات TXT للفحص
    if (msg.document && msg.document.file_name.endsWith('.txt')) {
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const response = await axios.get(fileLink);
        const numbers = response.data.match(/\d+/g);
        if (numbers) {
            checkQueue.push(...numbers);
            bot.sendMessage(chatId, `📩 تم استلام ملف يحتوي على ${numbers.length} رقم. جاري البدء...`);
            processQueue(chatId);
        } else {
            bot.sendMessage(chatId, "❌ لم أتمكن من العثور على أرقام صالحة داخل الملف.");
        }
        return;
    }

    // أمر البداية مع لوحة تحكم شفافة
    if (text === '/start') {
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔗 ربط رقم جديد", callback_data: 'pair_wa' }, { text: "📊 حالة الاتصال", callback_data: 'status_wa' }],
                    [{ text: "🧹 حذف الجلسة", callback_data: 'reset_wa' }, { text: "🛑 إيقاف الفحص", callback_data: 'cancel_scan' }]
                ]
            }
        };
        bot.sendMessage(chatId, "🚀 *مرحباً بك في لوحة تحكم البوت!*\n\n🔹 لفحص الأرقام: أرسلها هنا مباشرة أو ارفع ملف `.txt`.\n🔹 للتحكم بالبوت: استخدم القائمة (Menu) أو الأزرار أدناه 👇", { parse_mode: 'Markdown', ...opts });
        return;
    }

    if (text === '/status') {
        const status = sock?.ws?.isOpen ? "✅ متصل وجاهز للعمل" : "❌ غير متصل (تحتاج لربط الرقم)";
        bot.sendMessage(chatId, `*حالة الخادم:*\n${status}`, { parse_mode: 'Markdown' });
        return;
    }

    if (text === '/cancel') {
        stopSignal = true;
        bot.sendMessage(chatId, "⚠️ *أمر طوارئ:* سيتم إيقاف عملية الفحص مباشرة بعد الرقم الحالي...", { parse_mode: 'Markdown' });
        return;
    }

    if (text === '/reset') {
        if (fs.existsSync(sessionFolder)) {
            fs.rmSync(sessionFolder, { recursive: true, force: true });
            bot.sendMessage(chatId, "✅ تم حذف الجلسة القديمة وتفريغ المساحة بنجاح. يتم الآن إعادة تشغيل الخادم...");
            process.exit(); 
        } else {
            bot.sendMessage(chatId, "لا توجد جلسة نشطة لحذفها.");
        }
        return;
    }

    if (text === '/pair') {
        waitingForPairNumber = true;
        bot.sendMessage(chatId, "📲 *أرسل رقم الواتساب الخاص بك الآن*\nيجب أن يكون بالصيغة الدولية وبدون رمز (+) أو أصفار البداية.\n(مثال: `967712345678`)", { parse_mode: 'Markdown' });
        return;
    }

    // فحص الأرقام المرسلة مباشرة كنص
    const numbers = text.match(/\d+/g);
    if (numbers && !text.startsWith('/')) {
        checkQueue.push(...numbers);
        bot.sendMessage(chatId, `⏳ تم إضافة ${numbers.length} رقم للطابور.`);
        processQueue(chatId);
    }
});

// --- استجابة الأزرار الشفافة (Inline Keyboard) ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === 'status_wa') {
        const status = sock?.ws?.isOpen ? "✅ متصل" : "❌ غير متصل";
        bot.answerCallbackQuery(query.id, { text: `الحالة: ${status}`, show_alert: true });
    } else if (data === 'cancel_scan') {
        stopSignal = true;
        bot.answerCallbackQuery(query.id, { text: "تم إرسال أمر الإيقاف. يرجى الانتظار ثانية..." });
    } else if (data === 'reset_wa') {
        if (fs.existsSync(sessionFolder)) {
            fs.rmSync(sessionFolder, { recursive: true, force: true });
            bot.answerCallbackQuery(query.id, { text: "✅ تم حذف الجلسة.", show_alert: true });
            bot.sendMessage(chatId, "تم حذف الجلسة بنجاح. أعد تشغيل البوت للربط من جديد.");
            process.exit();
        } else {
            bot.answerCallbackQuery(query.id, { text: "لا توجد جلسة نشطة لحذفها.", show_alert: true });
        }
    } else if (data === 'pair_wa') {
        waitingForPairNumber = true;
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, "📲 *أرسل رقم الواتساب الخاص بك الآن*\nيجب أن يكون بالصيغة الدولية وبدون رمز (+).\n(مثال: `967712345678`)", { parse_mode: 'Markdown' });
    }
});

startBot();
