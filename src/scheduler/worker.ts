import cron from 'node-cron';
import mongoose from 'mongoose';
import {
  fetchTMDBDiscover,
  fetchTMDBDetails,
  getMonthDateRange,
  getPreviousMonth,
  mapGenreIds,
  extractAvailableLanguages,
  enrichWithAI
} from '../services/tmdb';
import { MediaItem, PostedHistory, MonthJob, AppSettings } from '../database/models';

// चूँकि आपने सारा कोड index.ts में डाल दिया है, इसलिए हम '../index' से इम्पोर्ट कर रहे हैं
import {
  bot,
  formatCaption,
  sendPhotoSmart,
  notifyAdminError,
  getTargetChannel,
  registerWorkerTrigger,
  registerWorkerReset,
  escapeHtml
} from '../index'; 

let isJobRunning = false;

const checkAndPruneStorageIfNeeded = async () => {
  try {
    const adminDb = mongoose.connection.db?.admin();
    if (!adminDb) return;
    const stats = await mongoose.connection.db.stats();
    const storageSizeMB = (stats.storageSize || 0) / (1024 * 1024);

    if (storageSizeMB >= 460) {
      console.log(`⚠️ MongoDB storage is at ${storageSizeMB.toFixed(2)} MB (>=90%). Pruning old posted movies...`);

      const publishedItems = await MediaItem.find({ isPublished: true }).sort({ createdAt: 1 });
      const countToDelete = Math.floor(publishedItems.length * 0.8);

      if (countToDelete > 0) {
        const itemsToRemove = publishedItems.slice(0, countToDelete);
        for (const itm of itemsToRemove) {
          await PostedHistory.updateOne(
            { tmdbId: itm.tmdbId, mediaType: itm.mediaType },
            { $set: { tmdbId: itm.tmdbId, mediaType: itm.mediaType } },
            { upsert: true }
          );
          await MediaItem.deleteOne({ _id: itm._id });
        }
        console.log(`🧹 Pruned ${countToDelete} old posted movies.`);
      }
    }
  } catch (err: any) {
    console.error('Storage Prune Check Error:', err?.message);
  }
};

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
    item.availableLanguages = extractAvailableLanguages(details, item.originalLanguage);
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
    await checkAndPruneStorageIfNeeded();

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

    // 1. AUTO SEEDING
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

            const alreadyPosted = await PostedHistory.findOne({ tmdbId: item.id, mediaType });
            if (alreadyPosted) continue;

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

    // 2. AUTO PUBLISHING WITH 4-LAYER SMART PHOTO FALLBACK
    const targetChannel = getTargetChannel();
    if (settings.autoPublishEnabled && targetChannel) {
      let pendingItem: any = await MediaItem.findOne({
        isPublished: false,
        userRequested: true
      }).sort({ requestedAt: 1 });

      if (!pendingItem) {
        pendingItem = await MediaItem.findOne({
          isPublished: false,
          originalLanguage: { $in: allowedLangs },
          posterPath: { $ne: '' }
        }).sort({ releaseDate: -1, voteCount: -1 });
      }

      if (pendingItem) {
        const alreadyDone = await PostedHistory.findOne({
          tmdbId: pendingItem.tmdbId,
          mediaType: pendingItem.mediaType
        });
        if (alreadyDone) {
          pendingItem.isPublished = true;
          await pendingItem.save();
          return;
        }

        pendingItem = await enrichMediaItemWithDetails(pendingItem, settings.aiEnabled !== false);
        const caption = formatCaption(pendingItem, settings);

        try {
          const sentMsg: any = await sendPhotoSmart(
            targetChannel,
            pendingItem.posterPath || '',
            caption
          );

          pendingItem.isPublished = true;
          pendingItem.telegramMessageId = sentMsg?.message_id || 0;
          await pendingItem.save();

          await PostedHistory.updateOne(
            { tmdbId: pendingItem.tmdbId, mediaType: pendingItem.mediaType },
            { $set: { tmdbId: pendingItem.tmdbId, mediaType: pendingItem.mediaType } },
            { upsert: true }
          );

          settings.lastPublishAt = new Date();
          await settings.save();
          console.log(`Published successfully: ${pendingItem.title}`);

          if (Array.isArray(pendingItem.requestedBy) && pendingItem.requestedBy.length > 0) {
            const c1 = settings.channel01Url || 'https://t.me/yourchannel1';
            for (const uid of pendingItem.requestedBy) {
              try {
                await bot.telegram.sendMessage(
                  uid,
                  `🎉 <b>Good News!</b> Your requested title <b>${escapeHtml(pendingItem.title)}</b> has just been published to our channel!\n\n👉 <a href="${escapeHtml(c1)}"><b>VIEW ON CHANNEL NOW</b></a>`,
                  { parse_mode: 'HTML' }
                );
              } catch (_notifyErr) {}
            }
          }
        } catch (postErr: any) {
          console.error('Post send error:', postErr?.message);
          await notifyAdminError(
            'Telegram Publisher',
            postErr,
            'Click "Restart Render Server" or "Unlock & Retry Now" below.'
          );
        }
      }
    }
  } catch (error: any) {
    console.error('Worker Error:', error);
    await notifyAdminError('Worker Cycle', error, 'Click "Restart Render Server" below to reboot cleanly.');
  } finally {
    isJobRunning = false;
  }
};

export const startCronJobs = (): void => {
  registerWorkerTrigger(() => runWorkerCycle(true));
  registerWorkerReset(() => {
    isJobRunning = false;
  });
  setTimeout(() => runWorkerCycle(true), 10000);
  cron.schedule('* * * * *', async () => {
    await runWorkerCycle(false);
  });
};
