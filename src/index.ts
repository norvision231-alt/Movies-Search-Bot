import axios from 'axios';
import * as http from 'http';
import mongoose from 'mongoose';
import { startCronJobs, cleanupOldPostedMovies } from './scheduler/worker';
import { Telegraf, Markup } from 'telegraf';
import { MediaItem, MonthJob, AppSettings, BotUser, PostedHistory } from './database/models';
import {
  searchTMDBMulti,
  fetchTMDBDetails,
  mapGenreIds,
  extractAvailableLanguages,
  suggestCorrectTitleWithAI,
  enrichWithAI,
  LANG_NAME_MAP
} from './services/tmdb';

const token = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!token) throw new Error('BOT_TOKEN is missing');

export const bot = new Telegraf(token);

let dbConnectPromise: Promise<typeof mongoose> | null = null;
export const ensureDbConnected = async (): Promise<void> => {
  if (mongoose.connection.readyState === 1) return;
  const mongoUri = (process.env.MONGODB_URI || '').trim();
  if (!mongoUri) throw new Error('MONGODB_URI is missing');
  if (!dbConnectPromise) {
    dbConnectPromise = mongoose
      .connect(mongoUri, { maxPoolSize: 10, serverSelectionTimeoutMS: 8000 })
      .catch((err) => {
        dbConnectPromise = null;
        throw err;
      });
  }
  await dbConnectPromise;
};

let triggerWorkerNow: (() => Promise<void>) | null = null;
export const registerWorkerTrigger = (fn: () => Promise<void>) => {
  triggerWorkerNow = fn;
};

let resetWorkerLockFn: (() => void) | null = null;
export const registerWorkerReset = (fn: () => void) => {
  resetWorkerLockFn = fn;
};

const setAdminStep = async (uid: number, step: string): Promise<void> => {
  await BotUser.findOneAndUpdate({ telegramId: uid }, { $set: { adminStep: step } }, { upsert: true });
};

const clearAdminStep = async (uid?: number): Promise<void> => {
  if (!uid) return;
  await BotUser.updateOne({ telegramId: uid }, { $set: { adminStep: '' } });
};

const getAdminStep = async (uid?: number): Promise<string> => {
  if (!uid) return '';
  const u: any = await BotUser.findOne({ telegramId: uid }).select('adminStep').lean();
  return String(u?.adminStep || '');
};

export const getTargetChannel = (): string =>
  (process.env.LOG_CHANNEL || process.env.TELEGRAM_MAIN_CHANNEL_ID || '').trim();

export const getAdminIds = (): string[] =>
  (process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((id: string) => id.trim())
    .filter(Boolean);

export const isAdmin = (userId?: number): boolean =>
  Boolean(userId && getAdminIds().includes(String(userId)));

export const escapeHtml = (unsafe: string = ''): string =>
  String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const formatRuntimeHoursMins = (totalMinutes?: number): string => {
  const mins = Number(totalMinutes || 0);
  if (!mins || mins <= 0) return '';
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours > 0 && remMins > 0) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ${remMins} min`;
  if (hours > 0) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${remMins} min`;
};

