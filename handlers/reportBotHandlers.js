const axios  = require('axios');
const logger = require('../utils/logger');

const REPORT_GROUP_ID = process.env.REPORT_GROUP_ID || '-5514184112';

// userId → { photos: [fileId, ...], caption: '', timer, chatId }
const pendingReports = new Map();

const REQUIRED_ITEMS = [
  { key: 'paper_log',    label: 'Paper Logbook (Driver\'s Daily Log)' },
  { key: 'malfunction',  label: 'ELD Malfunction Manual'              },
  { key: 'dot_sheet',    label: 'DOT Instruction Sheet'               },
  { key: 'user_manual',  label: 'Leader ELD User\'s Manual'           },
  { key: 'tablet',       label: 'Tablet / ELD Device'                 },
];

function labelFor(key) {
  return REQUIRED_ITEMS.find(r => r.key === key)?.label || key;
}

async function getBase64(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
  return Buffer.from(res.data).toString('base64');
}

async function analyzePhotos(telegram, photos) {
  const { OpenAI } = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const imageContents = [];
  for (const fileId of photos) {
    const fileInfo = await telegram.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${process.env.SUPPORT_BOT_TOKEN}/${fileInfo.file_path}`;
    const b64 = await getBase64(url);
    imageContents.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' },
    });
  }

  const prompt = `You are a strict compliance document verifier for truck drivers. Your ONLY job is to examine the PHOTOS provided and determine what physical documents are visually present.

IMPORTANT RULES:
- Ignore ALL text, captions, checklists, or emoji (✅ ❌) written by the sender. Do NOT trust self-reported claims.
- Only mark an item as found if you can clearly see it in the actual photo content.
- If a photo is too blurry or a document is unreadable, do NOT count it as found.

Check for these 5 required items by looking at the images:
1. paper_log    — Paper Logbook: a physical booklet with "DRIVER'S DAILY LOG" or "DRIVER'S DAY LOG" printed on the cover (J.J. Keller or similar brand)
2. malfunction  — ELD Malfunction Manual: a printed paper or pamphlet with "ELD Malfunction" visible on it, with Leader ELD branding
3. dot_sheet    — DOT Instruction Sheet: a printed paper or sheet with "DOT Instruction Sheet" visible, with Leader ELD branding
4. user_manual  — Leader ELD User's Manual or product brochure: a printed document showing "Leader ELD" and a device (PT30 or similar model)
5. tablet       — A physical tablet or mobile device visible in any photo (does NOT need to be powered on or show the app)

Respond ONLY with this exact JSON — no extra text, no explanation:
{
  "found": ["key1", "key2"],
  "missing": ["key3"],
  "accepted": true
}
"accepted" must be true ONLY if ALL 5 keys appear in "found".`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }, ...imageContents],
    }],
    max_tokens: 300,
    temperature: 0,
  });

  const raw   = response.choices[0].message.content.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON in AI response: ${raw}`);
  return JSON.parse(match[0]);
}

async function processReport(telegram, chatId, thinkingId, data) {
  try {
    const result = await analyzePhotos(telegram, data.photos);

    const foundLabels   = (result.found   || []).map(labelFor);
    const missingLabels = (result.missing || []).map(labelFor);
    const memberLine    = data.memberId ? `👤 Done by <b>#${data.memberId}</b>\n\n` : '';

    let reply;
    if (result.accepted) {
      reply =
        `✅ <b>Report Accepted</b>\n\n` +
        memberLine +
        foundLabels.map(l => `✅ ${l}`).join('\n');
    } else {
      reply =
        `❌ <b>Report Rejected</b>\n\n` +
        memberLine +
        (foundLabels.length ? foundLabels.map(l => `✅ ${l}`).join('\n') + '\n\n' : '') +
        missingLabels.map(l => `❌ ${l}`).join('\n') +
        `\n\n⚠️ Please resubmit all required documents from the beginning.`;
    }

    if (thinkingId) {
      try {
        await telegram.editMessageText(chatId, thinkingId, undefined, reply, { parse_mode: 'HTML' });
        return;
      } catch {}
    }
    await telegram.sendMessage(chatId, reply, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('Report analysis error:', err);
    const errMsg = '⚠️ Analysis failed. Please try again.';
    if (thinkingId) {
      try { await telegram.editMessageText(chatId, thinkingId, undefined, errMsg); return; } catch {}
    }
    try { await telegram.sendMessage(chatId, errMsg); } catch {}
  }
}

const handleReportMessage = async (ctx, next) => {
  if (String(ctx.chat?.id) !== String(REPORT_GROUP_ID)) return next();

  const photo = ctx.message?.photo;
  const text  = ctx.message?.text || ctx.message?.caption || '';

  // Extract member ID like #M450 or #450 from any message in the group
  const idMatch = text.match(/#([A-Za-z0-9]+)/);

  if (!photo) {
    // Text-only message: just capture member ID if present, then stop
    if (idMatch && ctx.from) {
      const userId = ctx.from.id;
      if (pendingReports.has(userId)) {
        pendingReports.get(userId).memberId = idMatch[1];
      }
    }
    return;
  }

  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const fileId = photo[photo.length - 1].file_id;

  if (!pendingReports.has(userId)) {
    pendingReports.set(userId, { photos: [], chatId, memberId: null });
  }
  const pending = pendingReports.get(userId);
  pending.photos.push(fileId);

  // Capture member ID from photo caption if present
  if (idMatch && !pending.memberId) {
    pending.memberId = idMatch[1];
  }

  // Reset 60-second window on each new photo
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(async () => {
    pendingReports.delete(userId);

    let thinkingId = null;
    try {
      const msg = await ctx.telegram.sendMessage(chatId, '🔍 Analyzing documents, please wait…');
      thinkingId = msg.message_id;
    } catch {}

    await processReport(ctx.telegram, chatId, thinkingId, pending);
  }, 60_000);
};

module.exports = { handleReportMessage };
