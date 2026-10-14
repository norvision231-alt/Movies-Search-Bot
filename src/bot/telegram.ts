import { Telegraf, Markup } from 'telegraf';
import { MediaItem, MonthJob, AppSettings, BotUser } from '../database/models';
import { searchTMDBMulti, fetchTMDBDetails, mapGenreIds, enrichWithAI } from '../services/tmdb';

const token = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!token) throw new Error('BOT_TOKEN is missing');

export const bot = new Telegraf(token);

let triggerWorkerNow: (() => Promise<void>) | null = null;
export const registerWorkerTrigger = (fn: () => Promise<void>) => {
  triggerWorkerNow = fn;
};

// Track interactive admin prompts (Set Links, Broadcast, Ban/Unban, Set Time)
const adminSession = new Map<number, { step: string }>();

export const getTargetChannel = (): string => {
  return (process.env.LOG_CHANNEL || process.env.TELEGRAM_MAIN_CHANNEL_ID || '').trim();
};

export const getAdminIds = (): string[] => {
  const adminEnv = (process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_IDS || '').trim();
  return adminEnv.split(',').map((id: string) => id.trim()).filter(Boolean);
};

export const isAdmin = (userId?: number): boolean => {
  if (!userId) return false;
  return getAdminIds().includes(String(userId));
};

