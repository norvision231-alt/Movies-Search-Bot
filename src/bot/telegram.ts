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

const adminSession = new Map<number, { step: string }>();

export const getTargetChannel = (): string => {
  return (process.env.LOG_CHANNEL || process.env.TELEGRAM_MAIN_CHANNEL_ID || '').trim();
};

export const getAdminIds = (): string[] => {
  const raw = (process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_IDS || '').trim();
  return raw.split(',').map((id: string) => id.trim()).filter(Boolean);
};

export const isAdmin = (userId?: number): boolean => {
  return Boolean(userId && getAdminIds().includes(String(userId)));
};

export const escapeHtml = (unsafe: string = ''): string => {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

const LANG_MAP: Record<string, string> = {
  hi: 'Hindi', en: 'English', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada',
  bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi', gu: 'Gujarati', ur: 'Urdu', ko: 'Korean',
  ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  ru: 'Russian', pt: 'Portuguese', tr: 'Turkish', th: 'Thai', id: 'Indonesian', su: 'Sundanese'
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
    ? media.genres.slice(0, 3).map((g: string) => `#${String(g).replace(/[^a-zA-Z0-9]/g, '')}`).join(' ')
    : '';
  return [cleanTitle ? `#${cleanTitle}` : '', year ? `#Release${year}` : '', langTag ? `#${langTag}` : '', typeTag, genreTags, '#HDMovies'].filter(Boolean).join(' ');
};

export const formatCaption = (media: any, settings: any): string => {
  const title = escapeHtml(media.title || 'Untitled');
  const year = media.releaseDate ? escapeHtml(String(media.releaseDate).substring(0, 4)) : 'N/A';
  const langCode = String(media.originalLanguage || '').toLowerCase();
  const langDisplay =
    LANG_MAP[langCode] ||
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
  } in ${langDisplay} with HD quality.`;
  const descSource = rawOverview.length > 15 ? rawOverview : fallbackDesc;
  const shortOverview =
    descSource.length > 250 ? `${escapeHtml(descSource.substring(0, 247))}...` : escapeHtml(descSource);

  const c1 = settings?.channel01Url || 'https://t.me/yourchannel1';
  const c2 = settings?.channel02Url || 'https://t.me/yourchannel2';
  const prem = settings?.premiumUrl || c1;
  const adult = settings?.adultContentUrl || c2;
  const ourRating = String(settings?.ourRating || '4.7/5').trim();

  const lines: string[] = [`🔥 <b>${title}</b> (${year})`];
  if (media.imdbRating) {
    lines.push(`⭐ <b>IMDb:</b> ${escapeHtml(String(media.imdbRating))}`);
  } else if (media.imdbId) {
    lines.push(`⭐ <b>IMDb:</b> <a href="https://www.imdb.com/title/${escapeHtml(media.imdbId)}/">Verified on IMDb</a>`);
  }
  if (media.rtRating) {
    lines.push(`🍅 <b>RT Audience:</b> ${escapeHtml(String(media.rtRating))}`);
  }
  lines.push(`🌐 <b>Language:</b> ${escapeHtml(langDisplay)}`, `🎭 <b>Genre:</b> ${genres}`);
  if (media.mediaType === 'tv' && media.seasonCount && Number(media.seasonCount) > 0) {
    const ep = media.episodeCount ? ` (${media.episodeCount} Episodes)` : '';
    lines.push(`📺 <b>Seasons:</b> ${escapeHtml(String(media.seasonCount))}${escapeHtml(ep)}`);
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
    `🔗 <b>JOIN CHANNEL 01:</b> 👉 <a href="${escapeHtml(c1)}">JOIN NOW</a>`,
    `🔗 <b>JOIN CHANNEL 02:</b> 👉 <a href="${escapeHtml(c2)}">JOIN NOW</a>`,
    `💎 <a href="${escapeHtml(prem)}"><b>JOIN PREMIUM CONTENT</b></a>`,
    '━━━━━━━━━━━━━━',
    `🔞 <a href="${escapeHtml(adult)}"><b>18+ CONTENT ONLY</b></a>`,
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
    [Markup.button.url('🔗 JOIN CHANNEL 01', c1), Markup.button.url('🔗 JOIN CHANNEL 02', c2)],
    [Markup.button.url('💎 JOIN PREMIUM CONTENT', prem)],
    [Markup.button.url('🔞 18+ CONTENT ONLY', adult)]
  ]);
};

export const sendToLogChannel = async (message: string): Promise<void> => {
  const target = getTargetChannel();
  if (!target) return;
  try {
    await bot.telegram.sendMessage(target, message, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Log channel error:', e);
  }
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
          [Markup.button.callback('⚡ Retry Now', 'admin_run_now'), Markup.button.callback('⚙️ Admin Panel', 'admin_home')]
        ])
      });
    } catch (_e) {}
  }
};

bot.use(async (ctx, next) => {
  if (ctx.from && ctx.chat?.type === 'private') {
    try {
      const u: any = await BotUser.findOneAndUpdate(
        { telegramId: ctx.from.id },
        { $set: { firstName: ctx.from.first_name || '', username: ctx.from.username || '' } },
        { upsert: true, new: true }
      );
      if (u?.isBanned && !isAdmin(ctx.from.id)) {
        return ctx.reply('🚫 You are banned from using this bot.');
      }
    } catch (_e) {}
  }
  return next();
});

export const sendMediaCardToChat = async (ctx: any, item: any) => {
  let s: any = await AppSettings.findOne({ key: 'global' });
  if (!s) s = await AppSettings.create({ key: 'global' });
  const caption = formatCaption(item, s);
  const keyboard = buildPostKeyboard(s);
  const poster = item.posterPath ? `https://image.tmdb.org/t/p/w500${item.posterPath}` : null;
  if (poster) {
    return ctx.replyWithPhoto(poster, { caption, parse_mode: 'HTML', ...keyboard });
  }
  return ctx.replyWithHTML(caption, keyboard);
};

