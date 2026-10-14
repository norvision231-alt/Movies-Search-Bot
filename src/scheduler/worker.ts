import cron from 'node-cron';
import {
  fetchTMDBDiscover,
  fetchTMDBDetails,
  getMonthDateRange,
  getPreviousMonth,
  mapGenreIds
} from '../services/tmdb';
import { MediaItem, MonthJob, AppSettings } from '../database/models';
import {
  bot,
  formatCaption,
  buildPostKeyboard,
  sendToLogChannel,
  getTargetChannel
} from '../bot/telegram';

let isJobRunning = false;

export const enrichMediaItemWithDetails = async (item: any): Promise<any> => {
  const mediaType: 'movie' | 'tv' = item.mediaType === 'tv' ? 'tv' : 'movie';
  const details = await fetchTMDBDetails(item.tmdbId, mediaType);
  if (!details) return item;

  const genres =
    Array.isArray(details.genres) && details.genres.length > 0
      ? details.genres.map((g: any) => g.name)
      : item.genres;

  const runtime =
    details.runtime ||
    (Array.isArray(details.episode_run_time) && details.episode_run_time.length > 0
      ? details.episode_run_time[0]
      : 0) ||
    item.runtime ||
    0;

  const seasonCount = details.number_of_seasons || item.seasonCount || 0;
  const episodeCount = details.number_of_episodes || item.episodeCount || 0;
  const imdbId = details.external_ids?.imdb_id || details.imdb_id || item.imdbId || '';
  const spokenLanguages = Array.isArray(details.spoken_languages)
    ? details.spoken_languages.map((l: any) => l.english_name || l.name).filter(Boolean)
    : [];

  item.genres = genres;
  item.runtime = runtime;
  item.seasonCount = seasonCount;
  item.episodeCount = episodeCount;
  item.imdbId = imdbId;
  item.spokenLanguages = spokenLanguages;
  if (details.overview && !item.overview) {
    item.overview = details.overview;
  }
  await item.save();
  return item;
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

    const allowedLangs = (settings.allowedLanguages || 'hi,en,ta,te,ml,kn')
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);

    // 1. AUTO SEEDING (Movies + TV Series, Priority Languages Only)
    if (settings.autoSeedingEnabled) {
      let activeJob: any = await MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({
        month: -1
      });

      if (!activeJob) {
        const lastCompleted: any = await MonthJob.findOne({ status: 'COMPLETED' }).sort({
          month: 1
        });
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
          await sendToLogChannel(`🔄 Started seeding month: <b>${activeJob.month}</b>`);
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
            if (!item.poster_path && !item.overview) continue; // Skip blank placeholder entries

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

          const accessibleTotalPages = Math.min(Number(data.total_pages || 1), 500);
          activeJob.totalPages = accessibleTotalPages;

          if (activeJob.currentPage >= accessibleTotalPages || data.results.length === 0) {
            if (activeJob.mediaType === 'movie') {
              // Switch to TV/Web-Series for the same month before marking month completed
              activeJob.mediaType = 'tv';
              activeJob.currentPage = 1;
              activeJob.totalPages = 1;
              activeJob.status = 'RUNNING';
            } else {
              activeJob.status = 'COMPLETED';
              await sendToLogChannel(
                `✅ Month <b>${activeJob.month}</b> (Movies & Web-Series) collection completed!`
              );
            }
          } else {
            activeJob.currentPage += 1;
            activeJob.status = 'RUNNING';
          }

          await activeJob.save();
        }
      }
    }

    // 2. AUTO PUBLISHING TO LOG_CHANNEL (Only Allowed Languages + Full Enriched Details)
    const targetChannel = getTargetChannel();
    if (settings.autoPublishEnabled && targetChannel) {
      let pendingItem: any = await MediaItem.findOne({
        isPublished: false,
        originalLanguage: { $in: allowedLangs },
        posterPath: { $ne: '' }
      }).sort({ releaseDate: -1, voteCount: -1 });

      if (pendingItem) {
        pendingItem = await enrichMediaItemWithDetails(pendingItem);

        const caption = formatCaption(pendingItem, settings);
        const keyboard = buildPostKeyboard(settings);
        const posterUrl = pendingItem.posterPath
          ? `https://image.tmdb.org/t/p/w500${pendingItem.posterPath}`
          : null;

        let sentMsg: any;
        if (posterUrl) {
          sentMsg = await bot.telegram.sendPhoto(targetChannel, posterUrl, {
            caption,
            parse_mode: 'HTML',
            ...keyboard
          });
        } else {
          sentMsg = await bot.telegram.sendMessage(targetChannel, caption, {
            parse_mode: 'HTML',
            ...keyboard
          });
        }

        pendingItem.isPublished = true;
        pendingItem.telegramMessageId = sentMsg?.message_id || 0;
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
  setTimeout(() => {
    runWorkerCycle();
  }, 10000);

  cron.schedule('*/20 * * * *', async () => {
    console.log('Running scheduled 20-minute worker cycle...');
    await runWorkerCycle();
  });
};
