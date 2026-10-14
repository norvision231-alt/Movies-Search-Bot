import { Telegraf } from 'telegraf';
import { MediaItem, MonthJob, AppSettings } from '../database/models';

const token = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!token) throw new Error('BOT_TOKEN is missing');

export const bot = new Telegraf(token);

export const getTargetChannel = (): string => {
  return (process.env.LOG_CHANNEL || process.env.TELEGRAM_MAIN_CHANNEL_ID || '').trim();
};

const isAdmin = (userId?: number): boolean => {
  if (!userId) return false;
  const adminEnv = (process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_IDS || '').trim();
  const adminIds = adminEnv.split(',').map((id) => id.trim()).filter(Boolean);
  return adminIds.includes(String(userId));
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
  ko: 'Korean',
  ja: 'Japanese',
  es: 'Spanish',
  fr: 'French'
};

export const formatCaption = (media: any, settings: any): string => {
  const title = escapeHtml(media.title || 'Untitled');
  const year = media.releaseDate ? escapeHtml(String(media.releaseDate).substring(0, 4)) : 'N/A';
  const langCode = (media.originalLanguage || '').toLowerCase();
  const language = escapeHtml(
    LANGUAGE_NAMES[langCode] || media.originalLanguage?.toUpperCase() || 'N/A'
  );
  const genres =
    Array.isArray(media.genres) && media.genres.length > 0
      ? escapeHtml(media.genres.join(', '))
      : 'N/A';
  const rating = media.tmdbRating ? `${Number(media.tmdbRating).toFixed(1)}/10` : 'N/A';

  const rawOverview = media.overview ? String(media.overview).trim() : '';
  const shortOverview =
    rawOverview.length > 240
      ? `${escapeHtml(rawOverview.substring(0, 237))}...`
      : escapeHtml(rawOverview);

  const channel01Url = settings?.channel01Url || 'https://t.me/yourchannel1';
  const channel02Url = settings?.channel02Url || 'https://t.me/yourchannel2';
  const premiumUrl = settings?.premiumUrl || '';
  const adultUrl = settings?.adultContentUrl || '';

  const lines: string[] = [
    `🔥 <b>${title}</b> (${year})`,
    `🌐 <b>Language:</b> ${language}`,
    `🎭 <b>Genre:</b> ${genres}`
  ];

  if (media.mediaType === 'tv' && media.seasonCount) {
    lines.push(`📺 <b>Seasons:</b> ${escapeHtml(String(media.seasonCount))}`);
  }
  if (media.runtime) {
    lines.push(`⏱️ <b>Runtime:</b> ${escapeHtml(String(media.runtime))} min`);
  }

  lines.push(`⭐ <b>TMDB Rating:</b> ${rating}`);

  if (shortOverview) {
    lines.push('', shortOverview);
  }

  lines.push(
    '━━━━━━━━━━━━━━',
    `🔗 <b>JOIN CHANNEL 01:</b> 👉 <a href="${escapeHtml(channel01Url)}">JOIN NOW</a>`,
    `🔗 <b>JOIN CHANNEL 02:</b> 👉 <a href="${escapeHtml(channel02Url)}">JOIN NOW</a>`
  );

  if (premiumUrl) {
    lines.push(`💎 <a href="${escapeHtml(premiumUrl)}"><b>JOIN PREMIUM CONTENT</b></a>`);
  }

  if (adultUrl) {
    lines.push(
      '━━━━━━━━━━━━━━',
      `🔞 <a href="${escapeHtml(adultUrl)}"><b>18+ CONTENT ONLY</b></a>`,
      '⚠️ Adults only where applicable. Viewer discretion advised.'
    );
  }

  return lines.join('\n');
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

bot.start((ctx) => {
  ctx.replyWithHTML(
    '🎬 <b>Welcome to the Movie & Web-Series Archive Bot!</b>\n\n' +
      '🔎 किसी भी मूवी या सीरीज़ को खोजने के लिए उसका नाम भेजें या <code>/search TITLE</code> का उपयोग करें।\n' +
      '🆕 नवीनतम अपडेट्स के लिए <code>/latest</code> भेजें।\n' +
      '📊 स्टेटस देखने के लिए <code>/status</code> भेजें।'
  );
});

bot.help((ctx) => {
  ctx.replyWithHTML(
    '📌 <b>Available Commands:</b>\n\n' +
      '• <code>/start</code> - बॉट शुरू करें\n' +
      '• <code>/search &lt;title&gt;</code> - मूवी या वेब-सीरीज़ खोजें\n' +
      '• <code>/latest</code> - हाल ही में जोड़े गए टाइटल्स देखें\n' +
      '• <code>/status</code> - डेटाबेस और ऑटोमेशन स्टेटस (Admin)\n' +
      '• <code>/seeding_on</code> / <code>/seeding_off</code> - सीडिंग कंट्रोल (Admin)\n' +
      '• <code>/publish_on</code> / <code>/publish_off</code> - पब्लिशिंग कंट्रोल (Admin)\n' +
      '• <code>/stop_all</code> - Emergency Stop All (Admin)'
  );
});

bot.command('status', async (ctx) => {
  try {
    const totalMovies = await MediaItem.countDocuments();
    const publishedCount = await MediaItem.countDocuments({ isPublished: true });
    const pendingCount = await MediaItem.countDocuments({ isPublished: false });
    const activeJob = await MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({ month: -1 });
    const settings = await AppSettings.findOne({ key: 'global' });

    return ctx.replyWithHTML(
      `📊 <b>Bot & Database Status:</b>\n\n` +
        `🌱 <b>Auto Seeding:</b> ${settings?.autoSeedingEnabled ? '✅ ON' : '⏸️ OFF'}\n` +
        `📤 <b>Auto Publishing:</b> ${settings?.autoPublishEnabled ? '✅ ON' : '⏸️ OFF'}\n` +
        `📅 <b>Active Month:</b> ${activeJob ? `${activeJob.month} (Page ${activeJob.currentPage}/${activeJob.totalPages})` : 'N/A'}\n` +
        `🎬 <b>Total Collected:</b> ${totalMovies}\n` +
        `✅ <b>Published:</b> ${publishedCount}\n` +
        `⏳ <b>Queued:</b> ${pendingCount}`
    );
  } catch (error) {
    return ctx.reply('स्टेटस लोड करने में त्रुटि हुई।');
  }
});

bot.command('seeding_on', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ केवल एडमिन के लिए।');
  await AppSettings.updateOne({ key: 'global' }, { $set: { autoSeedingEnabled: true } }, { upsert: true });
  return ctx.reply('✅ Auto Seeding चालू कर दी गई है।');
});