export const escapeHtml = (unsafe: string = ''): string => {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

const LANGUAGE_NAMES: Record<string, string> = {
  hi: 'Hindi',
  en: 'English',
  ta: 'Tamil',
  te: 'Telugu',
  ml: 'Malayalam',
  kn: 'Kannada',
  bn: 'Bengali',
  mr: 'Marathi',
  pa: 'Punjabi',
  gu: 'Gujarati',
  ur: 'Urdu',
  ko: 'Korean',
  ja: 'Japanese',
  zh: 'Chinese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  ru: 'Russian',
  pt: 'Portuguese',
  tr: 'Turkish',
  th: 'Thai',
  id: 'Indonesian',
  su: 'Sundanese',
  tl: 'Tagalog',
  ar: 'Arabic',
  fa: 'Persian'
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
  const langTag = langName.split(' ')[0].replace(/[^a-zA-Z]/g, '');
  const genreTags = Array.isArray(media.genres)
    ? media.genres
        .slice(0, 3)
        .map((g: string) => `#${String(g).replace(/[^a-zA-Z0-9]/g, '')}`)
        .join(' ')
    : '';

  return [
    cleanTitle ? `#${cleanTitle}` : '',
    year ? `#Release${year}` : '',
    langTag ? `#${langTag}` : '',
    typeTag,
    genreTags,
    '#HDMovies #WatchOnline'
  ]
    .filter(Boolean)
    .join(' ');
};

// EXACT ENGLISH POST FORMAT AS REQUESTED
export const formatCaption = (media: any, settings: any): string => {
  const title = escapeHtml(media.title || 'Untitled');
  const year = media.releaseDate ? escapeHtml(String(media.releaseDate).substring(0, 4)) : 'N/A';
  const langCode = String(media.originalLanguage || '').toLowerCase();
  const langDisplay =
    LANGUAGE_NAMES[langCode] ||
    (Array.isArray(media.spokenLanguages) && media.spokenLanguages.length > 0
      ? media.spokenLanguages.join(', ')
      : String(media.originalLanguage || 'English').toUpperCase());

  const genres =
    Array.isArray(media.genres) && media.genres.length > 0
      ? escapeHtml(media.genres.join(', '))
      : 'Drama, Action';

  const tmdbRating =
    media.tmdbRating && Number(media.tmdbRating) > 0
      ? `${Number(media.tmdbRating).toFixed(1)}/10`
      : 'New Release';

  const rawOverview = media.overview ? String(media.overview).trim() : '';
  const fallbackDesc = `Watch ${media.title} (${year}), an engaging ${genres.toLowerCase()} ${
    media.mediaType === 'tv' ? 'web series' : 'movie'
  } in ${langDisplay} with high-definition quality.`;
  const descSource = rawOverview.length > 15 ? rawOverview : fallbackDesc;
  const shortOverview =
    descSource.length > 260
      ? `${escapeHtml(descSource.substring(0, 257))}...`
      : escapeHtml(descSource);

  const channel01Url = settings?.channel01Url || 'https://t.me/yourchannel1';
  const channel02Url = settings?.channel02Url || 'https://t.me/yourchannel2';
  const premiumUrl = settings?.premiumUrl || channel01Url;
  const adultUrl = settings?.adultContentUrl || channel02Url;
  const ourRating = String(settings?.ourRating || '4.7/5').trim();

  const lines: string[] = [`🔥 <b>${title}</b> (${year})`];

  if (media.imdbRating) {
    lines.push(`⭐ <b>IMDb:</b> ${escapeHtml(String(media.imdbRating))}`);
  } else if (media.imdbId) {
    lines.push(
      `⭐ <b>IMDb:</b> <a href="https://www.imdb.com/title/${escapeHtml(media.imdbId)}/">Verified on IMDb</a>`
    );
  }

  if (media.rtRating) {
    lines.push(`🍅 <b>RT Audience:</b> ${escapeHtml(String(media.rtRating))}`);
  }

  lines.push(
    `🌐 <b>Language:</b> ${escapeHtml(langDisplay)}`,
    `🎭 <b>Genre:</b> ${genres}`
  );

  if (media.mediaType === 'tv' && media.seasonCount && Number(media.seasonCount) > 0) {
    const epInfo = media.episodeCount ? ` (${media.episodeCount} Episodes)` : '';
    lines.push(`📺 <b>Seasons:</b> ${escapeHtml(String(media.seasonCount))}${escapeHtml(epInfo)}`);
  }

  if (media.runtime && Number(media.runtime) > 0) {
    lines.push(`⏱️ <b>Runtime:</b> ${escapeHtml(String(media.runtime))} min`);
  }

  lines.push(`⭐ <b>TMDB Rating:</b> ${escapeHtml(tmdbRating)}`);

  if (ourRating) {
    lines.push(`🔥 <b>Our Rating:</b> ${escapeHtml(ourRating)}`);
  }

  lines.push(
    '',
    shortOverview,
    '━━━━━━━━━━━━━━',
    `🔗 <b>JOIN CHANNEL 01:</b> 👉 <a href="${escapeHtml(channel01Url)}">JOIN NOW</a>`,
    `🔗 <b>JOIN CHANNEL 02:</b> 👉 <a href="${escapeHtml(channel02Url)}">JOIN NOW</a>`,
    `💎 <a href="${escapeHtml(premiumUrl)}"><b>JOIN PREMIUM CONTENT</b></a>`,
    '━━━━━━━━━━━━━━',
    `🔞 <a href="${escapeHtml(adultUrl)}"><b>18+ CONTENT ONLY</b></a>`,
    '⚠️ Adults only where applicable. Viewer discretion advised.',
    '',
    escapeHtml(createSeoHashtags(media, langDisplay))
  );

  return lines.join('\n');
};

export const buildPostKeyboard = (settings: any) => {
  const c1 = settings?.channel01Url || 'https://t.me/yourchannel1';
  const c2 = settings?.channel02Url || 'https://t.me/yourchannel2';
  const prem = settings?.premiumUrl || c1;
  const adult = settings?.adultContentUrl || c2;

  return Markup.inlineKeyboard([
    [
      Markup.button.url('🔗 JOIN CHANNEL 01', c1),
      Markup.button.url('🔗 JOIN CHANNEL 02', c2)
    ],
    [Markup.button.url('💎 JOIN PREMIUM CONTENT', prem)],
    [Markup.button.url('🔞 18+ CONTENT ONLY', adult)]
  ]);
};

export const sendToLogChannel = async (message: string): Promise<void> => {
  const targetChannel = getTargetChannel();
  if (!targetChannel) return;

  try {
    await bot.telegram.sendMessage(targetChannel, message, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Failed to send message to log channel:', error);
  }
};

// Direct Error Alert to Admin DM with Fix Suggestion
export const notifyAdminError = async (source: string, error: any, fixHint: string = '') => {
  const errMsg = escapeHtml(error?.response?.data?.description || error?.message || String(error));
  const hint = fixHint || 'Auto-recovery is active. Use /admin to retry or inspect settings.';
  const alertHtml =
    `🚨 <b>SYSTEM ERROR ALERT [${escapeHtml(source)}]</b>\n\n` +
    `❌ <b>Error:</b> <code>${errMsg}</code>\n` +
    `🛠️ <b>How to Solve:</b> ${escapeHtml(hint)}`;

  const admins = getAdminIds();
  for (const adminId of admins) {
    try {
      await bot.telegram.sendMessage(adminId, alertHtml, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('⚡ Retry Worker Now', 'admin_run_now'),
            Markup.button.callback('⚙️ Open Admin Panel', 'admin_home')
          ]
        ])
      });
    } catch (_e) {
      // Ignore if admin hasn't started private chat yet
    }
  }
};

