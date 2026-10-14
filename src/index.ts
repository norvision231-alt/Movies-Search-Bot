import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import mongoose from 'mongoose';
import { bot, sendToLogChannel } from './bot/telegram';
import { startCronJobs, runWorkerCycle } from './scheduler/worker';
import { MediaItem, MonthJob, AppSettings } from './database/models';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();

if (!MONGODB_URI) {
  console.error('MONGODB_URI is required');
  process.exit(1);
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/', async (_req, res) => {
  try {
    let settings = await AppSettings.findOne({ key: 'global' });
    if (!settings) settings = await AppSettings.create({ key: 'global' });

    const total = await MediaItem.countDocuments();
    const published = await MediaItem.countDocuments({ isPublished: true });
    const pending = await MediaItem.countDocuments({ isPublished: false });
    const activeJob = await MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({ month: -1 });

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Admin Panel - Movie Database & Publisher</title>
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; padding: 1.5rem; margin: 0; }
            .container { max-width: 820px; margin: 0 auto; }
            .card { background: #1e293b; padding: 1.5rem; border-radius: 12px; margin-bottom: 1.25rem; border: 1px solid #334155; }
            h2, h3 { margin-top: 0; color: #38bdf8; }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 1rem; margin-bottom: 1rem; }
            .stat-box { background: #0f172a; padding: 1rem; border-radius: 8px; border: 1px solid #334155; }
            .stat-val { font-size: 1.4rem; font-weight: bold; color: #4ade80; margin-top: 0.3rem; }
            label { display: block; margin: 0.75rem 0 0.3rem; font-size: 0.9rem; color: #cbd5e1; }
            input[type="text"] { width: 100%; padding: 0.6rem; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: #fff; box-sizing: border-box; }
            .btn-row { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1rem; }
            button { padding: 0.65rem 1.1rem; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; color: #fff; background: #2563eb; }
            button.green { background: #16a34a; }
            button.amber { background: #d97706; }
            button.red { background: #dc2626; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              <h2>🎬 Automated Movie & Web-Series Admin Dashboard</h2>
              <div class="grid">
                <div class="stat-box">🌱 Auto Seeding<div class="stat-val">${settings.autoSeedingEnabled ? 'RUNNING' : 'PAUSED'}</div></div>
                <div class="stat-box">📤 Auto Publish<div class="stat-val">${settings.autoPublishEnabled ? 'RUNNING' : 'PAUSED'}</div></div>
                <div class="stat-box">📅 Active Month<div class="stat-val">${activeJob ? `${activeJob.month} (${activeJob.mediaType.toUpperCase()} P${activeJob.currentPage})` : 'Idle'}</div></div>
                <div class="stat-box">🗄️ Total Titles<div class="stat-val">${total}</div></div>
                <div class="stat-box">✅ Published<div class="stat-val">${published}</div></div>
                <div class="stat-box">⏳ In Queue<div class="stat-val">${pending}</div></div>
              </div>

              <div class="btn-row">
                <form method="POST" action="/api/admin/action"><input type="hidden" name="action" value="toggle_seed"/><button class="green" type="submit">${settings.autoSeedingEnabled ? '⏸️ Pause Seeding' : '▶️ Start Seeding'}</button></form>
                <form method="POST" action="/api/admin/action"><input type="hidden" name="action" value="toggle_pub"/><button class="green" type="submit">${settings.autoPublishEnabled ? '⏸️ Pause Publishing' : '▶️ Start Publishing'}</button></form>
                <form method="POST" action="/api/admin/action"><input type="hidden" name="action" value="run_now"/><button type="submit">⚡ Run Seeder & Publish 1 Now</button></form>
                <form method="POST" action="/api/admin/action"><input type="hidden" name="action" value="clean_queue"/><button class="amber" type="submit">🧹 Clean Non-Priority Queue</button></form>
                <form method="POST" action="/api/admin/action"><input type="hidden" name="action" value="stop_all"/><button class="red" type="submit">🛑 Emergency Stop All</button></form>
              </div>
            </div>

            <div class="card">
              <h3>⚙️ Configure Channel Links, Languages & Backfill Settings</h3>
              <form method="POST" action="/api/admin/settings">
                <label>🔗 Channel 01 URL (JOIN NOW):</label>
                <input type="text" name="channel01Url" value="${settings.channel01Url || ''}" />

                <label>🔗 Channel 02 URL (JOIN NOW):</label>
                <input type="text" name="channel02Url" value="${settings.channel02Url || ''}" />

                <label>💎 Premium Content URL:</label>
                <input type="text" name="premiumUrl" value="${settings.premiumUrl || ''}" />

                <label>🔞 18+ Content URL:</label>
                <input type="text" name="adultContentUrl" value="${settings.adultContentUrl || ''}" />

                <label>🔥 Our Rating (Admin Rating shown on posts):</label>
                <input type="text" name="ourRating" value="${settings.ourRating || '4.6/5'}" />

                <label>🌐 Allowed Original Languages (Comma separated ISO codes - hi,en,ta,te,ml,kn):</label>
                <input type="text" name="allowedLanguages" value="${settings.allowedLanguages || 'hi,en,ta,te,ml,kn'}" />

                <label>📅 Start Month (YYYY-MM) & Oldest Month (YYYY-MM):</label>
                <div style="display:flex; gap:1rem;">
                  <input type="text" name="startMonth" value="${settings.startMonth || '2026-10'}" />
                  <input type="text" name="oldestMonth" value="${settings.oldestMonth || '2020-01'}" />
                </div>

                <div class="btn-row">
                  <button type="submit" class="green">💾 Save All Settings</button>
                </div>
              </form>
            </div>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Server running, loading database stats...');
  }
});

app.post('/api/admin/action', async (req, res) => {
  const { action } = req.body;
  let settings = await AppSettings.findOne({ key: 'global' });
  if (!settings) settings = await AppSettings.create({ key: 'global' });

  if (action === 'toggle_seed') {
    settings.autoSeedingEnabled = !settings.autoSeedingEnabled;
    await settings.save();
  } else if (action === 'toggle_pub') {
    settings.autoPublishEnabled = !settings.autoPublishEnabled;
    await settings.save();
  } else if (action === 'stop_all') {
    settings.autoSeedingEnabled = false;
    settings.autoPublishEnabled = false;
    settings.aiEnabled = false;
    await settings.save();
  } else if (action === 'clean_queue') {
    const allowed = (settings.allowedLanguages || 'hi,en,ta,te,ml,kn')
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);
    await MediaItem.deleteMany({ isPublished: false, originalLanguage: { $nin: allowed } });
    // Reset current month job so it crawls with the clean language filter
    await MonthJob.deleteMany({ status: { $ne: 'COMPLETED' } });
  } else if (action === 'run_now') {
    runWorkerCycle();
  }

  res.redirect('/');
});

app.post('/api/admin/settings', async (req, res) => {
  const {
    channel01Url,
    channel02Url,
    premiumUrl,
    adultContentUrl,
    ourRating,
    allowedLanguages,
    startMonth,
    oldestMonth
  } = req.body;

  await AppSettings.updateOne(
    { key: 'global' },
    {
      $set: {
        channel01Url: (channel01Url || '').trim(),
        channel02Url: (channel02Url || '').trim(),
        premiumUrl: (premiumUrl || '').trim(),
        adultContentUrl: (adultContentUrl || '').trim(),
        ourRating: (ourRating || '').trim(),
        allowedLanguages: (allowedLanguages || 'hi,en,ta,te,ml,kn').trim(),
        startMonth: (startMonth || '2026-10').trim(),
        oldestMonth: (oldestMonth || '2020-01').trim()
      }
    },
    { upsert: true }
  );

  res.redirect('/');
});

const launchBotWithRetry = async (delayMs = 5000) => {
  try {
    await bot.launch({ dropPendingUpdates: true });
    console.log('Telegram Bot polling started');
  } catch (err: any) {
    console.error('Telegram Bot launch error (will retry if 409 conflict):', err?.message);
    if (String(err?.message || '').includes('409')) {
      setTimeout(() => launchBotWithRetry(delayMs), delayMs);
    }
  }
};

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB Atlas');

    app.listen(PORT, () => {
      console.log(`Web service running on port ${PORT}`);
    });

    launchBotWithRetry();

    await sendToLogChannel('🚀 <b>Bot System Upgraded (SEO + Full Details + Admin Panel)!</b>');

    startCronJobs();
  })
  .catch((err) => {
    console.error('MongoDB Connection Error:', err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
