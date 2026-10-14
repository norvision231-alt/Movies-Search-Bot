import cron from 'node-cron';
import { fetchTMDBDiscover } from '../services/tmdb';
import { MediaItem, MonthJob, AppSettings } from '../database/models';
import { bot, formatCaption, sendToLogChannel } from '../bot/telegram';

export const startCronJobs = () => {
  cron.schedule('*/20 * * * *', async () => {
    console.log("Running 20-minute Cron Job (Seeding & Publishing)...");
    
    let settings = await AppSettings.findOne({ key: 'global' });
    if (!settings) {
      settings = await AppSettings.create({ key: 'global' });
    }

    try {
      // 1. AUTO SEEDING (TMDB Crawl)
      if (settings.autoSeedingEnabled) {
        let activeJob = await MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({ month: -1 });
        if (!activeJob) {
          activeJob = await MonthJob.create({ month: "2026-10", status: 'RUNNING' });
          await sendToLogChannel(`🔄 Started new seeding month: <b>${activeJob.month}</b>`);
        }

        const startDate = `${activeJob.month}-01`;
        const endDate = `${activeJob.month}-31`;

        const data = await fetchTMDBDiscover(startDate, endDate, activeJob.currentPage);
        
        if (data && data.results) {
          for (const item of data.results) {
            await MediaItem.updateOne(
              { tmdbId: item.id, mediaType: 'movie' },
              { $set: {
                  title: item.title || item.name,
                  originalLanguage: item.original_language,
                  overview: item.overview,
                  posterPath: item.poster_path,
                  releaseDate: item.release_date || item.first_air_date,
                  tmdbRating: item.vote_average,
                  collectionMonth: activeJob.month
              }},
              { upsert: true }
            );
          }

          if (activeJob.currentPage >= data.total_pages) {
            activeJob.status = 'COMPLETED';
            await sendToLogChannel(`✅ Month <b>${activeJob.month}</b> fully seeded.`);
          } else {
            activeJob.currentPage += 1;
          }
          await activeJob.save();
        }
      }

      // 2. AUTO PUBLISHING
      if (settings.autoPublishEnabled && process.env.LOG_CHANNEL) {
        const pendingItem = await MediaItem.findOne({ isPublished: false }).sort({ releaseDate: -1 });
        
        if (pendingItem) {
          const caption = formatCaption(pendingItem, settings);
          const posterUrl = pendingItem.posterPath 
            ? `https://image.tmdb.org/t/p/w500${pendingItem.posterPath}` 
            : null;

          if (posterUrl) {
             await bot.telegram.sendPhoto(process.env.LOG_CHANNEL, posterUrl, {
               caption: caption,
               parse_mode: 'HTML'
             });
          } else {
             await bot.telegram.sendMessage(process.env.LOG_CHANNEL, caption, { parse_mode: 'HTML' });
          }

          pendingItem.isPublished = true;
          await pendingItem.save();
        }
      }

    } catch (error: any) {
      console.error("Worker Error:", error);
      await sendToLogChannel(`⚠️ <b>Worker Error:</b> ${error.message}`);
    }
  });
};
