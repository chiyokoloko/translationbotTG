// deps: npm i telegraf franc axios dotenv
require('dotenv').config();
const { Telegraf } = require('telegraf');
const { franc } = require('franc');
const axios = require('axios');
const fs = require('fs');

// put this at the top with other imports
const path = require('path');

// allow persistent mount via DATA_DIR, else current folder
const DATA_DIR = process.env.DATA_DIR || '.';
const TOPIC_DB = path.join(DATA_DIR, 'topic_names.json');
const ACL_DB = path.join(DATA_DIR, 'allowed_users.json');
const PAUSE_DB = path.join(DATA_DIR, 'pause_state.json');
const CHAT_MAP_DB = path.join(DATA_DIR, 'chat_map.json');

/* -------------------- ENV & boot -------------------- */
if (!process.env.BOT_TOKEN) { console.error('missing BOT_TOKEN'); process.exit(1); }

const MODE = (process.env.MODE || 'auto').toLowerCase();
const TRANSLATION_CHAT_ID = Number(process.env.TRANSLATION_CHAT_ID);
const SHOW_TOPIC_IN_HEADER = (process.env.SHOW_TOPIC_IN_HEADER || 'false').toLowerCase() === 'true';

// seed whitelist with your ID + optional env list
const SEED = new Set(
    (process.env.ALLOWED_USER_IDS || '')
        .split(',').map(s => Number(s.trim())).filter(Boolean)
);
SEED.add(1173495374); // chiyoko's ID (from your message)

const bot = new Telegraf(process.env.BOT_TOKEN);

// clear webhook -> polling
(async () => {
    try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); } catch { }
    const me = await bot.telegram.getMe();
    console.log(`bot ready as @${me.username}`);
})();

/* -------------------- simple persistence -------------------- */
// topic names
function loadJSON(filePath, fallback) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return fallback; }
}
function saveJSON(filePath, obj) {
    try { fs.writeFileSync(filePath, JSON.stringify(obj, null, 2)); } catch { }
}

const topicNames = new Map(Object.entries(loadJSON(TOPIC_DB, {}))); // "chatId:threadId" -> title
function setTopicName(chatId, threadId, title) {
    topicNames.set(`${chatId}:${threadId}`, title);
    saveJSON(TOPIC_DB, Object.fromEntries(topicNames.entries()));
}
function getTopicName(chatId, threadId) {
    return topicNames.get(`${chatId}:${threadId}`) || null;
}

// allowed command users (IDs only)
const allowedUsers = new Set(loadJSON(ACL_DB, { allowed: [] }).allowed);
for (const id of SEED) allowedUsers.add(id);
function saveAllowed() { saveJSON(ACL_DB, { allowed: Array.from(allowedUsers) }); }

// global pause flag
const pauseState = Object.assign({ paused_all: false }, loadJSON(PAUSE_DB, {}));
function savePause() { saveJSON(PAUSE_DB, pauseState); }

/* -------------------- utils -------------------- */
// Quiet author label: never pings.
// If the user has a username, link to https://t.me/<username> (non-mention).
// If not, show plain text (no link), to avoid forced mentions via user-id.
function authorLabelQuiet(u = {}) {
    const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ');
    const visible = fullName || (u.username ? u.username : 'someone'); // NO '@' in visible text
    if (u.username) {
        // URL stays raw; only escape the visible text
        return `[${mdv2(visible)}](https://t.me/${u.username})`;
    }
    return mdv2(visible); // no username => plain, no-ping text
}

function authorLabel(u = {}) {
    // Pretty display name
    const name =
        [u.first_name, u.last_name].filter(Boolean).join(' ') ||
        (u.username ? '@' + u.username : 'someone');

    // Use Telegram's text-mention link; does NOT ping the user
    // Escape only the visible text, not the URL.
    return u.id ? `[${mdv2(name)}](tg://user?id=${u.id})` : mdv2(name);
}