// Middleware: Save User & Check Ban Status
bot.use(async (ctx, next) => {
  if (ctx.from && ctx.chat?.type === 'private') {
    try {
      const user: any = await BotUser.findOneAndUpdate(
        { telegramId: ctx.from.id },
        {
          $set: {
            firstName: ctx.from.first_name || '',
            username: ctx.from.username || ''
          }
        },
        { upsert: true, new: true }
      );

      if (user?.isBanned && !isAdmin(ctx.from.id)) {
        return ctx.reply('🚫 You are banned from using this bot.');
      }
    } catch (_e) {
      // Continue even if user tracking fails
    }
  }
  return next();
});

export const sendMediaCardToChat = async (ctx: any, item: any) => {
  let settings: any = await AppSettings.findOne({ key: 'global' });
  if (!settings) settings = await AppSettings.create({ key: 'global' });

  const caption = formatCaption(item, settings);
  const keyboard = buildPostKeyboard(settings);
  const posterUrl = item.posterPath
    ? `https://image.tmdb.org/t/p/w500${item.posterPath}`
    : null;

  if (posterUrl) {
    return ctx.replyWithPhoto(posterUrl, {
      caption,
      parse_mode: 'HTML',
      ...keyboard
    });
  }
  return ctx.replyWithHTML(caption, keyboard);
};

