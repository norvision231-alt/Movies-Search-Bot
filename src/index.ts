import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import mongoose from 'mongoose';
import { bot } from './bot/telegram';
import { startCronJobs } from './scheduler/worker';
import { sendToLogChannel } from './bot/telegram';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("MONGODB_URI is required");
  process.exit(1);
}

// Basic Admin API for React Dashboard connection
app.post('/api/admin/toggle-seeding', async (req, res) => {
    // Implement authentication middleware here
    res.json({ message: "Seeding toggled" });
});

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log("Connected to MongoDB Atlas");
    
    // Start Express Web Server
    app.listen(PORT, () => {
      console.log(`Web service running on port ${PORT}`);
    });

    // Start Telegram Bot Polling
    bot.launch();
    console.log("Telegram Bot started");
    await sendToLogChannel("🚀 <b>Bot System Restarted & Database Connected!</b>");

    // Start 20-min Cron Scheduler
    startCronJobs();
  })
  .catch((err) => {
    console.error("MongoDB Connection Error:", err);
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