bot.command('seeding_off', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ केवल एडमिन के लिए।');
  await AppSettings.updateOne({ key: 'global' }, { $set: { autoSeedingEnabled: false } }, { upsert: true });
  return ctx.reply('⏸️ Auto Seeding रोक दी गई है।');
});

bot.command('publish_on', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ केवल एडमिन के लिए।');
  await AppSettings.updateOne({ key: 'global' }, { $set: { autoPublishEnabled: true } }, { upsert: true });
  return ctx.reply('✅ Auto Publishing चालू कर दी गई है।');
});

bot.command('publish_off', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ केवल एडमिन के लिए।');
  await AppSettings.updateOne({ key: 'global' }, { $set: { autoPublishEnabled: false } }, { upsert: true });
  return ctx.reply('⏸️ Auto Publishing रोक दी गई है।');
});

bot.command('stop_all', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ केवल एडमिन के लिए।');
  await AppSettings.updateOne(
    { key: 'global' },
    { $set: { autoSeedingEnabled: false, autoPublishEnabled: false, aiEnabled: false } },
    { upsert: true }
  );
  return ctx.reply('🛑 EMERGENCY STOP: सभी ऑटोमेटेड जॉब्स रोक दिए गए हैं।');
});

bot.command('latest', async (ctx) => {
  try {
    const items = await MediaItem.find().sort({ releaseDate: -1 }).limit(10);
    if (items.length === 0) {
      return ctx.reply('अभी डेटाबेस में कोई रिकॉर्ड उपलब्ध नहीं है।');
    }

    const list = items
      .map((item: any, idx: number) => {
        const year = item.releaseDate ? String(item.releaseDate).substring(0, 4) : 'N/A';
        return `${idx + 1}. 🎬 <b>${escapeHtml(item.title)}</b> (${year})`;
      })
      .join('\n');

    return ctx.replyWithHTML(`🆕 <b>Latest Titles in Database:</b>\n\n${list}`);
  } catch (error) {
    return ctx.reply('डेटा लोड करने में समस्या आई।');
  }
});

const handleTitleSearch = async (ctx: any, query: string) => {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return ctx.reply('कृपया मूवी का नाम लिखें। उदाहरण: /search Inception');
  }

  try {
    const escapedQuery = cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const results = await MediaItem.find({
      title: { $regex: escapedQuery,$options: 'i' }
    })
      .sort({ releaseDate: -1 })
      .limit(8);

    if (results.length === 0) {
      return ctx.reply(`"${cleanQuery}" के लिए कोई परिणाम नहीं मिला।`);
    }

    const responseLines = results.map((item: any, idx: number) => {
      const year = item.releaseDate ? String(item.releaseDate).substring(0, 4) : 'N/A';
      const rating = item.tmdbRating ? `⭐ ${Number(item.tmdbRating).toFixed(1)}` : '';
      return `${idx + 1}. 🎬 <b>${escapeHtml(item.title)}</b> (${year}) ${rating}`;
    });

    return ctx.replyWithHTML(
      `🔎 <b>Search Results for "${escapeHtml(cleanQuery)}":</b>\n\n${responseLines.join('\n')}`
    );
  } catch (error) {
    return ctx.reply('खोजते समय त्रुटि हुई। कृपया पुनः प्रयास करें।');
  }
};

bot.command('search', async (ctx) => {
  const query = ctx.message.text.replace(/^\/search(@\w+)?/i, '').trim();
  return handleTitleSearch(ctx, query);
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  return handleTitleSearch(ctx, text);
});
