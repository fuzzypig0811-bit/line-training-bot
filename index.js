import 'dotenv/config';
import express from 'express';
import * as line from '@line/bot-sdk';
import OpenAI from 'openai';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { Document, Packer, Paragraph, TextRun } from 'docx';

const app = express();

// -------------------- ENV GUARD --------------------
function mustEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === '') {
    console.error(`[ENV] Missing: ${name}`);
    return null;
  }
  return v;
}

// LINE env
const LINE_CHANNEL_ACCESS_TOKEN = mustEnv('LINE_CHANNEL_ACCESS_TOKEN');
const LINE_CHANNEL_SECRET = mustEnv('LINE_CHANNEL_SECRET');

// OpenAI env
const OPENAI_API_KEY = mustEnv('OPENAI_API_KEY');

// DB env
const DATABASE_URL = mustEnv('DATABASE_URL');

// Base URL for file links
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ''; // 可先不設，後續再補

// -------------------- LINE CLIENT --------------------
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN || 'MISSING_TOKEN',
  channelSecret: LINE_CHANNEL_SECRET || 'MISSING_SECRET',
};

const lineClient = new line.Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN || 'MISSING_TOKEN',
});

// -------------------- OPENAI --------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY || 'MISSING_OPENAI_KEY' });

// -------------------- POSTGRES --------------------
const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL }) : null;

