import cron from 'node-cron';
import { fetchTMDBDiscover } from '../services/tmdb';
import { MediaItem, MonthJob, AppSettings } from '../database/models';
import { bot, formatCaption, sendToLogChannel } from '../bot/telegram';

let isJobRunning = false;

const GENRE_MAP: Record<number, string> = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Sci-Fi',
  53: 'Thriller',
  10752: 'War',
  37: 'Western'
};

const mapGenreIds = (ids: number[] = []): string[] => {
  return ids.map((id) => GENRE_MAP[id]).filter(Boolean);
};

const getMonthDateRange = (monthStr: string): { startDate: string; endDate: string } => {
  const [yearStr, monStr] = monthStr.split('-');
  const year = Number(yearStr);
  const month = Number(monStr);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    startDate: `${year}-${String(month).padStart(2, '0')}-01`,
    endDate: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  };
};

const getPreviousMonth = (monthStr: string): string => {
  const [yearStr, monStr] = monthStr.split('-');
  let year = Number(yearStr);
  let month = Number(monStr) - 1;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
};

export const runWorkerCycle = async (): Promise<void> => {
  if (isJobRunning) {
    console.log('Worker cycle already running, skipping concurrent invocation.');
    return;
  }

  isJobRunning = true;

  try {
    let settings: any = await AppSettings.findOne({ key: 'global' });
    if (!settings) {
      settings = await AppSettings.create({ key: 'global' });
    }

    // 1. AUTO SEEDING (Newest to Oldest Month Backfill)
    if (settings.autoSeedingEnabled) {
      let activeJob: any = await MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({ month: -1 });

      if (!activeJob) {
        const lastCompleted: any = await MonthJob.findOne({ status: 'COMPLETED' }).sort({ month: 1 });
        const startMonth = settings.startMonth || process.env.BACKFILL_START_MONTH || '2026-10';
        const oldestMonth = settings.oldestMonth || process.env.BACKFILL_OLDEST_MONTH || '2020-01';
        const nextMonth = lastCompleted ? getPreviousMonth(lastCompleted.month) : startMonth;

        if (nextMonth >= oldestMonth) {
          activeJob = await MonthJob.create({
            month: nextMonth,
            currentPage: 1,
            totalPages: 1,
            status: 'RUNNING'
          });
          await sendToLogChannel(`🔄 Started seeding month: <b>${activeJob.month}</b>`);
        }
      }

      if (activeJob) {
        const { startDate, endDate } = getMonthDateRange(activeJob.month);
        const data = await fetchTMDBDiscover(startDate, endDate, activeJob.currentPage);

        if (data && Array.isArray(data.results)) {
          for (const item of data.results) {
            await MediaItem.updateOne(
              { tmdbId: item.id, mediaType: 'movie' },
              {
                $set: {
                  title: item.title || item.name || 'Untitled',
                  originalLanguage: item.original_language || '',
                  genres: mapGenreIds(item.genre_ids || []),
                  overview: item.overview || '',
                  posterPath: item.poster_path || '',
                  releaseDate: item.release_date || item.first_air_date || '',
                  tmdbRating: item.vote_average || 0,
                  collectionMonth: activeJob.month
                }
              },
              { upsert: true }
            );
          }

          const accessibleTotalPages = Math.min(Number(data.total_pages || 1), 500);
          activeJob.totalPages = accessibleTotalPages;

          if (activeJob.currentPage >= accessibleTotalPages || data.results.length === 0) {
            activeJob.status = 'COMPLETED';
            await sendToLogChannel(
              `✅ Month <b>${activeJob.month}</b> collection completed (${activeJob.currentPage} pages).`
            );
          } else {
            activeJob.currentPage += 1;
            activeJob.status = 'RUNNING';
          }

          await activeJob.save();
        }
      }
    }

    // 2. AUTO PUBLISHING TO LOG_CHANNEL
    const targetChannel = (process.env.LOG_CHANNEL || process.env.TELEGRAM_MAIN_CHANNEL_ID || '').trim();
    if (settings.autoPublishEnabled && targetChannel) {
      const pendingItem: any = await MediaItem.findOne({ isPublished: false }).sort({ releaseDate: -1 });

      if (pendingItem) {
        const caption = formatCaption(pendingItem, settings);
        const posterUrl = pendingItem.posterPath
          ? `https://image.tmdb.org/t/p/w500${pendingItem.posterPath}`
          : null;

        if (posterUrl) {
          await bot.telegram.sendPhoto(targetChannel, posterUrl, {
            caption,
            parse_mode: 'HTML'
          });
        } else {
          await bot.telegram.sendMessage(targetChannel, caption, {
            parse_mode: 'HTML'
          });
        }

        pendingItem.isPublished = true;
        await pendingItem.save();
        console.log(`Published to channel: ${pendingItem.title}`);
      }
    }
  } catch (error: any) {
    console.error('Worker Error:', error);
    await sendToLogChannel(`⚠️ <b>Worker Error:</b> ${error?.message || 'Unknown error'}`);
  } finally {
    isJobRunning = false;
  }
};

export const startCronJobs = (): void => {
  // Run initial cycle 10 seconds after boot
  setTimeout(() => {
    runWorkerCycle();
  }, 10000);

  // Schedule every 20 minutes
  cron.schedule('*/20 * * * *', async () => {
    console.log('Running scheduled 20-minute worker cycle...');
    await runWorkerCycle();
  });
};