const createSeoHashtags = (media: any, langName: string): string => {
  const cleanTitle = String(media.title || '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
  const year = media.releaseDate ? String(media.releaseDate).substring(0, 4) : '';
  const typeTag = media.mediaType === 'tv' ? '#WebSeries #TVSeries' : '#Movies #FullMovie';
  const langTag = langName.split(',')[0].trim().replace(/[^a-zA-Z]/g, '');
  const genreTags = Array.isArray(media.genres)
    ? media.genres.slice(0, 3).map((g: string) => `#${String(g).replace(/[^a-zA-Z0-9]/g, '')}`).join(' ')
    : '';
  return [cleanTitle ? `#${cleanTitle}` : '', year ? `#Release${year}` : '', langTag ? `#${langTag}` : '', typeTag, genreTags, '#HDMovies']
    .filter(Boolean)
    .join(' ');
};

export const getDisplayLanguages = (media: any): string => {
  const langCode = String(media.originalLanguage || '').toLowerCase();
  const primary = LANG_NAME_MAP[langCode] || '';
  const avail = Array.isArray(media.availableLanguages) ? media.availableLanguages : [];
  const spoken = Array.isArray(media.spokenLanguages) ? media.spokenLanguages : [];
  const combined = Array.from(new Set([primary, ...avail, ...spoken].filter(Boolean)));
  if (combined.length > 0) return combined.join(', ');
  return String(media.originalLanguage || 'English').toUpperCase();
};

export const formatCaption = (media: any, settings: any, extraFooterHtml = ''): string => {
  const title = escapeHtml(media.title || 'Untitled');
  const year = media.releaseDate ? escapeHtml(String(media.releaseDate).substring(0, 4)) : 'N/A';
  const fullReleaseDate = media.releaseDate ? escapeHtml(String(media.releaseDate).trim()) : 'N/A';
  const langDisplay = getDisplayLanguages(media);

  const genres =
    Array.isArray(media.genres) && media.genres.length > 0
      ? escapeHtml(media.genres.join(', '))
      : 'Drama, Action';

  const tmdbRating =
    media.tmdbRating && Number(media.tmdbRating) > 0
      ? `${Number(media.tmdbRating).toFixed(1)}/10`
      : 'New Release';

  const c1 = (settings?.channel01Url || 'https://t.me/yourchannel1').trim();
  const c2 = (settings?.channel02Url || 'https://t.me/yourchannel2').trim();
  const prem = (settings?.premiumUrl || c1).trim();
  const adult = (settings?.adultContentUrl || c2).trim();
  const ourRating = String(settings?.ourRating || '4.7/5').trim();

  const headerLines: string[] = [`🔥 <b>${title}</b> (${year})`];
  if (media.imdbRating) {
    headerLines.push(`⭐ <b>IMDb:</b> ${escapeHtml(String(media.imdbRating))}`);
  } else if (media.imdbId) {
    headerLines.push(`⭐ <b>IMDb:</b> <a href="https://www.imdb.com/title/${escapeHtml(media.imdbId)}/"><b>Verified on IMDb</b></a>`);
  }
  if (media.rtRating) headerLines.push(`🍅 <b>RT Audience:</b> ${escapeHtml(String(media.rtRating))}`);

  headerLines.push(`🌐 <b>Available in:</b> ${escapeHtml(langDisplay)}`, `🎭 <b>Genre:</b> ${genres}`);

  if (media.mediaType === 'tv' && media.seasonCount && Number(media.seasonCount) > 0) {
    const ep = media.episodeCount ? ` (${media.episodeCount} Episodes)` : '';
    headerLines.push(`📺 <b>Seasons:</b> ${escapeHtml(String(media.seasonCount))}${escapeHtml(ep)}`);
  }

  const formattedRuntime = formatRuntimeHoursMins(media.runtime);
  if (formattedRuntime) headerLines.push(`⏱️ <b>Runtime:</b> ${escapeHtml(formattedRuntime)}`);
  headerLines.push(`⭐ <b>TMDB Rating:</b> ${escapeHtml(tmdbRating)}`);
  if (ourRating) headerLines.push(`🔥 <b>Our Rating:</b> ${escapeHtml(ourRating)}`);
  headerLines.push(`📅 <b>Release Date:</b> ${fullReleaseDate}`);

  const footerLines: string[] = [
    '━━━━━━━━━━━━━━',
    `🔗 <b>JOIN CHANNEL 01:</b> 👉 <a href="${escapeHtml(c1)}"><b>JOIN NOW</b></a>`,
    `🔗 <b>JOIN CHANNEL 02:</b> 👉 <a href="${escapeHtml(c2)}"><b>JOIN NOW</b></a>`,
    `💎 <a href="${escapeHtml(prem)}"><b>JOIN PREMIUM CONTENT</b></a>`,
    '━━━━━━━━━━━━━━',
    `🔞 <a href="${escapeHtml(adult)}"><b>18+ CONTENT ONLY</b></a>`,
    '⚠️ <i>Adults only where applicable. Viewer discretion advised.</i>'
  ];

  if (extraFooterHtml) footerLines.push('━━━━━━━━━━━━━━', extraFooterHtml);
  footerLines.push('', escapeHtml(createSeoHashtags(media, langDisplay)));

  const headerBlock = headerLines.join('\n');
  const footerBlock = footerLines.join('\n');

  const visibleLen = (s: string) => s.replace(/<[^>]+>/g, '').length;
  const maxOverviewChars = Math.max(0, 1000 - visibleLen(headerBlock) - visibleLen(footerBlock) - 10);

  const rawOverview = media.overview ? String(media.overview).trim() : '';
  const fallbackDesc = `Watch ${media.title} (${year}), an engaging ${genres.toLowerCase()} ${
    media.mediaType === 'tv' ? 'web series' : 'movie'
  } available in ${langDisplay} in HD quality.`;
  const descSource = rawOverview.length > 15 ? rawOverview : fallbackDesc;

  if (maxOverviewChars > 30) {
    const trimmed =
      descSource.length > maxOverviewChars
        ? `${descSource.substring(0, maxOverviewChars - 3)}...`
        : descSource;
    return `${headerBlock}\n\n<i>${escapeHtml(trimmed)}</i>\n${footerBlock}`;
  }
  return `${headerBlock}\n${footerBlock}`;
};

export const sendPhotoSmart = async (
  chatId: string | number,
  posterPath: string,
  caption: string
): Promise<any> => {
  const cleanPath = (posterPath || '').trim();
  if (cleanPath) {
    const normalizedPath = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
    const url500 = `https://image.tmdb.org/t/p/w500${normalizedPath}`;
    const url342 = `https://image.tmdb.org/t/p/w342${normalizedPath}`;

    try {
      return await bot.telegram.sendPhoto(chatId, url500, { caption, parse_mode: 'HTML' });
    } catch (err1: any) {
      if (err1?.response?.parameters?.retry_after) throw err1;
      const desc = String(err1?.response?.description || err1?.message || '');
      if (desc.includes('caption') || desc.includes('chat not found') || desc.includes('kicked')) {
        return await bot.telegram.sendMessage(chatId, caption, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true }
        } as any);
      }
    }

    try {
      return await bot.telegram.sendPhoto(chatId, url342, { caption, parse_mode: 'HTML' });
    } catch (err2: any) {
      if (err2?.response?.parameters?.retry_after) throw err2;
    }

    try {
      const responseSmall = await axios.get(url342, {
        responseType: 'arraybuffer',
        timeout: 12000,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' }
      });
      return await bot.telegram.sendPhoto(
        chatId,
        { source: Buffer.from(responseSmall.data), filename: 'poster.jpg' },
        { caption, parse_mode: 'HTML' }
      );
    } catch (err3: any) {
      if (err3?.response?.parameters?.retry_after) throw err3;
    }
  }

  return await bot.telegram.sendMessage(chatId, caption, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true }
  } as any);
};