async function initDb() {
  if (!pool) {
    console.error('[DB] DATABASE_URL missing, skip initDb');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('[DB] initDb OK');
}

// 不要讓 DB 啟動失敗造成整個 app crash → 避免 502
initDb().catch((err) => console.error('[DB] initDb failed:', err));

// -------------------- ROUTES --------------------

// Health check
app.get('/', (_, res) => res.status(200).send('OK'));

// 讓你用瀏覽器確認 webhook 路徑是否正確（LINE Verify 走 POST，不會走這個）
app.get('/webhook', (_, res) => res.status(200).send('webhook ok'));

// 檔案下載連結（回傳 Word）
app.get('/files/:id', async (req, res) => {
  try {
    if (!pool) return res.status(500).send('DB not configured');
    const { id } = req.params;
    const r = await pool.query('SELECT filename, mime, data FROM files WHERE id=$1', [id]);
    if (r.rowCount === 0) return res.status(404).send('Not found');
    const f = r.rows[0];
    res.setHeader('Content-Type', f.mime);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`
    );
    return res.status(200).send(f.data);
  } catch (err) {
    console.error('[FILES] error:', err);
    return res.status(500).send('Internal Error');
  }
});

// LINE webhook（middleware 會驗 signature；secret/token 錯會直接擋）
// ✅ 讓你用瀏覽器確認路徑（GET 不影響 LINE）
app.get('/webhook', (_, res) => res.status(200).send('webhook ok'));

// ✅ 用「可捕捉錯誤」的方式包 LINE middleware，避免它丟錯變 500
const lineMiddleware = (req, res, next) => {
  const mw = line.middleware(lineConfig);
  mw(req, res, (err) => {
    if (!err) return next();

    // 把真正原因印出來（你按 Verify 時，Railway logs 會出現這段）
    console.error('[LINE middleware error]', err);

    // 常見：Channel secret 不對 → signature 驗證失敗
    // 常見：不是 LINE 平台打來 → 缺 X-Line-Signature
    // 我們不要回 500，改回 401 讓你一眼看懂是驗證問題
    return res.status(401).send('Invalid LINE signature / middleware error');
  });
};

app.post('/webhook', lineMiddleware, async (req, res) => {
  try {
    const events = req.body?.events || [];

    // ✅ LINE Verify 可能送 events: []，這時必須回 200
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(200).end();
    }

    await Promise.all(events.map(handleEvent));
    return res.status(200).end();
  } catch (err) {
    console.error('[WEBHOOK handler error]', err);
    // 不要讓 Verify 看到 500（會失敗），先回 200，錯誤留在 logs
    return res.status(200).end();
  }
});


// -------------------- HANDLERS --------------------

async function handleEvent(event) {
  // 只處理文字訊息
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userText = String(event.message.text || '').trim();
  const userId = event.source?.userId || 'unknown';

  // 若 LINE token/secret 沒設好，直接回覆可讀訊息（避免 crash）
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
    await safeReply(event.replyToken, 'LINE token/secret 尚未設定完成，請先在 Railway Variables 設定。');
    return;
  }
  if (!OPENAI_API_KEY) {
    await safeReply(event.replyToken, 'OPENAI_API_KEY 尚未設定完成，請先在 Railway Variables 設定。');
    return;
  }

  // 1) 存使用者訊息
  if (pool) {
    await pool.query(
      'INSERT INTO messages (id, user_id, role, content) VALUES ($1,$2,$3,$4)',
      [uuidv4(), userId, 'user', userText]
    );
  }

  // 2) 取最近 20 則對話（記憶）
  let history = [];
  if (pool) {
    const hist = await pool.query(
      `SELECT role, content FROM messages
       WHERE user_id=$1
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId]
    );
    history = hist.rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  } else {
    history = [{ role: 'user', content: userText }];
  }

  const systemPrompt = `
你是我的訓練教練助理，用繁體中文。
我回報訓練（跑步/重訓/游泳/登山/瑜珈）時：
- 回覆：重點摘要、風險提醒、明日建議（清楚表列）
- 若避免受傷更重要，請保守建議
若我說「產出報告」或「做成Word」，請產出一份可下載 Word 報告（條列清楚）。
`;

  // 3) OpenAI 回覆
  const resp = await openai.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    input: [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ],
  });

  const replyText = resp.output_text || '我剛剛沒有產生到回覆，請再傳一次～';

  // 4) 需要產 Word 的判斷
  const shouldMakeWord = /word|報告|整理成檔|完整分析|週彙總|月彙總/i.test(userText);

  if (shouldMakeWord) {
    if (!pool) {
      await safeReply(event.replyToken, replyText + '\n\n（DB 未設定，暫時無法產 Word）');
      return;
    }
    const fileId = await makeWordAndSave(userId, replyText);

    // PUBLIC_BASE_URL 若未設，就回提示（不讓流程 crash）
    const baseUrl = (PUBLIC_BASE_URL || '').trim();
    if (!baseUrl) {
      const finalText =
        replyText +
        `\n\n📄 Word 已生成，但 PUBLIC_BASE_URL 尚未設定。\n請在 Railway Variables 設定 PUBLIC_BASE_URL = 你的公開網址（https://xxx.up.railway.app）\n檔案ID：${fileId}`;
      await storeAssistantMessage(userId, finalText);
      await safeReply(event.replyToken, finalText);
      return;
    }

    const link = `${baseUrl.replace(/\/$/, '')}/files/${fileId}`;
    const finalText = `${replyText}\n\n📄 Word 下載連結：\n${link}`;

    await storeAssistantMessage(userId, finalText);
    await safeReply(event.replyToken, finalText);
    return;
  }

  // 一般回覆
  await storeAssistantMessage(userId, replyText);
  await safeReply(event.replyToken, replyText);
}

async function storeAssistantMessage(userId, content) {
  if (!pool) return;
  await pool.query(
    'INSERT INTO messages (id, user_id, role, content) VALUES ($1,$2,$3,$4)',
    [uuidv4(), userId, 'assistant', content]
  );
}

async function safeReply(replyToken, text) {
  try {
    if (!replyToken) return;
    await lineClient.replyMessage(replyToken, { type: 'text', text: String(text).slice(0, 4900) });
  } catch (err) {
    console.error('[LINE] reply error:', err);
  }
}

// 產 docx → 存 DB → 回 fileId
async function makeWordAndSave(userId, text) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: '訓練分析報告', bold: true })],
          }),
          new Paragraph(''),
          ...String(text)
            .split('\n')
            .map((line) => new Paragraph(line)),
        ],
      },
    ],
  });

  const buf = await Packer.toBuffer(doc);
  const fileId = uuidv4();
  const filename = `report_${new Date().toISOString().slice(0, 10)}.docx`;

  await pool.query(
    'INSERT INTO files (id, user_id, filename, mime, data) VALUES ($1,$2,$3,$4,$5)',
    [
      fileId,
      userId,
      filename,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buf,
    ]
  );
  return fileId;
}

// -------------------- START SERVER --------------------
const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log(`Listening on :${port}`));
