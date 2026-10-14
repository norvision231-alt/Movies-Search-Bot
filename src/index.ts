import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import mongoose from 'mongoose';
import { bot, sendToLogChannel } from './bot/telegram';
import { startCronJobs, runWorkerCycle } from './scheduler/worker';
import { MediaItem, MonthJob, AppSettings } from './database/models';

const app = express();
app.use(express.json());

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
    const total = await MediaItem.countDocuments();
    const published = await MediaItem.countDocuments({ isPublished: true });
    const pending = await MediaItem.countDocuments({ isPublished: false });
    const activeJob = await MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({ month: -1 });
    const settings = await AppSettings.findOne({ key: 'global' });

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Movie Database & Telegram Publisher</title>
          <style>
            body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; }
            .card { max-width: 640px; margin: 0 auto; background: #1e293b; padding: 1.5rem; border-radius: 12px; }
            .stat { margin: 0.75rem 0; font-size: 1.05rem; }
            .badge { padding: 0.2rem 0.6rem; border-radius: 6px; background: #334155; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>🎬 Automated Movie Bot Status</h2>
            <div class="stat">🌱 <b>Auto Seeding:</b> <span class="badge">${settings?.autoSeedingEnabled !== false ? 'RUNNING' : 'PAUSED'}</span></div>
            <div class="stat">📤 <b>Auto Publishing:</b> <span class="badge">${settings?.autoPublishEnabled !== false ? 'RUNNING' : 'PAUSED'}</span></div>
            <div class="stat">📅 <b>Active Backfill Month:</b> ${activeJob ? `${activeJob.month} (Page ${activeJob.currentPage}/${activeJob.totalPages})` : 'Initializing...'}</div>
            <div class="stat">🗄️ <b>Total Collected Titles:</b> ${total}</div>
            <div class="stat">✅ <b>Published to Telegram:</b> ${published}</div>
            <div class="stat">⏳ <b>Pending in Queue:</b> ${pending}</div>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Server running, loading database stats...');
  }
});

app.post('/api/admin/run-now', async (_req, res) => {
  runWorkerCycle();
  res.json({ message: 'Worker cycle triggered' });
});

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB Atlas');

    app.listen(PORT, () => {
      console.log(`Web service running on port ${PORT}`);
    });

    bot
      .launch()
      .then(() => console.log('Telegram Bot polling started'))
      .catch((err) => console.error('Telegram Bot launch error:', err));

    await sendToLogChannel('🚀 <b>Bot System Started & Connected to MongoDB!</b>');

    startCronJobs();
  })
  .catch((err) => {
    console.error('MongoDB Connection Error:', err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