function mdv2(s) { return String(s ?? '').replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1'); }
const HAN = /[\u3400-\u9FFF]/;
const ASCII_LETTER = /[A-Za-z]/;

function shortFromName(u = {}) { return u.username ? '@' + u.username : ([u.first_name, u.last_name].filter(Boolean).join(' ') || 'someone'); }

function deepLinkForMessage(msg) {
    const chat = msg.chat, mid = msg.message_id;
    if (chat.username) return `https://t.me/${chat.username}/${mid}`;
    const abs = String(Math.abs(chat.id));
    const internal = abs.startsWith('100') ? abs.slice(3) : abs;
    return `https://t.me/c/${internal}/${mid}`;
}

function topicLinkForThread(chatId, threadId) {
    const abs = String(Math.abs(chatId));
    const internal = abs.startsWith('100') ? abs.slice(3) : abs;
    return `https://t.me/c/${internal}/${threadId}`;
}

function isGibberish(text) {
    const t = (text || '').trim();
    if (!t) return true;
    if (/(https?:\/\/|t\.me\/|www\.)/i.test(t)) return true;
    if (/```|`[^`]+`/.test(t)) return true;
    if ((t.match(/[A-Za-z\u3400-\u9FFF]/g) || []).length === 0) return true;
    if (t.length < 3) return true;
    const digits = (t.match(/\d/g) || []).length;
    const punct = (t.match(/[^\w\s\u3400-\u9FFF]/g) || []).length;
    if ((digits + punct) / t.length > 0.55) return true;
    const asciiOnly = /^[\x00-\x7F]+$/.test(t);
    if (asciiOnly && ASCII_LETTER.test(t) && !/[aeiou]/i.test(t)) return true;
    return false;
}

const FLAG = {
    'en': '🇬🇧', 'zh-CN': '🇨🇳', 'zh': '🇨🇳', 'zh-TW': '🇨🇳',
    'es': '🇪🇸', 'fr': '🇫🇷', 'de': '🇩🇪', 'ja': '🇯🇵', 'ko': '🇰🇷',
    'ru': '🇷🇺', 'pt': '🇵🇹', 'it': '🇮🇹', 'nl': '🇳🇱', 'ar': '🇸🇦',
    'hi': '🇮🇳', 'tr': '🇹🇷', 'vi': '🇻🇳'
};
const flagOf = (code) => FLAG[code] || '🌐';

// chat admins OR allowed IDs may run commands
async function isAdmin(ctx, chatId, userId) {
    try {
        const m = await ctx.telegram.getChatMember(chatId, userId);
        if (['administrator', 'creator'].includes(m.status)) return true;
    } catch { }
    return false;
}

async function isAuthorized(ctx) {
    const uid = ctx.from?.id;
    if (!uid) return false;

    // Always allow chiyoko's main account by default
    if (uid === 1173495374) return true;

    // Otherwise check allow list
    return allowedUsers.has(uid);
}

/* -------------------- learn topic names from service messages -------------------- */
bot.on('message', async (ctx, next) => {
    const m = ctx.message;
    try {
        if (m?.forum_topic_created?.name && m?.message_thread_id) {
            setTopicName(ctx.chat.id, m.message_thread_id, m.forum_topic_created.name);
        }
        if (m?.forum_topic_edited?.name && m?.message_thread_id) {
            setTopicName(ctx.chat.id, m.message_thread_id, m.forum_topic_edited.name);
        }
    } catch { }
    return next();
});

function topicSuffix(msg) {
    if (!SHOW_TOPIC_IN_HEADER) return '';
    if (msg.is_topic_message && msg.message_thread_id) {
        const name = getTopicName(msg.chat.id, msg.message_thread_id) || `Topic ${msg.message_thread_id}`;
        const url = topicLinkForThread(msg.chat.id, msg.message_thread_id);
        return ` • Topic: [${mdv2(name)}](${url})`; // clickable, no '#'
    }
    return '';
}

/* -------------------- translate -------------------- */
async function translateAuto(text, target) {
    const res = await axios.get('https://translate.googleapis.com/translate_a/single', {
        params: { client: 'gtx', sl: 'auto', tl: target, dt: 't', q: text }
    });
    const out = res.data?.[0]?.map(seg => seg?.[0]).join('')?.trim() || '';
    let detected = res.data?.[2] || '';
    if (detected && detected.startsWith('zh')) detected = 'zh-CN';
    if (!detected) detected = HAN.test(text) ? 'zh-CN' : 'en';
    return { text: out, src: detected };
}

/* -------------------- posting -------------------- */
async function postToTranslations(ctx, srcMsg, srcLangCode, zhText, enText) {
    const author = authorLabel(srcMsg.from || {});

    const link = deepLinkForMessage(srcMsg);

    const targets = [zhText && flagOf('zh-CN'), enText && flagOf('en')].filter(Boolean).join(' & ') || flagOf('en');
    const header = `*${flagOf(srcLangCode)} → ${targets}*${topicSuffix(srcMsg)}`;

    const original = `*Original*\n> ${mdv2(srcMsg.text || '')}`;
    const blocks = [header, '', original];

    if (zhText) blocks.push('', `*Chinese*\n> ${mdv2(zhText)}`);
    if (enText) blocks.push('', `*English*\n> ${mdv2(enText)}`);

    // build author display: @username if available, else first + last name
    let authorName;
    if (srcMsg.from?.username) {
        authorName = `${srcMsg.from.username}`;
    } else {
        authorName = [srcMsg.from?.first_name, srcMsg.from?.last_name]
            .filter(Boolean)
            .join(' ') || 'someone';
    }

    blocks.push('', `→ 👤 by [${mdv2(authorName)}](${link})`);
    const body = blocks.join('\n');

    const dest = chatMap[srcMsg.chat.id] || chatMap._default || TRANSLATION_CHAT_ID;
    if (!dest) {
        console.warn(`⚠️ No translation channel set for ${srcMsg.chat.id}`);
        return;
    }
    await ctx.telegram.sendMessage(dest, body, { parse_mode: 'MarkdownV2' });
}

bot.command('gettranslation', (ctx) => {
    const groupId = ctx.chat?.id;
    const target = chatMap[groupId];
    if (target) ctx.reply(`🔗 This group is linked to translation channel: ${target}`);
    else ctx.reply('⚠️ No translation channel set for this group.');
});

/* -------------------- AUTO mode -------------------- */
// BEFORE
// bot.on('message', async (ctx) => {

// AFTER
bot.on('message', async (ctx, next) => {
    if (MODE !== 'auto') return next();

    const msg = ctx.message;
    if (!msg?.text) return next();
    if (/^\//.test(msg.text)) return next();   // let commands through
    if (msg.from?.is_bot) return next();
    if (pauseState.paused_all) return next();
    if (isGibberish(msg.text)) return next();

    try {
        const toEn = await translateAuto(msg.text, 'en');
        const toZh = await translateAuto(msg.text, 'zh-CN');

        const src = toEn.src;
        let includeEn = true, includeZh = true;
        if (src === 'en') includeEn = false;
        if (src === 'zh-CN') includeZh = false;

        const enText = includeEn ? toEn.text : '';
        const zhText = includeZh ? toZh.text : '';

        if (enText || zhText) {
            await postToTranslations(ctx, msg, src, zhText, enText);
        }
    } catch (e) {
        console.error('translate/bridge error:', e?.response?.data || e.message);
    }

    return next(); // ⬅️ important
});

/* -------------------- commands (whitelist + pause) -------------------- */
/* -------------------- chat → channel map -------------------- */
// shape: { "_default": -100xxxx, "<groupId>": -100yyyy }
const chatMap = loadJSON(CHAT_MAP_DB, {});
function saveChatMap() { saveJSON(CHAT_MAP_DB, chatMap); }

// Command: /settranslation <channel_id>
// Command: /settranslation (run in group, after forwarding a message from target channel)
// /settranslation — run this INSIDE the translation channel you want as default.
// It sets this channel as the default destination for translations.
// /settranslation — make *this chat* the translation destination.
// Works in a group OR a channel. (Not allowed in private DM.)
bot.command('settranslation', async (ctx) => {
    const uid = ctx.from?.id;
    const chat = ctx.chat;

    if (chat?.type === 'private') {
        return ctx.reply('ℹ️ Run /settranslation inside a *group or a channel*, not in a private chat.');
    }

    // Only your main ID OR admins of this chat can run it
    if (uid !== 1173495374) {
        try {
            const m = await ctx.telegram.getChatMember(chat.id, uid);
            if (!['administrator', 'creator'].includes(m.status)) {
                return ctx.reply("❌ You're not an admin");
            }
        } catch {
            return ctx.reply('❌ Could not verify admin rights here.');
        }
    }

    // If we’re in a channel, store as the global/default destination.
    // If we’re in a group/supergroup, store as the group-specific destination.
    if (chat.type === 'channel') {
        chatMap._default = chat.id;
        saveChatMap();
        return ctx.reply(`✅ Default translation destination set to *this channel* (id: ${chat.id}).`, { parse_mode: 'Markdown' });
    }

    if (chat.type === 'group' || chat.type === 'supergroup') {
        chatMap[chat.id] = chat.id;  // translations will post back into this group
        saveChatMap();
        return ctx.reply(`✅ Translations for this group will be posted *here* (id: ${chat.id}).`);
    }

    return ctx.reply('⚠️ Unsupported chat type for /settranslation.');
});

bot.start(ctx => ctx.reply('✅ Translator ready. I’m auto-bridging messages to the Translations channel.\nUse /help for commands.'));

// /linkhere <groupId> — run in a channel to bind a specific group → this channel
bot.command('linkhere', async (ctx) => {
    if (ctx.chat?.type !== 'channel') {
        return ctx.reply('📣 Run /linkhere inside the channel you want as the destination.');
    }
    const uid = ctx.from?.id;
    if (uid !== 1173495374) {
        try {
            const m = await ctx.telegram.getChatMember(ctx.chat.id, uid);
            if (!['administrator', 'creator'].includes(m.status)) {
                return ctx.reply("❌ You're not an admin");
            }
        } catch { return ctx.reply('❌ Could not verify admin rights here.'); }
    }
    const parts = (ctx.message.text || '').trim().split(/\s+/);
    const gid = Number(parts[1]);
    if (!Number.isFinite(gid)) return ctx.reply('Usage: /linkhere <groupId>  (run in this channel)');
    chatMap[gid] = ctx.chat.id;
    saveChatMap();
    return ctx.reply(`✅ Linked group ${gid} → this channel (${ctx.chat.id}).`);
});

// /whereis — run in a group to see where translations go
bot.command('whereis', async (ctx) => {
    if (!['group', 'supergroup'].includes(ctx.chat?.type)) {
        return ctx.reply('ℹ️ Run /whereis in a group.');
    }
    const gid = ctx.chat.id;
    const target = chatMap[gid] || chatMap._default || TRANSLATION_CHAT_ID;
    if (!target) {
        return ctx.reply('⚠️ No translation channel configured yet. Set a default by running /settranslation *in your channel*.');
    }
    // try to show a friendly name if channel has a username
    try {
        const ch = await ctx.telegram.getChat(target);
        const label = ch.username ? `@${ch.username}` : (ch.title || target);
        return ctx.reply(`🔗 Translations for this group go to: ${label} (id: ${target})`);
    } catch {
        return ctx.reply(`🔗 Translations for this group go to channel id: ${target}`);
    }
});

bot.command('help', async (ctx) => {
    const uid = ctx.from?.id;
    const chatId = ctx.chat?.id;

    // allow only chiyoko or chat admins
    if (uid !== 1173495374 && !(await isAdmin(ctx, chatId, uid))) {
        return ctx.reply("❌ You're not an admin");
    }

    return ctx.reply(
        [
            '*Commands*',
            '',
            '• /settranslation — run this inside a group or channel to set where translations will go.',
            '   → If you run it in a channel: sets that channel as the default destination.',
            '   → If you run it in a group: translations will post back to that group.',
            '',
            '• /whereis — shows where translations from this group are sent.',
            '',
            '• /topicname <Title> — name the current forum topic (shows in translation posts).',
            '',
            '• /pause — pause translations globally.',
            '• /resume — resume translations globally.',
            '• /status — show pause state & allowed user IDs.',
            '• /allow <userId> — allow a user to use bot commands.',
            '• /deny <userId> — remove a user from the allow list.',
            '• /id — shows this chat’s ID.',
            '',
            'Optional:',
            '• /linkhere <groupId> — run inside a channel to link a specific group to that channel.',
        ].join('\n'),
        { parse_mode: 'Markdown' }
    );
});

bot.command('id', ctx => ctx.reply(`chat id: ${ctx.chat.id}`));

bot.command('pause', async (ctx) => {
    if (!(await isAuthorized(ctx))) return ctx.reply("❌ You're not an admin");
    pauseState.paused_all = true; savePause();
    return ctx.reply('⏸️ Translations *paused* (global).', { parse_mode: 'Markdown' });
});

bot.command('resume', async (ctx) => {
    if (!(await isAuthorized(ctx))) return ctx.reply("❌ You're not an admin");
    pauseState.paused_all = false; savePause();
    return ctx.reply('▶️ Translations *resumed* (global).', { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
    if (!(await isAuthorized(ctx))) return ctx.reply("❌ You're not an admin");
    return ctx.reply(
        `paused_all: ${pauseState.paused_all}\nallowed_user_ids: [${Array.from(allowedUsers).join(', ')}]\nSHOW_TOPIC_IN_HEADER=${SHOW_TOPIC_IN_HEADER}`
    );
});

bot.command('allow', async (ctx) => {
    if (!(await isAuthorized(ctx))) return ctx.reply("❌ You're not an admin");
    const parts = (ctx.message.text || '').trim().split(/\s+/);
    const id = Number(parts[1]);
    if (!Number.isFinite(id)) return ctx.reply('Usage: /allow <numericUserId>');
    allowedUsers.add(id); saveAllowed();
    return ctx.reply(`✅ Added ${id} to allowed users.`);
});

bot.command('deny', async (ctx) => {
    if (!(await isAuthorized(ctx))) return ctx.reply("❌ You're not an admin");
    const parts = (ctx.message.text || '').trim().split(/\s+/);
    const id = Number(parts[1]);
    if (!Number.isFinite(id)) return ctx.reply('Usage: /deny <numericUserId>');
    const existed = allowedUsers.delete(id); saveAllowed();
    return ctx.reply(existed ? `✅ Removed ${id} from allowed users.` : `ℹ️ ${id} was not in the allow list.`);
});

bot.command('tn', async (ctx) => {
    if (!(await isAuthorized(ctx))) return ctx.reply('❌ You are not authorized to run /topicname.');

    const msg = ctx.message;
    const name = (msg.text || '').split(' ').slice(1).join(' ').trim();

    if (!msg.is_topic_message || !msg.message_thread_id) {
        const reply = await ctx.reply(
            '❗ Run this command *inside the forum topic* you want to name.\nExample: `/tn Prices`',
            { parse_mode: 'Markdown' }
        );
        setTimeout(() => ctx.deleteMessage(reply.message_id).catch(() => { }), 2000);
        setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => { }), 2000);
        return;
    }

    if (!name) {
        const reply = await ctx.reply('Usage: /topicname <Title>');
        setTimeout(() => ctx.deleteMessage(reply.message_id).catch(() => { }), 2000);
        setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => { }), 2000);
        return;
    }

    setTopicName(ctx.chat.id, msg.message_thread_id, name);

    const confirm = await ctx.reply(
        `✅ Saved topic name as “${name}”.\n• Chat: ${ctx.chat.id}\n• Topic ID: ${msg.message_thread_id}\nℹ️ Will show on *new* translation posts.`,
        { parse_mode: 'Markdown' }
    );

    // delete both messages after 2s
    setTimeout(() => ctx.deleteMessage(confirm.message_id).catch(() => { }), 500);
    setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => { }), 500);
});

/* -------------------- errors & launch -------------------- */
bot.catch(err => console.error('bot error:', err));
bot.launch({
    allowedUpdates: ['message', 'channel_post']
}).then(() => console.log('polling started (privacy OFF; bot must be admin in Translations channel).'));