export const notifyAdminError = async (source: string, error: any, fixHint = '') => {
  const errMsg = escapeHtml(error?.response?.data?.description || error?.message || String(error));
  const msg =
    `🚨 <b>ERROR ALERT [${escapeHtml(source)}]</b>\n\n` +
    `❌ <b>Error:</b> <code>${errMsg}</code>\n` +
    `🛠️ <b>Fix:</b> ${escapeHtml(fixHint || 'Check /admin settings.')}`;
  for (const id of getAdminIds()) {
    try {
      await bot.telegram.sendMessage(id, msg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ Open Master Admin Panel', 'admin_home')]
        ])
      });
    } catch (_e) {}
  }
};

const queueMovieForChannelAndGetTimer = async (item: any, userId?: number, settings?: any): Promise<string> => {
  const alreadyPosted =
    item.isPublished ||
    (await PostedHistory.findOne({ tmdbId: item.tmdbId, mediaType: item.mediaType }).lean());
  if (alreadyPosted) return `✅ <b>Channel Status:</b> Already Published on Channel!`;

  if (!item.userRequested) {
    item.userRequested = true;
    item.requestedAt = new Date();
  }
  if (userId && Array.isArray(item.requestedBy) && !item.requestedBy.includes(userId)) {
    item.requestedBy.push(userId);
  }
  await item.save();

  const aheadCount = await MediaItem.countDocuments({
    isPublished: false,
    userRequested: true,
    requestedAt: { $lt: item.requestedAt || new Date() }
  });
  const position = aheadCount + 1;

  const intervalMins = Math.max(1, Number(settings?.publishIntervalMinutes || 5));
  const postsPerBatch = Math.max(1, Number(settings?.postsPerBatch || 10));
  const batchesAhead = Math.floor((position - 1) / postsPerBatch);
  const slotInBatch = (position - 1) % postsPerBatch;

  const now = Date.now();
  const targetPostMs = now + batchesAhead * intervalMins * 60000 + (slotInBatch + 1) * 3200;
  const waitSec = Math.max(5, Math.floor((targetPostMs - now) / 1000));
  const waitMins = Math.floor(waitSec / 60);
  const remSec = waitSec % 60;

  const istTimeStr = new Date(targetPostMs).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  const timerText = waitMins > 0 ? `${waitMins} min ${remSec} sec` : `${remSec} sec`;
  return (
    `⏳ <b>Channel Auto-Post Queue:</b> Position <b>#${position}</b>\n` +
    `⏰ <b>Est. Post Time:</b> ~<b>${timerText}</b> (<b>${istTimeStr} IST</b>)`
  );
};

export const sendMediaCardToChat = async (ctx: any, item: any) => {
  let s: any = await AppSettings.findOne({ key: 'global' });
  if (!s) s = await AppSettings.create({ key: 'global' });
  const queueTimerHtml = await queueMovieForChannelAndGetTimer(item, ctx.from?.id, s);
  const caption = formatCaption(item, s, queueTimerHtml);
  return sendPhotoSmart(ctx.chat.id, item.posterPath || '', caption);
};

const calcSimilarity = (a: string, b: string): number => {
  const s1 = a.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const s2 = b.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (!s1 || !s2) return 0;
  if (s1 === s2 || s2.includes(s1) || s1.includes(s2)) return 0.95;

  const track = Array(s2.length + 1)
    .fill(null)
    .map(() => Array(s1.length + 1).fill(null));
  for (let i = 0; i <= s1.length; i += 1) track[0][i] = i;
  for (let j = 0; j <= s2.length; j += 1) track[j][0] = j;
  for (let j = 1; j <= s2.length; j += 1) {
    for (let i = 1; i <= s1.length; i += 1) {
      const ind = s1[i - 1] === s2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(track[j][i - 1] + 1, track[j - 1][i] + 1, track[j - 1][i - 1] + ind);
    }
  }
  const distance = track[s2.length][s1.length];
  const maxLen = Math.max(s1.length, s2.length);
  return maxLen > 0 ? (maxLen - distance) / maxLen : 0;
};

bot.use(async (ctx, next) => {
  await ensureDbConnected();
  if (ctx.from && ctx.chat?.type === 'private') {
    try {
      const u: any = await BotUser.findOneAndUpdate(
        { telegramId: ctx.from.id },
        { $set: { firstName: ctx.from.first_name || '', username: ctx.from.username || '' } },
        { upsert: true, new: true }
      ).lean();
      if (u?.isBanned && !isAdmin(ctx.from.id)) {
        return ctx.reply('🚫 You are banned from using this bot.');
      }
    } catch (_e) {}
  }
  return next();
});

