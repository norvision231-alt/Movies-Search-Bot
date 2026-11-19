import cron from 'node-cron';
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const cleanupOldPostedMovies = async () => {
  try {
    const oldPublished = await MediaItem.find({ isPublished: true })
      .select('_id tmdbId mediaType')
      .limit(1000)
      .lean();

    if (oldPublished.length === 0) return;

    const historyOps = oldPublished.map((itm: any) => ({
      updateOne: {
        filter: { tmdbId: itm.tmdbId, mediaType: itm.mediaType },
        update: { $set: { tmdbId: itm.tmdbId, mediaType: itm.mediaType } },
        upsert: true
      }
    }));

    await PostedHistory.bulkWrite(historyOps, { ordered: false });
    const idsToDelete = oldPublished.map((itm: any) => itm._id);
    const delRes = await MediaItem.deleteMany({ _id: { $in: idsToDelete } });
    console.log(`🧹 Cleaned ${delRes.deletedCount} posted movies.`);
  } catch (err: any) {
    console.error('Cleanup Old Posted Error:', err?.message);
  }
};

export const enrichMediaItemWithDetails = async (
  item: any,
  aiEnabled = true,
  fastBatchMode = false
): Promise<any> => {
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
    if (!item.releaseDate && (details.release_date || details.first_air_date)) {
      item.releaseDate = details.release_date || details.first_air_date || '';
    }
  }

  const needsAi = fastBatchMode
    ? !item.overview || item.overview.length < 15
    : !item.overview || item.overview.length < 25 || !item.runtime || !item.imdbRating;

  if (aiEnabled && needsAi) {
    item = await enrichWithAI(item);
  }
  return item;
};