const renderAdminPanel = async (ctx: any, edit = false) => {
  let s: any = await AppSettings.findOne({ key: 'global' });
  if (!s) s = await AppSettings.create({ key: 'global' });
  const [total, published, pending, totalUsers, bannedUsers, activeJob] = await Promise.all([
    MediaItem.countDocuments(),
    MediaItem.countDocuments({ isPublished: true }),
    MediaItem.countDocuments({ isPublished: false }),
    BotUser.countDocuments(),
    BotUser.countDocuments({ isBanned: true }),
    MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({ month: -1 })
  ]);
  const mins = s.publishIntervalMinutes || 20;

  const text =
    `👑 <b>MASTER ADMIN CONTROL PANEL</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🌱 <b>Auto Seeding:</b> ${s.autoSeedingEnabled ? '🟢 RUNNING' : '🔴 PAUSED'}\n` +
    `📤 <b>Auto Publishing:</b> ${s.autoPublishEnabled ? '🟢 RUNNING' : '🔴 PAUSED'}\n` +
    `🤖 <b>AI Fallback (GPT/DeepSeek):</b> ${s.aiEnabled !== false ? '🟢 ACTIVE' : '🔴 OFF'}\n` +
    `⏱️ <b>Auto-Post Interval:</b> Every <code>${mins} mins</code>\n` +
    `📅 <b>Active Month:</b> <code>${activeJob ? `${activeJob.month} (${String(activeJob.mediaType).toUpperCase()} P${activeJob.currentPage}/${activeJob.totalPages})` : 'Idle'}</code>\n` +
    `⭐ <b>Our Rating:</b> <code>${escapeHtml(s.ourRating || '4.7/5')}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎬 <b>DB:</b> ${total} | ✅ <b>Posted:</b> ${published} | ⏳ <b>Queue:</b> ${pending}\n` +
    `👥 <b>Users:</b> ${totalUsers} | 🚫 <b>Banned:</b> ${bannedUsers}`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(s.autoPublishEnabled ? '⏸️ Stop Auto-Post' : '▶️ Start Auto-Post', 'admin_toggle_pub'),
      Markup.button.callback(s.autoSeedingEnabled ? '⏸️ Stop Seeding' : '▶️ Start Seeding', 'admin_toggle_seed')
    ],
    [
      Markup.button.callback('⚡ Post 1 Movie Now', 'admin_run_now'),
      Markup.button.callback(`⏱️ Set Post Time (${mins}m)`, 'admin_menu_time')
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
      Markup.button.callback('🔄 Refresh Panel', 'admin_home'),
      Markup.button.callback('🛑 Emergency Stop All', 'admin_stop_all')
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
      '🔎 Send any movie or series name directly (e.g., <code>Kingsman</code>, <code>Inception</code>) or use <code>/search TITLE</code>.\n' +
      '🆕 Use <code>/latest</code> for recent releases.\n' +
      '👑 Admins: Send <code>/admin</code> for Master Control Panel.'
  );
});