const renderAdminPanel = async (ctx: any, edit = false) => {
  let s: any = await AppSettings.findOne({ key: 'global' });
  if (!s) s = await AppSettings.create({ key: 'global' });

  const [totalInQueue, postedHistoryCount, priorityQueue, totalUsers, bannedUsers, activeJob]: any = await Promise.all([
    MediaItem.countDocuments({ isPublished: false }),
    PostedHistory.countDocuments(),
    MediaItem.countDocuments({ isPublished: false, userRequested: true }),
    BotUser.countDocuments(),
    BotUser.countDocuments({ isBanned: true }),
    MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({ month: -1 }).lean()
  ]);

  const mins = s.publishIntervalMinutes || 5;
  const batch = s.postsPerBatch || 10;

  const text =
    `👑 <b>MASTER ADMIN CONTROL PANEL</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🌱 <b>Auto Seeding:</b> ${s.autoSeedingEnabled ? '🟢 RUNNING' : '🔴 PAUSED'}\n` +
    `📤 <b>Auto Publishing:</b> ${s.autoPublishEnabled ? '🟢 RUNNING' : '🔴 PAUSED'}\n` +
    `🚀 <b>Posting Speed:</b> <code>${batch} Movies / ${mins} Min</code>\n` +
    `🤖 <b>AI Fallback:</b> ${s.aiEnabled !== false ? '🟢 ACTIVE' : '🔴 OFF'}\n` +
    `📅 <b>Active Month:</b> <code>${activeJob ? `${activeJob.month} (${String(activeJob.mediaType).toUpperCase()} P${activeJob.currentPage}/${activeJob.totalPages})` : 'Idle'}</code>\n` +
    `⭐ <b>Our Rating:</b> <code>${escapeHtml(s.ourRating || '4.7/5')}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⏳ <b>Queue:</b> ${totalInQueue} | ✅ <b>Posted:</b> ${postedHistoryCount}\n` +
    `🔥 <b>Priority:</b> ${priorityQueue} | 👥 <b>Users:</b> ${totalUsers} (🚫 ${bannedUsers})`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(s.autoPublishEnabled ? '⏸️ Stop Auto-Post' : '▶️ Start Auto-Post', 'admin_toggle_pub'),
      Markup.button.callback(s.autoSeedingEnabled ? '⏸️ Stop Seeding' : '▶️ Start Seeding', 'admin_toggle_seed')
    ],
    [
      Markup.button.callback('🚀 10 Posts / 5m', 'admin_speed_eco'),
      Markup.button.callback(`⏱️ Speed (${batch}/${mins}m)`, 'admin_menu_time')
    ],
    [
      Markup.button.callback('⚡ Run Batch Now', 'admin_run_now'),
      Markup.button.callback('🧹 Delete Old Posted', 'admin_clean_posted')
    ],
    [
      Markup.button.callback('🔗 Set Channel Links', 'admin_menu_links'),
      Markup.button.callback('⭐ Set Our Rating', 'admin_prompt_rating')
    ],
    [
      Markup.button.callback('📢 Broadcast Msg', 'admin_prompt_broadcast'),
      Markup.button.callback('📌 Broadcast & Pin', 'admin_prompt_broadcast_pin')
    ],
    [
      Markup.button.callback('🚫 Ban User', 'admin_prompt_ban'),
      Markup.button.callback('✅ Unban User', 'admin_prompt_unban')
    ],
    [
      Markup.button.callback(s.aiEnabled !== false ? '🤖 Disable AI' : '🤖 Enable AI', 'admin_toggle_ai'),
      Markup.button.callback('🧹 Clean Invalid Queue', 'admin_clean_queue')
    ],
    [
      Markup.button.callback('🛑 Emergency Stop All', 'admin_stop_all'),
      Markup.button.callback('🔃 Refresh Panel', 'admin_home')
    ]
  ]);

  if (edit && ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb });
    } catch (_e) {
      return ctx.replyWithHTML(text, kb);
    }
  }
  return ctx.replyWithHTML(text, kb);
};

bot.start((ctx) => {
  ctx.replyWithHTML(
    '🎬 <b>Welcome to the Movie & Web-Series Bot!</b>\n\n' +
      '🔎 <b>How to Search:</b> Send any Movie or Web-Series title (e.g., <code>Kingsman</code>, <code>Inception 2010</code>).\n' +
      '⏳ If a title is not yet on our channel, it gets added to the <b>Priority Auto-Post Queue</b> with a live timer!\n' +
      '🆕 Send <code>/latest</code> for recent releases.'
  );
});

bot.help((ctx) => {
  ctx.replyWithHTML(
    '📌 <b>Commands:</b>\n' +
      '• <code>/search &lt;title&gt;</code> - Search by title\n' +
      '• <code>/latest</code> - Latest 10 titles\n' +
      '• <code>/status</code> - Bot & Queue status\n' +
      '• <code>/admin</code> - Master Admin Panel'
  );
});

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply(`⛔ Access Denied. Your ID: ${ctx.from?.id}`);
  await clearAdminStep(ctx.from?.id);
  return renderAdminPanel(ctx, false);
});

bot.command('cancel', async (ctx) => {
  await clearAdminStep(ctx.from?.id);
  return ctx.reply('✅ Action cancelled.');
});