export const runWorkerCycle = async (forceNow = false): Promise<void> => {
  if (isJobRunning) return;
  isJobRunning = true;

  try {
    await cleanupOldPostedMovies();

    let settings: any = await AppSettings.findOne({ key: 'global' });
    if (!settings) {
      settings = await AppSettings.create({
        key: 'global',
        autoSeedingEnabled: true,
        autoPublishEnabled: true,
        publishIntervalMinutes: 1,
        postsPerBatch: 15
      });
    }

    const cycleStartTime = new Date();
    const now = cycleStartTime.getTime();
    const intervalMs = Math.max(1, Number(settings.publishIntervalMinutes || 1)) * 60 * 1000;
    const lastPub = settings.lastPublishAt ? new Date(settings.lastPublishAt).getTime() : 0;
    const graceMs = intervalMs >= 5 * 60 * 1000 ? 45 * 1000 : 5 * 1000;

    if (!forceNow && now - lastPub < Math.max(0, intervalMs - graceMs)) {
      console.log(`⏭️ Skipping: next batch in ${Math.ceil((intervalMs - (now - lastPub)) / 1000)}s`);
      return;
    }

    const allowedLangs = String(settings.allowedLanguages || 'hi,en,ta,te,ml,kn')
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);

    // 1. OPTIMIZED AUTO SEEDING (1 DB read + 1 bulkWrite instead of 40 DB calls)
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
          const validItems = data.results.filter((it: any) => Boolean(it.poster_path));
          const candidateIds = validItems.map((it: any) => it.id);

          const existingPosted = await PostedHistory.find({
            tmdbId: { $in: candidateIds },
            mediaType
          })
            .select('tmdbId')
            .lean();
          const postedSet = new Set(existingPosted.map((p: any) => p.tmdbId));

          const bulkOps = validItems
            .filter((item: any) => !postedSet.has(item.id))
            .map((item: any) => ({
              updateOne: {
                filter: { tmdbId: item.id, mediaType },
                update: {
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
                upsert: true
              }
            }));

          if (bulkOps.length > 0) {
            await MediaItem.bulkWrite(bulkOps, { ordered: false });
          }

          const maxPages = Math.min(Number(data.total_pages || 1), 500);
          activeJob.totalPages = maxPages;

          if (activeJob.currentPage >= maxPages || data.results.length === 0) {
            if (activeJob.mediaType === 'movie') {
              activeJob.mediaType = 'tv';
              activeJob.currentPage = 1;
              activeJob.totalPages = 1;
            } else {
              activeJob.status = 'COMPLETED';
            }
          } else {
            activeJob.currentPage += 1;
            activeJob.status = 'RUNNING';
          }

          await activeJob.save();
          settings.lastSeedAt = new Date();
          await settings.save();
        }
      }
    }

    // 2. AUTO PUBLISHING
    const targetChannel = getTargetChannel();
    if (settings.autoPublishEnabled && targetChannel) {
      const batchLimit = Math.min(20, Math.max(1, Number(settings.postsPerBatch || 10)));

      const priorityItems: any[] = await MediaItem.find({
        isPublished: false,
        userRequested: true
      })
        .sort({ requestedAt: 1 })
        .limit(batchLimit);

      const remainingSlots = batchLimit - priorityItems.length;
      let regularItems: any[] = [];

      if (remainingSlots > 0) {
        const excludeIds = priorityItems.map((p: any) => p._id);
        regularItems = await MediaItem.find({
          _id: { $nin: excludeIds },
          isPublished: false,
          originalLanguage: { $in: allowedLangs },
          posterPath: { $ne: '' }
        })
          .sort({ releaseDate: -1, voteCount: -1 })
          .limit(remainingSlots);
      }

      const batchToPublish = [...priorityItems, ...regularItems];
      let postedInThisCycle = 0;

      for (let i = 0; i < batchToPublish.length; i++) {
        let pendingItem = batchToPublish[i];

        const alreadyDone = await PostedHistory.findOne({
          tmdbId: pendingItem.tmdbId,
          mediaType: pendingItem.mediaType
        }).lean();

        if (alreadyDone) {
          await MediaItem.deleteOne({ _id: pendingItem._id });
          continue;
        }

        pendingItem = await enrichMediaItemWithDetails(
          pendingItem,
          settings.aiEnabled !== false,
          batchLimit > 5
        );
        const caption = formatCaption(pendingItem, settings);

        try {
          await sendPhotoSmart(targetChannel, pendingItem.posterPath || '', caption);

          await PostedHistory.updateOne(
            { tmdbId: pendingItem.tmdbId, mediaType: pendingItem.mediaType },
            { $set: { tmdbId: pendingItem.tmdbId, mediaType: pendingItem.mediaType } },
            { upsert: true }
          );
          await MediaItem.deleteOne({ _id: pendingItem._id });

          postedInThisCycle += 1;
          settings.lastPublishAt = new Date();
          await settings.save();
          console.log(`✅ [${postedInThisCycle}/${batchToPublish.length}] Published: ${pendingItem.title}`);

          if (Array.isArray(pendingItem.requestedBy) && pendingItem.requestedBy.length > 0) {
            const c1 = settings.channel01Url || 'https://t.me/yourchannel1';
            for (const uid of pendingItem.requestedBy) {
              try {
                await bot.telegram.sendMessage(
                  uid,
                  `🎉 <b>Good News!</b> Your requested title <b>${escapeHtml(pendingItem.title)}</b> has just been published!\n\n👉 <a href="${escapeHtml(c1)}"><b>VIEW ON CHANNEL NOW</b></a>`,
                  { parse_mode: 'HTML' }
                );
              } catch (_notifyErr) {}
            }
          }

          if (i < batchToPublish.length - 1) {
            await sleep(3200);
          }
        } catch (postErr: any) {
          const retryAfter = postErr?.response?.parameters?.retry_after;
          if (retryAfter) {
            console.warn(`⏳ Telegram FloodWait: sleeping ${retryAfter}s...`);
            await sleep((Number(retryAfter) + 1) * 1000);
          } else {
            console.error('Post send error:', postErr?.message);
            await notifyAdminError('Telegram Publisher', postErr, 'Check channel admin rights or retry from /admin.');
            break;
          }
        }
      }
    }
  } catch (error: any) {
    console.error('Worker Error:', error);
    await notifyAdminError('Worker Cycle', error, 'Check logs or retry from /admin.');
  } finally {
    isJobRunning = false;
  }
};

export const startCronJobs = (): void => {
  registerWorkerTrigger(() => runWorkerCycle(true));
  registerWorkerReset(() => {
    isJobRunning = false;
  });
  setTimeout(() => runWorkerCycle(true), 8000);
  cron.schedule('* * * * *', async () => {
    await runWorkerCycle(false);
  });
};