// Render Master Admin Panel in Bot
const renderAdminPanel = async (ctx: any, edit: boolean = false) => {
  let settings: any = await AppSettings.findOne({ key: 'global' });
  if (!settings) settings = await AppSettings.create({ key: 'global' });

  const total = await MediaItem.countDocuments();
  const published = await MediaItem.countDocuments({ isPublished: true });
  const pending = await MediaItem.countDocuments({ isPublished: false });
  const totalUsers = await BotUser.countDocuments();
  const bannedUsers = await BotUser.countDocuments({ isBanned: true });
  const activeJob: any = await MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({ month: -1 });
  const interval = settings.publishIntervalMinutes || 20;

  const text =
    `👑 <b>MASTER ADMIN CONTROL PANEL</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🌱 <b>Auto Seeding:</b> ${settings.autoSeedingEnabled ? '🟢 RUNNING' : '🔴 PAUSED'}\n` +
    `📤 <b>Auto Publishing:</b> ${settings.autoPublishEnabled ? '🟢 RUNNING' : '🔴 PAUSED'}\n` +
    `🤖 <b>AI Fallback (GPT/DeepSeek):</b> ${settings.aiEnabled !== false ? '🟢 ACTIVE' : '🔴 OFF'}\n` +
    `⏱️ <b>Auto-Post Interval:</b> Every <code>${interval} mins</code>\n` +
    `📅 <b>Active Month:</b> <code>${
      activeJob ? `${activeJob.month} (${activeJob.mediaType.toUpperCase()} P${activeJob.currentPage}/${activeJob.totalPages})` : 'Idle'
    }</code>\n` +
    `🌐 <b>Languages:</b> <code>${escapeHtml(settings.allowedLanguages || 'hi,en,ta,te,ml,kn')}</code>\n` +
    `⭐ <b>Our Rating:</b> <code>${escapeHtml(settings.ourRating || '4.7/5')}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎬 <b>Database:</b> ${total} Titles | ✅ <b>Posted:</b> ${published} | ⏳ <b>Queue:</b> ${pending}\n` +
    `👥 <b>Bot Users:</b> ${totalUsers} | 🚫 <b>Banned:</b> ${bannedUsers}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Select an action below to configure your bot:</i>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        settings.autoPublishEnabled ? '⏸️ Stop Auto-Post' : '▶️ Start Auto-Post',
        'admin_toggle_pub'
      ),
      Markup.button.callback(
        settings.autoSeedingEnabled ? '⏸️ Stop Seeding' : '▶️ Start Seeding',
        'admin_toggle_seed'
      )
    ],
    [
      Markup.button.callback('⚡ Post 1 Movie Now', 'admin_run_now'),
      Markup.button.callback(`⏱️ Set Post Time (${interval}m)`, 'admin_menu_time')
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
      Markup.button.callback(
        settings.aiEnabled !== false ? '🤖 Disable AI' : '🤖 Enable AI',
        'admin_toggle_ai'
      ),
      Markup.button.callback('🧹 Clean Invalid Queue', 'admin_clean_queue')
    ],
    [
      Markup.button.callback('🔄 Refresh Panel', 'admin_home'),
      Markup.button.callback('🛑 Emergency Stop All', 'admin_stop_all')
    ]
  ]);

  if (edit && ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch (_e) {
      return ctx.replyWithHTML(text, keyboard);
    }
  }
  return ctx.replyWithHTML(text, keyboard);
};

// Commands
bot.start((ctx) => {
  ctx.replyWithHTML(
    '🎬 <b>Welcome to the Automated Movie & Web-Series Bot!</b>\n\n' +
      '🔎 Send any movie or web-series title directly (e.g., <code>Kingsman</code>, <code>Inception</code>) or use <code>/search TITLE</code>.\n' +
      '🆕 Use <code>/latest</code> to browse recently added titles.\n' +
      '👑 Admins can use <code>/admin</code> to open the Master Control Panel.'
  );
});

bot.help((ctx) => {
  ctx.replyWithHTML(
    '📌 <b>Bot Commands (English):</b>\n\n' +
      '• Send any Movie/Series name to search directly\n' +
      '• <code>/search &lt;title&gt;</code> - Search movie or series\n' +
      '• <code>/latest</code> - View 10 latest releases\n' +
      '• <code>/status</code> - View live database & queue status\n' +
      '• <code>/admin</code> - Open Master Admin Panel (Admin only)\n' +
      '• <code>/ban &lt;user_id&gt;</code> - Ban a user (Admin only)\n' +
      '• <code>/unban &lt;user_id&gt;</code> - Unban a user (Admin only)'
  );
});

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.reply(
      `⛔ Access Denied. Your Telegram ID is ${ctx.from?.id}. Add it to ADMIN_ID in Render Environment Variables.`
    );
  }
  adminSession.delete(ctx.from.id);
  return renderAdminPanel(ctx, false);
});

bot.command('cancel', async (ctx) => {
  if (ctx.from) adminSession.delete(ctx.from.id);
  return ctx.reply('✅ Current admin action cancelled. Send /admin to open the panel.');
});

bot.command('ban', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ Admin only.');
  const targetId = Number(ctx.message.text.split(/\s+/)[1]);
  if (!targetId) return ctx.reply('Usage: /ban <Telegram_User_ID>');
  await BotUser.findOneAndUpdate({ telegramId: targetId }, { $set: { isBanned: true } }, { upsert: true });
  return ctx.reply(`🚫 User ${targetId} has been BANNED.`);
});

bot.command('unban', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ Admin only.');
  const targetId = Number(ctx.message.text.split(/\s+/)[1]);
  if (!targetId) return ctx.reply('Usage: /unban <Telegram_User_ID>');
  await BotUser.findOneAndUpdate({ telegramId: targetId }, { $set: { isBanned: false } }, { upsert: true });
  return ctx.reply(`✅ User ${targetId} has been UNBANNED.`);
});

// Master Admin Callback Actions
bot.action('admin_home', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  adminSession.delete(ctx.from.id);
  await ctx.answerCbQuery('Refreshed');
  return renderAdminPanel(ctx, true);
});

bot.action('admin_toggle_seed', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const settings: any = await AppSettings.findOne({ key: 'global' });
  const nextState = !(settings?.autoSeedingEnabled ?? true);
  await AppSettings.updateOne({ key: 'global' }, { $set: { autoSeedingEnabled: nextState } }, { upsert: true });
  await ctx.answerCbQuery(`Auto Seeding: ${nextState ? 'RUNNING' : 'PAUSED'}`);
  return renderAdminPanel(ctx, true);
});

bot.action('admin_toggle_pub', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const settings: any = await AppSettings.findOne({ key: 'global' });
  const nextState = !(settings?.autoPublishEnabled ?? true);
  await AppSettings.updateOne({ key: 'global' }, { $set: { autoPublishEnabled: nextState } }, { upsert: true });
  await ctx.answerCbQuery(`Auto Publishing: ${nextState ? 'RUNNING' : 'PAUSED'}`);
  return renderAdminPanel(ctx, true);
});

bot.action('admin_toggle_ai', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const settings: any = await AppSettings.findOne({ key: 'global' });
  const nextState = !(settings?.aiEnabled ?? true);
  await AppSettings.updateOne({ key: 'global' }, { $set: { aiEnabled: nextState } }, { upsert: true });
  await ctx.answerCbQuery(`AI Fallback: ${nextState ? 'ACTIVE' : 'OFF'}`);
  return renderAdminPanel(ctx, true);
});

bot.action('admin_run_now', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  await ctx.answerCbQuery('Running Seeder & Publisher now...');
  if (triggerWorkerNow) {
    triggerWorkerNow().catch((e) => console.error(e));
  }
  return ctx.reply('⚡ Triggered immediate Seeding & Publishing cycle! Check your channel in a few seconds.');
});

bot.action('admin_menu_time', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    '⏱️ <b>SET AUTO-POSTING TIME INTERVAL</b>\n\nSelect how often the bot should automatically publish movies to your channel:',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('Every 5 Mins', 'admin_set_time_5'),
          Markup.button.callback('Every 10 Mins', 'admin_set_time_10'),
          Markup.button.callback('Every 15 Mins', 'admin_set_time_15')
        ],
        [
          Markup.button.callback('Every 20 Mins', 'admin_set_time_20'),
          Markup.button.callback('Every 30 Mins', 'admin_set_time_30'),
          Markup.button.callback('Every 60 Mins', 'admin_set_time_60')
        ],
        [Markup.button.callback('✏️ Type Custom Minutes', 'admin_prompt_time')],
        [Markup.button.callback('⬅️ Back to Admin Panel', 'admin_home')]
      ])
    }
  );
});

bot.action(/^admin_set_time_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const mins = Math.max(1, Number(ctx.match[1]));
  await AppSettings.updateOne({ key: 'global' }, { $set: { publishIntervalMinutes: mins } }, { upsert: true });
  await ctx.answerCbQuery(`Interval set to ${mins} minutes!`);
  return renderAdminPanel(ctx, true);
});

bot.action('admin_prompt_time', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  adminSession.set(ctx.from.id, { step: 'SET_TIME' });
  await ctx.answerCbQuery();
  return ctx.reply('⏱️ Send the auto-posting interval in minutes (e.g. 12), or /cancel:');
});

bot.action('admin_menu_links', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const settings: any = await AppSettings.findOne({ key: 'global' });
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    `🔗 <b>CONFIGURE CHANNEL LINKS</b>\n\n` +
      `1️⃣ <b>Channel 01:</b> ${escapeHtml(settings?.channel01Url || '')}\n` +
      `2️⃣ <b>Channel 02:</b> ${escapeHtml(settings?.channel02Url || '')}\n` +
      `💎 <b>Premium:</b> ${escapeHtml(settings?.premiumUrl || '')}\n` +
      `🔞 <b>18+ Adult:</b> ${escapeHtml(settings?.adultContentUrl || '')}\n\n` +
      `Click a button below to update that link:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✏️ Set Channel 01', 'admin_link_c1'),
          Markup.button.callback('✏️ Set Channel 02', 'admin_link_c2')
        ],
        [
          Markup.button.callback('💎 Set Premium URL', 'admin_link_prem'),
          Markup.button.callback('🔞 Set 18+ URL', 'admin_link_adult')
        ],
        [Markup.button.callback('⬅️ Back to Admin Panel', 'admin_home')]
      ])
    }
  );
});