bot.help((ctx) => {
  ctx.replyWithHTML(
    '📌 <b>Available Commands:</b>\n' +
      '• Send any title to search\n' +
      '• <code>/search &lt;title&gt;</code> - Search by title\n' +
      '• <code>/latest</code> - Latest 10 titles\n' +
      '• <code>/status</code> - Bot & DB status\n' +
      '• <code>/admin</code> - Master Admin Panel'
  );
});

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.reply(`⛔ Access Denied. Your ID: ${ctx.from?.id}. Add it to ADMIN_ID in Render.`);
  }
  adminSession.delete(ctx.from.id);
  return renderAdminPanel(ctx, false);
});

bot.command('cancel', async (ctx) => {
  if (ctx.from) adminSession.delete(ctx.from.id);
  return ctx.reply('✅ Action cancelled. Send /admin to open panel.');
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
  adminSession.delete(ctx.from.id);
  await ctx.answerCbQuery('Refreshed');
  return renderAdminPanel(ctx, true);
});

bot.action('admin_toggle_seed', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const s: any = await AppSettings.findOne({ key: 'global' });
  const next = !(s?.autoSeedingEnabled ?? true);
  await AppSettings.updateOne({ key: 'global' }, { $set: { autoSeedingEnabled: next } }, { upsert: true });
  await ctx.answerCbQuery(`Seeding: ${next ? 'ON' : 'OFF'}`);
  return renderAdminPanel(ctx, true);
});

bot.action('admin_toggle_pub', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const s: any = await AppSettings.findOne({ key: 'global' });
  const next = !(s?.autoPublishEnabled ?? true);
  await AppSettings.updateOne({ key: 'global' }, { $set: { autoPublishEnabled: next } }, { upsert: true });
  await ctx.answerCbQuery(`Publishing: ${next ? 'ON' : 'OFF'}`);
  return renderAdminPanel(ctx, true);
});

bot.action('admin_toggle_ai', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const s: any = await AppSettings.findOne({ key: 'global' });
  const next = !(s?.aiEnabled ?? true);
  await AppSettings.updateOne({ key: 'global' }, { $set: { aiEnabled: next } }, { upsert: true });
  await ctx.answerCbQuery(`AI: ${next ? 'ON' : 'OFF'}`);
  return renderAdminPanel(ctx, true);
});

bot.action('admin_run_now', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  await ctx.answerCbQuery('Running now...');
  if (triggerWorkerNow) triggerWorkerNow().catch((e) => console.error(e));
  return ctx.reply('⚡ Triggered immediate Seeding & Publishing cycle!');
});

bot.action('admin_menu_time', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  await ctx.answerCbQuery();
  return ctx.editMessageText('⏱️ <b>SELECT AUTO-POSTING TIME INTERVAL:</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('5 Mins', 'admin_set_time_5'),
        Markup.button.callback('10 Mins', 'admin_set_time_10'),
        Markup.button.callback('15 Mins', 'admin_set_time_15')
      ],
      [
        Markup.button.callback('20 Mins', 'admin_set_time_20'),
        Markup.button.callback('30 Mins', 'admin_set_time_30'),
        Markup.button.callback('60 Mins', 'admin_set_time_60')
      ],
      [Markup.button.callback('✏️ Custom Minutes', 'admin_prompt_time')],
      [Markup.button.callback('⬅️ Back', 'admin_home')]
    ])
  });
});

bot.action(/^admin_set_time_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const mins = Math.max(1, Number(ctx.match[1]));
  await AppSettings.updateOne({ key: 'global' }, { $set: { publishIntervalMinutes: mins } }, { upsert: true });
  await ctx.answerCbQuery(`Set to ${mins} mins`);
  return renderAdminPanel(ctx, true);
});

