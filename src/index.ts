import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import mongoose from 'mongoose';
import { bot, notifyAdminError } from './bot/telegram';
import { startCronJobs, runWorkerCycle } from './scheduler/worker';
import { MediaItem, MonthJob, AppSettings, BotUser } from './database/models';

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
    let settings: any = await AppSettings.findOne({ key: 'global' });
    if (!settings) settings = await AppSettings.create({ key: 'global' });

    const total = await MediaItem.countDocuments();
    const published = await MediaItem.countDocuments({ isPublished: true });
    const pending = await MediaItem.countDocuments({ isPublished: false });
    const usersCount = await BotUser.countDocuments();
    const bannedCount = await BotUser.countDocuments({ isBanned: true });
    const activeJob: any = await MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({
      month: -1
    });

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Master Admin Panel - Movie Bot</title>
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; padding: 1.5rem; margin: 0; }
            .container { max-width: 860px; margin: 0 auto; }
            .card { background: #1e293b; padding: 1.5rem; border-radius: 12px; margin-bottom: 1.25rem; border: 1px solid #334155; }
            h2, h3 { margin-top: 0; color: #38bdf8; }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin-bottom: 1rem; }
            .stat-box { background: #0f172a; padding: 1rem; border-radius: 8px; border: 1px solid #334155; }
            .stat-val { font-size: 1.35rem; font-weight: bold; color: #4ade80; margin-top: 0.3rem; }
            label { display: block; margin: 0.75rem 0 0.3rem; font-size: 0.9rem; color: #cbd5e1; }
            input[type="text"], input[type="number"] { width: 100%; padding: 0.6rem; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: #fff; box-sizing: border-box; }
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
              <h2>👑 Master Admin Dashboard (Web + Telegram /admin)</h2>
              <div class="grid">
                <div class="stat-box">🌱 Auto Seeding<div class="stat-val">${settings.autoSeedingEnabled ? 'RUNNING' : 'PAUSED'}</div></div>
                <div class="stat-box">📤 Auto Publish<div class="stat-val">${settings.autoPublishEnabled ? 'RUNNING' : 'PAUSED'}</div></div>
                <div class="stat-box">⏱️ Post Interval<div class="stat-val">Every ${settings.publishIntervalMinutes || 20}m</div></div>
                <div class="stat-box">📅 Active Month<div class="stat-val">${activeJob ? `${activeJob.month} (${String(activeJob.mediaType).toUpperCase()})` : 'Idle'}</div></div>
                <div class="stat-box">🗄️ Total Titles<div class="stat-val">${total}</div></div>
                <div class="stat-box">✅ Published<div class="stat-val">${published}</div></div>
                <div class="stat-box">⏳ In Queue<div class="stat-val">${pending}</div></div>
                <div class="stat-box">👥 Users / Banned<div class="stat-val">${usersCount} / ${bannedCount}</div></div>
              </div>

              <div class="btn-row">
                <form method="POST" action="/api/admin/action"><input type="hidden" name="action" value="toggle_seed"/><button class="green" type="submit">${settings.autoSeedingEnabled ? '⏸️ Pause Seeding' : '▶️ Start Seeding'}</button></form>
                <form method="POST" action="/api/admin/action"><input type="hidden" name="action" value="toggle_pub"/><button class="green" type="submit">${settings.autoPublishEnabled ? '⏸️ Pause Publishing' : '▶️ Start Publishing'}</button></form>
                <form method="POST" action="/api/admin/action"><input type="hidden" name="action" value="run_now"/><button type="submit">⚡ Post 1 Movie Now</button></form>
                <form method="POST" action="/api/admin/action"><input type="hidden" name="action" value="clean_queue"/><button class="amber" type="submit">🧹 Clean Non-Priority Queue</button></form>
                <form method="POST" action="/api/admin/action"><input type="hidden" name="action" value="stop_all"/><button class="red" type="submit">🛑 Emergency Stop All</button></form>
              </div>
            </div>

            <div class="card">
              <h3>⚙️ Configure Channel Links, Auto-Post Time & Languages</h3>
              <form method="POST" action="/api/admin/settings">
                <label>⏱️ Auto-Posting Interval (in Minutes):</label>
                <input type="number" name="publishIntervalMinutes" value="${settings.publishIntervalMinutes || 20}" min="1" />

                <label>🔗 Channel 01 URL (JOIN NOW):</label>
                <input type="text" name="channel01Url" value="${settings.channel01Url || ''}" />

                <label>🔗 Channel 02 URL (JOIN NOW):</label>
                <input type="text" name="channel02Url" value="${settings.channel02Url || ''}" />

                <label>💎 Premium Content URL:</label>
                <input type="text" name="premiumUrl" value="${settings.premiumUrl || ''}" />

                <label>🔞 18+ Content URL:</label>
                <input type="text" name="adultContentUrl" value="${settings.adultContentUrl || ''}" />

                <label>🔥 Our Rating:</label>
                <input type="text" name="ourRating" value="${settings.ourRating || '4.7/5'}" />

                <label>🌐 Allowed Languages (hi,en,ta,te,ml,kn):</label>
                <input type="text" name="allowedLanguages" value="${settings.allowedLanguages || 'hi,en,ta,te,ml,kn'}" />

                <div class="btn-row">
                  <button type="submit" class="green">💾 Save All Settings</button>
                </div>
              </form>
            </div>
          </div>
        </body>
      </html>
    `);
  } catch (_err) {
    res.status(500).send('Server running, loading database stats...');
  }
});

app.post('/api/admin/action', async (req, res) => {
  const { action } = req.body;
  let settings: any = await AppSettings.findOne({ key: 'global' });
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
    const allowed = String(settings.allowedLanguages || 'hi,en,ta,te,ml,kn')
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);
    await MediaItem.deleteMany({
      isPublished: false,
      $or: [{ originalLanguage: {$nin: allowed } }, { posterPath: '' }]
    });
    await MonthJob.deleteMany({ status: { $ne: 'COMPLETED' } });
  } else if (action === 'run_now') {
    runWorkerCycle(true);
  }

  res.redirect('/');
});

app.post('/api/admin/settings', async (req, res) => {
  const {
    publishIntervalMinutes,
    channel01Url,
    channel02Url,
    premiumUrl,
    adultContentUrl,
    ourRating,
    allowedLanguages
  } = req.body;

  await AppSettings.updateOne(
    { key: 'global' },
    {
      $set: {
        publishIntervalMinutes: Math.max(1, Number(publishIntervalMinutes) || 20),
        channel01Url: String(channel01Url || '').trim(),
        channel02Url: String(channel02Url || '').trim(),
        premiumUrl: String(premiumUrl || '').trim(),
        adultContentUrl: String(adultContentUrl || '').trim(),
        ourRating: String(ourRating || '4.7/5').trim(),
        allowedLanguages: String(allowedLanguages || 'hi,en,ta,te,ml,kn').trim()
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
    console.error('Telegram Bot launch error (auto-retrying):', err?.message);
    if (String(err?.message || '').includes('409')) {
      setTimeout(() => launchBotWithRetry(delayMs), delayMs);
    } else {
      await notifyAdminError('Bot Launch', err, 'Verify BOT_TOKEN in Render Environment.');
    }
  }
};

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    console.