bot.command('ban', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ Admin only.');
  const id = Number(ctx.message.text.split(/\s+/)[1]);
  if (!id) return ctx.reply('Usage: /ban <User_ID>');
  await BotUser.findOneAndUpdate({ telegramId: id }, { $set: { isBanned: true } }, { upsert: true });
  return ctx.reply(`🚫 User ${id} BANNED.`);
});

bot.command('unban', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ Admin only.');
  const id = Number(ctx.message.text.split(/\s+/)[1]);
  if (!id) return ctx.reply('Usage: /unban <User_ID>');
  await BotUser.findOneAndUpdate({ telegramId: id }, { $set: { isBanned: false } }, { upsert: true });
  return ctx.reply(`✅ User ${id} UNBANNED.`);
});

bot.action('admin_home', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  await clearAdminStep(ctx.from?.id);
  await ctx.answerCbQuery('Refreshed');
  return renderAdminPanel(ctx, true);
});

bot.action('admin_speed_eco', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  await AppSettings.updateOne(
    { key: 'global' },
    { $set: { publishIntervalMinutes: 5, postsPerBatch: 10, autoPublishEnabled: true } },
    { upsert: true }
  );
  await ctx.answerCbQuery('Set to 10 Posts / 5 Mins');
  return renderAdminPanel(ctx, true);
});

bot.action('admin_clean_posted', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  await cleanupOldPostedMovies();
  await ctx.answerCbQuery('Cleaned!');
  return renderAdminPanel(ctx, true);
});

bot.action('admin_toggle_seed', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const s: any = await AppSettings.findOne({ key: 'global' }).lean();
  const next = !(s?.autoSeedingEnabled ?? true);
  await AppSettings.updateOne({ key: 'global' }, { $set: { autoSeedingEnabled: next } }, { upsert: true });
  await ctx.answerCbQuery(`Seeding: ${next ? 'ON' : 'OFF'}`);
  return renderAdminPanel(ctx, true);
});

bot.action('admin_toggle_pub', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const s: any = await AppSettings.findOne({ key: 'global' }).lean();
  const next = !(s?.autoPublishEnabled ?? true);
  await AppSettings.updateOne({ key: 'global' }, { $set: { autoPublishEnabled: next } }, { upsert: true });
  await ctx.answerCbQuery(`Publishing: ${next ? 'ON' : 'OFF'}`);
  return renderAdminPanel(ctx, true);
});

bot.action('admin_toggle_ai', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const s: any = await AppSettings.findOne({ key: 'global' }).lean();
  const next = !(s?.aiEnabled ?? true);
  await AppSettings.updateOne({ key: 'global' }, { $set: { aiEnabled: next } }, { upsert: true });
  await ctx.answerCbQuery(`AI: ${next ? 'ON' : 'OFF'}`);
  return renderAdminPanel(ctx, true);
});

bot.action('admin_run_now', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  if (resetWorkerLockFn) resetWorkerLockFn();
  await AppSettings.updateOne({ key: 'global' }, { $set: { autoPublishEnabled: true } }, { upsert: true });
  await ctx.answerCbQuery('Done');
  if (triggerWorkerNow) {
    triggerWorkerNow().catch((e) => console.error(e));
    return ctx.reply('⚡ Immediate batch started!');
  }
  return ctx.reply('ℹ️ Auto-poster runs automatically every 5 mins via GitHub Actions (or run manually in GitHub Actions tab).');
});

bot.action('admin_menu_time', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  await ctx.answerCbQuery();
  return ctx.editMessageText('⏱️ <b>SELECT AUTO-POSTING SPEED:</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('⚡ 10 Posts / 5m', 'admin_speed_eco'),
        Markup.button.callback('🚀 15 Posts / 5m', 'admin_set_batch_15')
      ],
      [
        Markup.button.callback('1 Post / 5 Mins', 'admin_set_time_5'),
        Markup.button.callback('1 Post / 15 Mins', 'admin_set_time_15')
      ],
      [Markup.button.callback('✏️ Custom Minutes', 'admin_prompt_time')],
      [Markup.button.callback('⬅️ Back', 'admin_home')]
    ])
  });
});

bot.action('admin_set_batch_15', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  await AppSettings.updateOne(
    { key: 'global' },
    { $set: { publishIntervalMinutes: 5, postsPerBatch: 15, autoPublishEnabled: true } },
    { upsert: true }
  );
  await ctx.answerCbQuery('Set to 15 Posts / 5 Mins');
  return renderAdminPanel(ctx, true);
});

bot.action(/^admin_set_time_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const mins = Math.max(1, Number(ctx.match[1]));
  await AppSettings.updateOne({ key: 'global' }, { $set: { publishIntervalMinutes: mins, postsPerBatch: 1 } }, { upsert: true });
  await ctx.answerCbQuery(`Set to 1 Post / ${mins}m`);
  return renderAdminPanel(ctx, true);
});