bot.action('admin_prompt_time', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  adminSession.set(ctx.from.id, { step: 'SET_TIME' });
  await ctx.answerCbQuery();
  return ctx.reply('⏱️ Send custom interval in minutes (e.g. 12), or /cancel:');
});

bot.action('admin_menu_links', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const s: any = await AppSettings.findOne({ key: 'global' });
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
    adminSession.set(ctx.from.id, { step: stepName });
    await ctx.answerCbQuery();
    return ctx.reply(msg);
  });
};

promptStep('admin_link_c1', 'LINK_C1', '🔗 Send new URL for CHANNEL 01, or /cancel:');
promptStep('admin_link_c2', 'LINK_C2', '🔗 Send new URL for CHANNEL 02, or /cancel:');
promptStep('admin_link_prem', 'LINK_PREM', '💎 Send new URL for PREMIUM CONTENT, or /cancel:');
promptStep('admin_link_adult', 'LINK_ADULT', '🔞 Send new URL for 18+ CONTENT, or /cancel:');
promptStep('admin_prompt_rating', 'SET_RATING', '⭐ Send new "Our Rating" (e.g. 4.8/5), or /cancel:');
promptStep('admin_prompt_ban', 'BAN_USER', '🚫 Send User Telegram ID to BAN, or /cancel:');
promptStep('admin_prompt_unban', 'UNBAN_USER', '✅ Send User Telegram ID to UNBAN, or /cancel:');
promptStep('admin_prompt_broadcast', 'BROADCAST', '📢 Send/forward any message to BROADCAST to all users, or /cancel:');
promptStep('admin_prompt_broadcast_pin', 'BROADCAST_PIN', '📌 Send/forward any message to BROADCAST & PIN for all users, or /cancel:');

bot.action('admin_clean_queue', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const s: any = await AppSettings.findOne({ key: 'global' });
  const allowed = String(s?.allowedLanguages || 'hi,en,ta,te,ml,kn').split(',').map((x: string) => x.trim().toLowerCase()).filter(Boolean);
  const res = await MediaItem.deleteMany({ isPublished: false, $or: [{ originalLanguage: {$nin: allowed } }, { posterPath: '' }] });
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
  const [total, pub, pend, job, s]: any = await Promise.all([
    MediaItem.countDocuments(),
    MediaItem.countDocuments({ isPublished: true }),
    MediaItem.countDocuments({ isPublished: false }),
    MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({ month: -1 }),
    AppSettings.findOne({ key: 'global' })
  ]);
  return ctx.replyWithHTML(
    `📊 <b>Status:</b>\n🌱 Seeding: ${s?.autoSeedingEnabled ? 'ON' : 'OFF'}\n📤 Publish: ${s?.autoPublishEnabled ? 'ON' : 'OFF'} (Every ${s?.publishIntervalMinutes || 20}m)\n📅 Month: ${job ? `${job.month} P${job.currentPage}/${job.totalPages}` : 'Idle'}\n🎬 Total: ${total} | ✅ Posted: ${pub} | ⏳ Queue: ${pend}`
  );
});

bot.command('latest', async (ctx) => {
  const items = await MediaItem.find().sort({ releaseDate: -1 }).limit(10);
  if (items.length === 0) return ctx.reply('No titles yet.');
  const buttons = items.map((item: any, i: number) => [
    Markup.button.callback(`${i + 1}. 🎬 ${item.title} (${item.releaseDate ? String(item.releaseDate).substring(0, 4) : 'N/A'})`, `view_${item._id}`)
  ]);
  return ctx.replyWithHTML('🆕 <b>Latest Titles:</b>', Markup.inlineKeyboard(buttons));
});

