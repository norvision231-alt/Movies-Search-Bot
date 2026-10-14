import cron from 'node-cron';
import {
  fetchTMDBDiscover,
  fetchTMDBDetails,
  getMonthDateRange,
  getPreviousMonth,
  mapGenreIds,
  enrichWithAI
} from '../services/tmdb';
import { MediaItem, MonthJob, AppSettings } from '../database/models';
import {
  bot,
  formatCaption,
  buildPostKeyboard,
  notifyAdminError,
  getTargetChannel,
  registerWorkerTrigger
} from '../bot/telegram';

let isJobRunning = false;

export const enrichMediaItemWithDetails = async (item: any, aiEnabled = true): Promise<any> => {
  const mediaType: 'movie' | 'tv' = item.mediaType === 'tv' ? 'tv' : 'movie';
  const details = await fetchTMDBDetails(item.tmdbId, mediaType);

  if (details) {
    if (Array.isArray(details.genres) && details.genres.length > 0) {
      item.genres = details.genres.map((g: any) => g.name);
    }
    item.runtime =
      details.runtime ||
      (Array.isArray(details.episode_run_time) && details.episode_run_time[0]) ||
      item.runtime ||
      0;
    item.seasonCount = details.number_of_seasons || item.seasonCount || 0;
    item.episodeCount = details.number_of_episodes || item.episodeCount || 0;
    item.imdbId = details.external_ids?.imdb_id || details.imdb_id || item.imdbId || '';
    if (Array.isArray(details.spoken_languages)) {
      item.spokenLanguages = details.spoken_languages
        .map((l: any) => l.english_name || l.name)
        .filter(Boolean);
    }
    if (details.overview && (!item.overview || item.overview.length < 20)) {
      item.overview = details.overview;
    }
  }

  if (
    aiEnabled &&
    (!item.overview ||
      item.overview.length < 25 ||
      !Array.isArray(item.genres) ||
      item.genres.length === 0 ||
      !item.runtime ||
      !item.imdbRating)
  ) {
    item = await enrichWithAI(item);
  }

  await item.save();
  return item;
};

export const runWorkerCycle = async (forceNow = false): Promise<void> => {
  if (isJobRunning) return;
  isJobRunning = true;

  try {
    let settings: any = await AppSettings.findOne({ key: 'global' });
    if (!settings) settings = await AppSettings.create({ key: 'global' });

    const now = Date.now();
    const intervalMs = Math.max(1, Number(settings.publishIntervalMinutes || 20)) * 60 * 1000;
    const lastPub = settings.lastPublishAt ? new Date(settings.lastPublishAt).getTime() : 0;

    if (!forceNow && now - lastPub < intervalMs) {
      isJobRunning = false;
      return;
    }

    const allowedLangs = String(settings.allowedLanguages || 'hi,en,ta,te,ml,kn')
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);

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
            mediaType: 'movie',
            currentPage: 1,
            totalPages: 1,
            status: 'RUNNING'
          });
        }
      }

      if (activeJob) {
        const { startDate, endDate } = getMonthDateRange(activeJob.month);
        const mediaType: 'movie' | 'tv' = activeJob.mediaType === 'tv' ? 'tv' : 'movie';
        const data = await fetchTMDBDiscover(
          startDate,
          endDate,
          activeJob.currentPage,
          mediaType,
          allowedLangs.join('|')
        );

        if (data && Array.isArray(data.results)) {
          for (const item of data.results) {
            if (!item.poster_path) continue;
            await MediaItem.updateOne(
              { tmdbId: item.id, mediaType },
              {
                $set: {
                  title: item.title || item.name || 'Untitled',
                  originalTitle: item.original_title || item.original_name || '',
                  originalLanguage: item.original_language || '',
                  genres: mapGenreIds(item.genre_ids || []),
                  overview: item.overview || '',
                  posterPath: item.poster_path || '',
                  backdropPath: item.backdrop_path || '',
                  releaseDate: item.release_date || item.first_air_date || '',
                  tmdbRating: item.vote_average || 0,
                  voteCount: item.vote_count || 0,
                  collectionMonth: activeJob.month
                }
              },
              { upsert: true }
            );
          }

          const maxPages = Math.min(Number(data.total_pages || 1), 500);
          activeJob.totalPages = maxPages;

          if (activeJob.currentPage >= maxPages || data.results.length === 0) {
            if (activeJob.mediaType === 'movie') {
              activeJob.mediaType = 'tv';
              activeJob.currentPage = 1;
              activeJob.totalPages = 1;
              activeJob.status = 'RUNNING';
            } else {
              activeJob.status = 'COMPLETED';
            }
          } else {
            activeJob.currentPage += 1;
            activeJob.status = 'RUNNING';
          }

          await activeJob.save();
          settings.lastSeedAt = new Date();
        }
      }
    }

    const targetChannel = getTargetChannel();
    if (settings.autoPublishEnabled && targetChannel) {
      let pendingItem: any = await MediaItem.findOne({
        isPublished: false,
        originalLanguage: { $in: allowedLangs },
        posterPath: { $ne: '' }
      }).sort({ releaseDate: -1, voteCount: -1 });

      if (pendingItem) {
        pendingItem = await enrichMediaItemWithDetails(pendingItem, settings.aiEnabled !== false);
        const caption = formatCaption(pendingItem, settings);
        const keyboard = buildPostKeyboard(settings);
        const posterUrl = pendingItem.posterPath
          ? `https://image.tmdb.org/t/p/w500${pendingItem.posterPath}`
          : null;

        try {
          const sentMsg: any = posterUrl
            ? await bot.telegram.sendPhoto(targetChannel, posterUrl, { caption, parse_mode: 'HTML', ...keyboard })
            : await bot.telegram.sendMessage(targetChannel, caption, { parse_mode: 'HTML', ...keyboard });

          pendingItem.isPublished = true;
          pendingItem.telegramMessageId = sentMsg?.message_id || 0;
          await pendingItem.save();

          settings.lastPublishAt = new Date();
          await settings.save();
          console.log(`Published: ${pendingItem.title}`);
        } catch (postErr: any) {
          console.error('Post send error:', postErr?.message);
          await notifyAdminError('Telegram Publisher', postErr, 'Ensure bot is Admin in LOG_CHANNEL.');
        }
      }
    }
  } catch (error: any) {
    console.error('Worker Error:', error);
    await notifyAdminError('Worker Cycle', error, 'Check TMDB_API_TOKEN or MONGODB_URI.');
  } finally {
    isJobRunning = false;
  }
};

export const startCronJobs = (): void => {
  registerWorkerTrigger(() => runWorkerCycle(true));
  setTimeout(() => runWorkerCycle(true), 10000);
  cron.schedule('* * * * *', async () => {
    await runWorkerCycle(false);
  });
};
// === END OF FILE ===