bot.action('admin_menu_links', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const s: any = await AppSettings.findOne({ key: 'global' }).lean();
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    `🔗 <b>CHANNEL LINKS</b>\n\n1️⃣ C1: ${escapeHtml(s?.channel01Url || '')}\n2️⃣ C2: ${escapeHtml(s?.channel02Url || '')}\n💎 Prem: ${escapeHtml(s?.premiumUrl || '')}\n🔞 18+: ${escapeHtml(s?.adultContentUrl || '')}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Channel 01', 'admin_link_c1'), Markup.button.callback('✏️ Channel 02', 'admin_link_c2')],
        [Markup.button.callback('💎 Premium URL', 'admin_link_prem'), Markup.button.callback('🔞 18+ URL', 'admin_link_adult')],
        [Markup.button.callback('⬅️ Back', 'admin_home')]
      ])
    }
  );
});

const promptStep = (actionName: string, stepName: string, msg: string) => {
  bot.action(actionName, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
    if (ctx.from?.id) await setAdminStep(ctx.from.id, stepName);
    await ctx.answerCbQuery();
    return ctx.reply(msg);
  });
};

promptStep('admin_prompt_time', 'SET_TIME', '⏱️ Send custom interval in minutes (e.g. 5), or /cancel:');
promptStep('admin_link_c1', 'LINK_C1', '🔗 Send new URL for CHANNEL 01, or /cancel:');
promptStep('admin_link_c2', 'LINK_C2', '🔗 Send new URL for CHANNEL 02, or /cancel:');
promptStep('admin_link_prem', 'LINK_PREM', '💎 Send new URL for PREMIUM CONTENT, or /cancel:');
promptStep('admin_link_adult', 'LINK_ADULT', '🔞 Send new URL for 18+ CONTENT, or /cancel:');
promptStep('admin_prompt_rating', 'SET_RATING', '⭐ Send new "Our Rating" (e.g. 4.8/5), or /cancel:');
promptStep('admin_prompt_ban', 'BAN_USER', '🚫 Send User Telegram ID to BAN, or /cancel:');
promptStep('admin_prompt_unban', 'UNBAN_USER', '✅ Send User Telegram ID to UNBAN, or /cancel:');
promptStep('admin_prompt_broadcast', 'BROADCAST', '📢 Send/forward message to BROADCAST, or /cancel:');
promptStep('admin_prompt_broadcast_pin', 'BROADCAST_PIN', '📌 Send/forward message to BROADCAST & PIN, or /cancel:');

bot.action('admin_clean_queue', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const s: any = await AppSettings.findOne({ key: 'global' }).lean();
  const allowed = String(s?.allowedLanguages || 'hi,en,ta,te,ml,kn').split(',').map((x: string) => x.trim().toLowerCase()).filter(Boolean);
  const res = await MediaItem.deleteMany({ isPublished: false, $or: [{ originalLanguage: { $nin: allowed } }, { posterPath: '' }] });
  await MonthJob.deleteMany({ status: { $ne: 'COMPLETED' } });
  await ctx.answerCbQuery('Cleaned!');
  return ctx.reply(`🧹 Removed ${res.deletedCount} invalid items from queue.`);
});

bot.action('admin_stop_all', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  await AppSettings.updateOne({ key: 'global' }, { $set: { autoSeedingEnabled: false, autoPublishEnabled: false, aiEnabled: false } }, { upsert: true });
  await ctx.answerCbQuery('Emergency Stop Activated');
  return renderAdminPanel(ctx, true);
});

bot.command('status', async (ctx) => {
  const [pend, postedHistoryCount, prio, job, s]: any = await Promise.all([
    MediaItem.countDocuments({ isPublished: false }),
    PostedHistory.countDocuments(),
    MediaItem.countDocuments({ isPublished: false, userRequested: true }),
    MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({ month: -1 }).lean(),
    AppSettings.findOne({ key: 'global' }).lean()
  ]);
  return ctx.replyWithHTML(
    `📊 <b>Status:</b>\n🌱 Seeding: ${s?.autoSeedingEnabled ? 'ON' : 'OFF'}\n📤 Publish: ${s?.autoPublishEnabled ? 'ON' : 'OFF'} (${s?.postsPerBatch || 10} Posts / ${s?.publishIntervalMinutes || 5}m)\n📅 Month: ${job ? `${job.month} P${job.currentPage}/${job.totalPages}` : 'Idle'}\n✅ Posted: ${postedHistoryCount} | ⏳ Queue: ${pend} (🔥 Priority: ${prio})`
  );
});

bot.command('latest', async (ctx) => {
  const items: any = await MediaItem.find().select('_id title releaseDate').sort({ releaseDate: -1 }).limit(10).lean();
  if (!items || items.length === 0) return ctx.reply('No titles yet.');
  const buttons: any[] = items.map((item: any, i: number) => [
    Markup.button.callback(`${i + 1}. 🎬 ${item.title} (${item.releaseDate ? String(item.releaseDate).substring(0, 4) : 'N/A'})`, `view_${item._id}`)
  ]);
  return ctx.replyWithHTML('🆕 <b>Latest Titles:</b>', Markup.inlineKeyboard(buttons));
});

const enrichItemFull = async (item: any): Promise<any> => {
  if (!item.runtime || !item.overview || !Array.isArray(item.availableLanguages) || item.availableLanguages.length === 0) {
    const d = await fetchTMDBDetails(item.tmdbId, item.mediaType);
    if (d) {
      item.genres = d.genres?.map((g: any) => g.name) || item.genres;
      item.runtime = d.runtime || (d.episode_run_time ? d.episode_run_time[0] : 0) || item.runtime || 0;
      item.seasonCount = d.number_of_seasons || item.seasonCount || 0;
      item.episodeCount = d.number_of_episodes || item.episodeCount || 0;
      item.imdbId = d.external_ids?.imdb_id || d.imdb_id || item.imdbId || '';
      item.availableLanguages = extractAvailableLanguages(d, item.originalLanguage);
    }
    item = await enrichWithAI(item);
    await item.save();
  }
  return item;
};

bot.action(/^view_(.+)$/, async (ctx) => {
  try {
    let item: any = await MediaItem.findById(ctx.match[1]);
    if (!item) return ctx.answerCbQuery('Not found or already published');
    await ctx.answerCbQuery('Loading details...');
    item = await enrichItemFull(item);
    return sendMediaCardToChat(ctx, item);
  } catch (_e) {
    return ctx.answerCbQuery('Error');
  }
});

const saveTMDBHitsToDB = async (hits: any[]) => {
  for (const hit of hits.slice(0, 5)) {
    const mediaType: 'movie' | 'tv' = hit.media_type === 'tv' ? 'tv' : 'movie';
    const alreadyDone = await PostedHistory.findOne({ tmdbId: hit.id, mediaType }).lean();
    if (alreadyDone) continue;

    const d = await fetchTMDBDetails(hit.id, mediaType);
    const availLangs = extractAvailableLanguages(d, hit.original_language);
    await MediaItem.findOneAndUpdate(
      { tmdbId: hit.id, mediaType },
      {
        $set: {
          title: hit.title || hit.name || 'Untitled',
          originalLanguage: hit.original_language || '',
          availableLanguages: availLangs,
          genres: d?.genres?.map((g: any) => g.name) || mapGenreIds(hit.genre_ids || []),
          overview: hit.overview || d?.overview || '',
          posterPath: hit.poster_path || d?.poster_path || '',
          releaseDate: hit.release_date || hit.first_air_date || '',
          tmdbRating: hit.vote_average || 0,
          voteCount: hit.vote_count || 0,
          runtime: d?.runtime || (d?.episode_run_time ? d.episode_run_time[0] : 0) || 0,
          seasonCount: d?.number_of_seasons || 0,
          episodeCount: d?.number_of_episodes || 0,
          imdbId: d?.external_ids?.imdb_id || d?.imdb_id || ''
        }
      },
      { upsert: true }
    );
  }
};

const handleTitleSearch = async (ctx: any, rawQuery: string) => {
  const cleanQuery = rawQuery.replace(/^\d+\.\s*/, '').replace(/🎬/g, '').replace(/\(\d{4}\)\s*$/, '').trim();
  if (!cleanQuery || cleanQuery.length < 2) {
    return ctx.replyWithHTML('⚠️ <b>Invalid Search!</b> Format: <code>Movie Name</code>');
  }

  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(cleanQuery + ' movie')}`;

  try {
    const escaped = cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let results: any[] = await MediaItem.find({ title: { $regex: escaped, $options: 'i' } })
      .sort({ voteCount: -1, releaseDate: -1 })
      .limit(8);

    let usedFuzzyOrSpellingFix = false;
    let suggestedTitle = '';

    if (results.length === 0) {
      let liveHits = await searchTMDBMulti(cleanQuery);

      if (liveHits.length === 0) {
        usedFuzzyOrSpellingFix = true;
        suggestedTitle = await suggestCorrectTitleWithAI(cleanQuery);
        if (suggestedTitle && suggestedTitle.toLowerCase() !== cleanQuery.toLowerCase()) {
          liveHits = await searchTMDBMulti(suggestedTitle);
        }
      }

      if (liveHits.length > 0) {
        await saveTMDBHitsToDB(liveHits);
      }

      results = await MediaItem.find({ title: { $regex: escaped, $options: 'i' } })
        .sort({ voteCount: -1, releaseDate: -1 })
        .limit(8);

      if (results.length === 0) {
        usedFuzzyOrSpellingFix = true;
        const candidates: any = await MediaItem.find()
          .select('_id title releaseDate isPublished')
          .sort({ updatedAt: -1 })
          .limit(300)
          .lean();

        const scored = (candidates || [])
          .map((item: any) => ({
            item,
            score: Math.max(
              calcSimilarity(cleanQuery, item.title || ''),
              suggestedTitle ? calcSimilarity(suggestedTitle, item.title || '') : 0
            )
          }))
          .filter((entry: any) => entry.score >= 0.45)
          .sort((a: any, b: any) => b.score - a.score)
          .slice(0, 6);

        results = scored.map((s: any) => s.item);
      }
    }

    if (results.length === 0) {
      return ctx.replyWithHTML(
        `❌ <b>No match found for "${escapeHtml(cleanQuery)}"</b>\n\n` +
          `👇 <i>Check exact spelling on Google and paste it back here:</i>`,
        Markup.inlineKeyboard([[Markup.button.url(`🔎 Check "${cleanQuery}" on Google`, googleUrl)]])
      );
    }

    if (results.length === 1 && !usedFuzzyOrSpellingFix) {
      const fullItem = await MediaItem.findById(results[0]._id);
      if (fullItem) {
        await enrichItemFull(fullItem);
        return sendMediaCardToChat(ctx, fullItem);
      }
    }

    const buttons: any[] = results.map((item: any) => {
      const year = item.releaseDate ? String(item.releaseDate).substring(0, 4) : 'N/A';
      const statusIcon = item.isPublished ? '✅' : '⏳';
      return [Markup.button.callback(`${statusIcon} 🎬 ${item.title} (${year})`, `view_${item._id}`)];
    });
    buttons.push([Markup.button.url(`🔎 Not here? Check "${cleanQuery}" on Google`, googleUrl)]);

    const headerText = usedFuzzyOrSpellingFix
      ? `⚠️ <b>Closest matches for "${escapeHtml(cleanQuery)}":</b>`
      : `🔎 <b>Search Results for "${escapeHtml(cleanQuery)}":</b>`;

    return ctx.replyWithHTML(headerText, Markup.inlineKeyboard(buttons));
  } catch (_e) {
    return ctx.reply('Search error. Please try again.');
  }
};