bot.action('admin_link_c1', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  adminSession.set(ctx.from.id, { step: 'LINK_C1' });
  await ctx.answerCbQuery();
  return ctx.reply('🔗 Send the new URL for CHANNEL 01 (e.g. https://t.me/mychannel), or /cancel:');
});

bot.action('admin_link_c2', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  adminSession.set(ctx.from.id, { step: 'LINK_C2' });
  await ctx.answerCbQuery();
  return ctx.reply('🔗 Send the new URL for CHANNEL 02, or /cancel:');
});

bot.action('admin_link_prem', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  adminSession.set(ctx.from.id, { step: 'LINK_PREM' });
  await ctx.answerCbQuery();
  return ctx.reply('💎 Send the new URL for PREMIUM CONTENT, or /cancel:');
});

bot.action('admin_link_adult', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  adminSession.set(ctx.from.id, { step: 'LINK_ADULT' });
  await ctx.answerCbQuery();
  return ctx.reply('🔞 Send the new URL for 18+ CONTENT, or /cancel:');
});

bot.action('admin_prompt_rating', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  adminSession.set(ctx.from.id, { step: 'SET_RATING' });
  await ctx.answerCbQuery();
  return ctx.reply('⭐ Send the new "Our Rating" value (e.g. 4.8/5), or /cancel:');
});

