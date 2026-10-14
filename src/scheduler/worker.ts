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
  sendToLogChannel,
  notifyAdminError,
  getTargetChannel,
  registerWorkerTrigger
} from '../bot/telegram';

let isJobRunning = false;

export const enrichMediaItemWithDetails = async (item: any, aiEnabled: boolean = true): Promise<any> => {
  const mediaType: 'movie' | 'tv' = item.mediaType === 'tv' ? 'tv' : 'movie';
  const details = await fetchTMDBDetails(item.tmdbId, mediaType);

  if (details) {
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
    if (details.overview && (!item.overview || item.overview.length < 20)) {
      item.overview = details.overview;
    }
  }

  // Use DeepSeek / ChatGPT AI if any field is still missing
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

export const runWorkerCycle = async (forceNow: boolean = false): Promise<void> => {
  if (isJobRunning) return;
  isJobRunning = true;

  try {
    let settings: any = await AppSettings.findOne({ key: 'global' });
    if (!settings) {
      settings = await AppSettings.create({ key: 'global' });
    }

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

    // 1. AUTO SEEDING (Newest to Oldest Month Backfill - Movies & TV)
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
        }
      }

      if (activeJob) {
        const { startDate, endDate } = getMonthDateRange(activeJob.month);
        const mediaType: 'movie' | 'tv' = activeJob.mediaType === 'tv