bot.command('search', async (ctx) => {
  const q = ctx.message.text.replace(/^\/search(@\w+)?/i, '').trim();
  return handleTitleSearch(ctx, q);
});

bot.on('message', async (ctx: any) => {
  const uid = ctx.from?.id;
  const step = uid && isAdmin(uid) ? await getAdminStep(uid) : '';

  if (step && isAdmin(uid)) {
    await clearAdminStep(uid);

    if (step === 'BROADCAST' || step === 'BROADCAST_PIN') {
      const pin = step === 'BROADCAST_PIN';
      const userList: any = await BotUser.find({ isBanned: { $ne: true } }).select('telegramId').lean();
      let sent = 0, pinned = 0, failed = 0;
      await ctx.reply(`⏳ Broadcasting to ${userList.length} users...`);
      for (const u of userList) {
        try {
          const cp: any = await ctx.telegram.copyMessage(u.telegramId, ctx.chat.id, ctx.message.message_id);
          sent++;
          if (pin && cp?.message_id) {
            try {
              await ctx.telegram.pinChatMessage(u.telegramId, cp.message_id, { disable_notification: false });
              pinned++;
            } catch (_pe) {}
          }
        } catch (_e) {
          failed++;
        }
      }
      return ctx.replyWithHTML(`✅ <b>Broadcast Done!</b>\n📤 Sent: ${sent} | 📌 Pinned: ${pinned} | ❌ Failed: ${failed}`);
    }

    const t = (ctx.message?.text || '').trim();
    if (!t) return ctx.reply('Cancelled. Send /admin.');
    if (step === 'LINK_C1') await AppSettings.updateOne({ key: 'global' }, { $set: { channel01Url: t } }, { upsert: true });
    else if (step === 'LINK_C2') await AppSettings.updateOne({ key: 'global' }, { $set: { channel02Url: t } }, { upsert: true });
    else if (step === 'LINK_PREM') await AppSettings.updateOne({ key: 'global' }, { $set: { premiumUrl: t } }, { upsert: true });
    else if (step === 'LINK_ADULT') await AppSettings.updateOne({ key: 'global' }, { $set: { adultContentUrl: t } }, { upsert: true });
    else if (step === 'SET_RATING') await AppSettings.updateOne({ key: 'global' }, { $set: { ourRating: t } }, { upsert: true });
    else if (step === 'SET_TIME') await AppSettings.updateOne({ key: 'global' }, { $set: { publishIntervalMinutes: Math.max(1, Number(t) || 5) } }, { upsert: true });
    else if (step === 'BAN_USER' && Number(t)) await BotUser.findOneAndUpdate({ telegramId: Number(t) }, { $set: { isBanned: true } }, { upsert: true });
    else if (step === 'UNBAN_USER' && Number(t)) await BotUser.findOneAndUpdate({ telegramId: Number(t) }, { $set: { isBanned: false } }, { upsert: true });

    await ctx.reply('✅ Updated successfully!');
    return renderAdminPanel(ctx, false);
  }

  const text = (ctx.message?.text || '').trim();
  if (!text || text.startsWith('/')) return;
  return handleTitleSearch(ctx, text);
});

