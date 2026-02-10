import 'dotenv/config';
import express from 'express';
import line from '@line/bot-sdk';
import OpenAI from 'openai';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { Document, Packer, Paragraph, TextRun } from 'docx';

const app = express();

// ---- LINE ----
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// ---- OpenAI ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Postgres ----
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// 初始化資料表（最少步驟：開機自動建表）
async function initDb() {
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
}
await initDb();

// 健康檢查
app.get('/', (_, res) => res.status(200).send('OK'));

// 下載檔案（回傳連結最穩：用你的服務域名提供）
app.get('/files/:id', async (req, res) => {
  const { id } = req.params;
  const r = await pool.query('SELECT filename, mime, data FROM files WHERE id=$1', [id]);
  if (r.rowCount === 0) return res.status(404).send('Not found');
  const f = r.rows[0];
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.status(200).send(f.data);
});

// LINE webhook
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end(); // LINE 需要 200 才算成功 :contentReference[oaicite:10]{index=10}
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userText = event.message.text.trim();
  const userId = event.source?.userId || 'unknown';

  // 1) 存使用者訊息
  await pool.query(
    'INSERT INTO messages (id, user_id, role, content) VALUES ($1,$2,$3,$4)',
    [uuidv4(), userId, 'user', userText]
  );

  // 2) 取最近 20 則對話（做「記憶」）
  const hist = await pool.query(
    `SELECT role, content FROM messages
     WHERE user_id=$1
     ORDER BY created_at DESC
     LIMIT 20`,
    [userId]
  );

  const history = hist.rows.reverse().map(r => ({ role: r.role, content: r.content }));

  // 3) 系統提示：把你的訓練規則寫死在這裡（之後可改成 DB 可編輯）
  const systemPrompt = `
你是我的訓練教練助理，用繁體中文。
我回報訓練（跑步/重訓/游泳/登山/瑜珈）時：
- 回覆：重點摘要、風險提醒、明日建議（清楚表列）
- 若內容足夠，補充：PRE×心率×配速判讀（含降載規則）
- 若提到疼痛/不適，先做風險分級與保守建議
如果我說「產出報告」或「做成Word」，請產出一份可下載的 Word 報告（以條列＋表格概念呈現）。
`;

  // 4) 送到 OpenAI Responses API :contentReference[oaicite:11]{index=11}
  const resp = await openai.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    input: [
      { role: 'system', content: systemPrompt },
      ...history.map(m => ({ role: m.role, content: m.content }))
    ],
  });

  const replyText = resp.output_text || '我剛剛沒有產生到回覆，請再傳一次～';

  // 5) 若需要產 Word（你也可以改成：只要偵測到訓練回報就自動產）
  const shouldMakeWord =
    /word|報告|整理成檔|完整分析|週彙總|月彙總/i.test(userText);

  if (shouldMakeWord) {
    const fileId = await makeWordAndSave(userId, replyText);
    const baseUrl = process.env.PUBLIC_BASE_URL; // Railway 提供的網域，部署後填入
    const link = `${baseUrl}/files/${fileId}`;
    const finalText = `${replyText}\n\n📄 Word 下載連結：\n${link}`;

    await pool.query(
      'INSERT INTO messages (id, user_id, role, content) VALUES ($1,$2,$3,$4)',
      [uuidv4(), userId, 'assistant', finalText]
    );

    await lineClient.replyMessage(event.replyToken, { type: 'text', text: finalText });
    return;
  }

  // 6) 正常回覆
  await pool.query(
    'INSERT INTO messages (id, user_id, role, content) VALUES ($1,$2,$3,$4)',
    [uuidv4(), userId, 'assistant', replyText]
  );

  await lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

// 產 docx → 存 DB → 回傳 fileId
async function makeWordAndSave(userId, text) {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          children: [new TextRun({ text: '訓練分析報告', bold: true })]
        }),
        new Paragraph(''),
        ...text.split('\n').map(line => new Paragraph(line))
      ]
    }]
  });

  const buf = await Packer.toBuffer(doc);
  const fileId = uuidv4();
  const filename = `report_${new Date().toISOString().slice(0,10)}.docx`;

  await pool.query(
    'INSERT INTO files (id, user_id, filename, mime, data) VALUES ($1,$2,$3,$4,$5)',
    [fileId, userId, filename, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buf]
  );

  return fileId;
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));