bot.action(/^view_(.+)$/, async (ctx) => {
  try {
    let item: any = await MediaItem.findById(ctx.match[1]);
    if (!item) return ctx.answerCbQuery('Not found');
    await ctx.answerCbQuery('Loading...');
    if (!item.runtime || !item.overview || !Array.isArray(item.genres) || item.genres.length === 0) {
      const d = await fetchTMDBDetails(item.tmdbId, item.mediaType);
      if (d) {
        item.genres = d.genres?.map((g: any) => g.name) || item.genres;
        item.runtime = d.runtime || (d.episode_run_time ? d.episode_run_time[0] : 0) || 0;
        item.seasonCount = d.number_of_seasons || 0;
        item.episodeCount = d.number_of_episodes || 0;
        item.imdbId = d.external_ids?.imdb_id || d.imdb_id || '';
      }
      item = await enrichWithAI(item);
      await item.save();
    }
    return sendMediaCardToChat(ctx, item);
  } catch (_e) {
    return ctx.answerCbQuery('Error');
  }
});

const handleTitleSearch = async (ctx: any, rawQuery: string) => {
  const cleanQuery = rawQuery.replace(/^\d+\.\s*/, '').replace(/🎬/g, '').replace(/\(\d{4}\)\s*$/, '').trim();
  if (!cleanQuery || cleanQuery.length < 2) return ctx.reply('Please enter a valid movie/series name.');

  try {
    const escaped = cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let results = await MediaItem.find({ title: { $regex: escaped,$options: 'i' } }).sort({ voteCount: -1, releaseDate: -1 }).limit(8);

    if (results.length === 0) {
      const liveHits = await searchTMDBMulti(cleanQuery);
      for (const hit of liveHits.slice(0, 5)) {
        const mediaType: 'movie' | 'tv' = hit.media_type === 'tv' ? 'tv' : 'movie';
        const d = await fetchTMDBDetails(hit.id, mediaType);
        const doc: any = await MediaItem.findOneAndUpdate(
          { tmdbId: hit.id, mediaType },
          {
            $set: {
              title: hit.title || hit.name || 'Untitled',
              originalLanguage: hit.original_language || '',
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
          { upsert: true, new: true }
        );
        if (doc && (!doc.overview || !doc.runtime)) {
          await enrichWithAI(doc);
          await doc.save();
        }
      }
      results = await MediaItem.find({ title: { $regex: escaped,$options: 'i' } }).sort({ voteCount: -1, releaseDate: -1 }).limit(8);
    }

    if (results.length === 0) return ctx.reply(`No results found for "${cleanQuery}".`);
    if (results.length === 1) {
      let item: any = results[0];
      if (!item.runtime || !item.overview || !item.imdbRating) {
        item = await enrichWithAI(item);
        await item.save();
      }
      return sendMediaCardToChat(ctx, item);
    }

    const buttons = results.map((item: any) => [
      Markup.button.callback(`🎬 ${item.title} (${item.releaseDate ? String(item.releaseDate).substring(0, 4) : 'N/A'})`, `view_${item._id}`)
    ]);
    return ctx.replyWithHTML(`🔎 <b>Results for "${escapeHtml(cleanQuery)}":</b>`, Markup.inlineKeyboard(buttons));
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
  const sess = uid ? adminSession.get(uid) : undefined;

  if (sess && isAdmin(uid)) {
    const step = sess.step;
    adminSession.delete(uid);

    if (step === 'BROADCAST' || step === 'BROADCAST_PIN') {
      const pin = step === 'BROADCAST_PIN';
      const users = await BotUser.find({ isBanned: { $ne: true } });
      let sent = 0, pinned = 0, failed = 0;
      await ctx.reply(`⏳ Broadcasting to ${users.length} users...`);
      for (const u of users) {
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
    else if (step === 'SET_TIME') await AppSettings.updateOne({ key: 'global' }, { $set: { publishIntervalMinutes: Math.max(1, Number(t) || 20) } }, { upsert: true });
    else if (step === 'BAN_USER' && Number(t)) await BotUser.findOneAndUpdate({ telegramId: Number(t) }, { $set: { isBanned: true } }, { upsert: true });
    else if (step === 'UNBAN_USER' && Number(t)) await BotUser.findOneAndUpdate({ telegramId: Number(t) }, { $set: { isBanned: false } }, { upsert: true });

    await ctx.reply('✅ Updated successfully!');
    return renderAdminPanel(ctx, false);
  }

  const text = (ctx.message?.text || '').trim();
  if (!text || text.startsWith('/')) return;
  return handleTitleSearch(ctx, text);
});
// === END OF FILE ===