bot.catch((err: any, ctx: any) => {
  console.warn(`⚠️ Telegram Error (${ctx?.updateType || 'update'}):`, err?.message || err);
});

export const handleWebhookUpdate = async (body: any) => {
  await ensureDbConnected();
  await bot.handleUpdate(body);
};

const startApp = async () => {
  const PORT = Number(process.env.PORT || 10000);
  http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Movie Bot Alive!');
  }).listen(PORT, '0.0.0.0', () => console.log(`✅ Listening on ${PORT}`));

  await ensureDbConnected();
  await AppSettings.updateOne(
    { key: 'global' },
    { $setOnInsert: { autoPublishEnabled: true, autoSeedingEnabled: true, publishIntervalMinutes: 5, postsPerBatch: 10 } },
    { upsert: true }
  );

  if (process.env.DISABLE_INTERNAL_CRON !== 'true') {
    startCronJobs();
  }
  await bot.launch({ dropPendingUpdates: true });
  console.log('✅ Bot polling started.');
};

if (require.main === module) {
  startApp().catch((err) => console.error('❌ Startup Error:', err));
  process.once('SIGINT', () => { try { bot.stop('SIGINT'); } catch (_e) {} process.exit(0); });
  process.once('SIGTERM', () => { try { bot.stop('SIGTERM'); } catch (_e) {} process.exit(0); });
}