bot.action('admin_prompt_ban', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  adminSession.set(ctx.from.id, { step: 'BAN_USER' });
  await ctx.answerCbQuery();
  return ctx.reply('🚫 Send the Telegram User ID to BAN, or /cancel:');
});

bot.action('admin_prompt_unban', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  adminSession.set(ctx.from.id, { step: 'UNBAN_USER' });
  await ctx.answerCbQuery();
  return ctx.reply('✅ Send the Telegram User ID to UNBAN, or /cancel:');
});

bot.action('admin_prompt_broadcast', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  adminSession.set(ctx.from.id, { step: 'BROADCAST' });
  await ctx.answerCbQuery();
  return ctx.reply(
    '📢 Send or forward any message (Text, Photo, Video, Sticker) to BROADCAST to all users, or /cancel:'
  );
});

bot.action('admin_prompt_broadcast_pin', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  adminSession.set(ctx.from.id, { step: 'BROADCAST_PIN' });
  await ctx.answerCbQuery();
  return ctx.reply(
    '📌 Send or forward any message to BROADCAST AND PIN in all user chats, or /cancel:'
  );
});

bot.action('admin_clean_queue', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const settings: any = await AppSettings.findOne({ key: 'global' });
  const allowed = String(settings?.allowedLanguages || 'hi,en,ta,te,ml,kn')
    .split(',')
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean);

  const res = await MediaItem.deleteMany({
    isPublished: false,
    $or: [{ originalLanguage: {$nin: allowed } }, { posterPath: '' }]
  });
  await MonthJob.deleteMany({ status: { $ne: 'COMPLETED' } });
  await ctx.answerCbQuery('Queue cleaned!');
  return ctx.reply(
    `🧹 Removed ${res.deletedCount} non-priority/incomplete items from queue and reset active crawler filter.`
  );
});

bot.action('admin_stop_all', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  await AppSettings.updateOne(
    { key: 'global' },
    { $set: { autoSeedingEnabled: false, autoPublishEnabled: false, aiEnabled: false } },
    { upsert: true }
  );
  await ctx.answerCbQuery('Emergency Stop Activated');
  return renderAdminPanel(ctx, true);
});

bot.command('status', async (ctx) => {
  const totalMovies = await MediaItem.countDocuments();
  const publishedCount = await MediaItem.countDocuments({ isPublished: true });
  const pendingCount = await MediaItem.countDocuments({ isPublished: false });
  const activeJob: any = await MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({ month: -1 });
  const settings: any = await AppSettings.findOne({ key: 'global' });

  return ctx.replyWithHTML(
    `📊 <b>Bot & Database Status:</b>\n\n` +
      `🌱 <b>Auto Seeding:</b> ${settings?.autoSeedingEnabled ? '✅ ON' : '⏸️ OFF'}\n` +
      `📤 <b>Auto Publishing:</b> ${settings?.autoPublishEnabled ? '✅ ON' : '⏸️ OFF'}\n` +
      `⏱️ <b>Interval:</b> Every ${settings?.publishIntervalMinutes || 20} mins\n` +
      `📅 <b>Active Month:</b> ${
        activeJob
          ? `${activeJob.month} [${String(activeJob.mediaType).toUpperCase()}] (Page ${activeJob.currentPage}/${activeJob
