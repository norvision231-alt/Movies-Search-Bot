import { Telegraf, Markup } from 'telegraf';
import { MediaItem, MonthJob, AppSettings } from '../database/models';
import { searchTMDBMulti, fetchTMDBDetails, mapGenreIds } from '../services/tmdb';

const token = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!token) throw new Error('BOT_TOKEN is missing');

export const bot = new Telegraf(token);

export const getTargetChannel = (): string => {
  return (process.env.LOG_CHANNEL || process.env.TELEGRAM_MAIN_CHANNEL_ID || '').trim();
};

export const isAdmin = (userId?: number): boolean => {
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
  hi: 'Hindi (हिंदी)',
  en: 'English',
  ta: 'Tamil (தமிழ்)',
  te: 'Telugu (తెలుగు)',
  ml: 'Malayalam (മലയാളം)',
  kn: 'Kannada (ಕನ್ನಡ)',
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
        .map((g: string) => `#${g.replace(/[^a-zA-Z0-9]/g, '')}`)
        .join(' ')
    : '';

  return [
    cleanTitle ? `#${cleanTitle}` : '',
    year ? `#Release${year}` : '',
    langTag ? `#${langTag}Movies` : '',
    typeTag,
    genreTags,
    '#HDUpdate #MovieDatabase'
  ]
    .filter(Boolean)
    .join(' ');
};

export const formatCaption = (media: any, settings: any): string => {
  const title = escapeHtml(media.title || 'Untitled');
  const year = media.releaseDate ? escapeHtml(String(media.releaseDate).substring(0, 4)) : 'N/A';
  const langCode = (media.originalLanguage || '').toLowerCase();
  const langDisplay =
    LANGUAGE_NAMES[langCode] ||
    (Array.isArray(media.spokenLanguages) && media.spokenLanguages.length > 0
      ? media.spokenLanguages.join(', ')
      : media.originalLanguage?.toUpperCase() || 'Multi-Audio');

  const genres =
    Array.isArray(media.genres) && media.genres.length > 0
      ? escapeHtml(media.genres.join(', '))
      : 'Drama / Entertainment';

  const tmdbRating =
    media.tmdbRating && Number(media.tmdbRating) > 0
      ? `${Number(media.tmdbRating).toFixed(1)}/10 ⭐`
      : 'New Release 🔥';

  const rawOverview = media.overview ? String(media.overview).trim() : '';
  const defaultDesc = `${media.title} (${year}) is an exciting ${genres.toLowerCase()} ${
    media.mediaType === 'tv' ? 'series' : 'movie'
  } available in ${langDisplay}.`;
  const descSource = rawOverview || defaultDesc;
  const shortOverview =
    descSource.length > 260
      ? `${escapeHtml(descSource.substring(0, 257))}...`
      : escapeHtml(descSource);

  const channel01Url = settings?.channel01Url || 'https://t.me/yourchannel1';
  const channel02Url = settings?.channel02Url || 'https://t.me/yourchannel2';
  const premiumUrl = settings?.premiumUrl || channel01Url;
  const adultUrl = settings?.adultContentUrl || channel02Url;
  const ourRating = (settings?.ourRating || '4.6/5').trim();

  const lines: string[] = [`🔥 <b>${title}</b> (${year})`];

  if (media.imdbId) {
    lines.push(
      `⭐ <b>IMDb:</b> <a href="https://www.imdb.com/title/${escapeHtml(media.imdbId)}/">Verified IMDb Page</a>`
    );
  }

  lines.push(
    `🌐 <b>Language:</b> ${escapeHtml(langDisplay)}`,
    `🎭 <b>Genre:</b> ${genres}`
  );

  if (media.mediaType === 'tv' && media.seasonCount && Number(media.seasonCount) > 0) {
    const epText = media.episodeCount ? ` (${media.episodeCount} Episodes)` : '';
    lines.push(`📺 <b>Seasons:</b> ${escapeHtml(String(media.seasonCount))}${escapeHtml(epText)}`);
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
    `📝 ${shortOverview}`,
    '━━━━━━━━━━━━━━',
    `🔗 <b>JOIN CHANNEL 01:</b> 👉 <a href="${escapeHtml(channel01Url)}">JOIN NOW</a>`,
    `🔗 <b>JOIN CHANNEL 02:</b> 👉 <a href="${escapeHtml(channel02Url)}">JOIN NOW</a>`,
    `💎 <a href="${escapeHtml(premiumUrl)}"><b>JOIN PREMIUM CONTENT</b></a>`,
    '━━━━━━━━━━━━━━',
    `🔞 <a href="${escapeHtml(adultUrl)}"><b>18+ CONTENT ONLY</b></a>`,
    '⚠️ Adults only where applicable. Viewer discretion advised.',
    '',
    `🏷️ ${escapeHtml(createSeoHashtags(media, langDisplay))}`
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

export const sendMediaCardToChat = async (ctx: any, item: any) => {
  let settings = await AppSettings.findOne({ key: 'global' });
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

bot.start((ctx) => {
  ctx.replyWithHTML(
    '🎬 <b>Welcome to the Movie & Web-Series Archive Bot!</b>\n\n' +
      '🔎 किसी भी मूवी या वेब-सीरीज़ का नाम सीधे लिखकर भेजें (जैसे: <code>Kingsman</code> या <code>Pushpa</code>)।\n' +
      '🆕 नवीनतम टाइटल्स के लिए <code>/latest</code> भेजें।\n' +
      '⚙️ एडमिन कंट्रोल्स के लिए <code>/admin</code> भेजें।'
  );
});

bot.help((ctx) => {
  ctx.replyWithHTML(
    '📌 <b>Available Commands:</b>\n\n' +
      '• किसी भी मूवी/सीरीज़ का नाम सीधे लिखकर भेजें\n' +
      '• <code>/search &lt;title&gt;</code> - मूवी या वेब-सीरीज़ खोजें\n' +
      '• <code>/latest</code> - हाल ही में जोड़े गए 10 टाइटल्स\n' +
      '• <code>/status</code> - डेटाबेस और ऑटोमेशन स्टेटस\n' +
      '• <code>/admin</code> - एडमिन कंट्रोल पैनल'
  );
});

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.reply(
      `⛔ यह पैनल केवल एडमिन के लिए है। (आपकी Telegram ID: ${ctx.from?.id})। इसे Render के ADMIN_ID में जोड़ें।`
    );
  }

  let settings = await AppSettings.findOne({ key: 'global' });
  if (!settings) settings = await AppSettings.create({ key: 'global' });

  const total = await MediaItem.countDocuments();
  const published = await MediaItem.countDocuments({ isPublished: true });
  const pending = await MediaItem.countDocuments({ isPublished: false });
  const appUrl = process.env.APP_BASE_URL || 'https://movies-search-bot-vdp1.onrender.com';

  return ctx.replyWithHTML(
    `⚙️ <b>ADMIN CONTROL PANEL</b>\n\n` +
      `🌱 <b>Auto Seeding:</b> ${settings.autoSeedingEnabled ? '✅ RUNNING' : '⏸️ PAUSED'}\n` +
      `📤 <b>Auto Publishing:</b> ${settings.autoPublishEnabled ? '✅ RUNNING' : '⏸️ PAUSED'}\n` +
      `🌐 <b>Allowed Languages:</b> <code>${settings.allowedLanguages}</code>\n` +
      `⭐ <b>Our Rating:</b> <code>${settings.ourRating}</code>\n` +
      `🎬 <b>Total DB:</b> ${total} | ✅ <b>Posted:</b> ${published} | ⏳ <b>Queue:</b> ${pending}\n\n` +
      `🔗 <b>Web Dashboard:</b> <a href="${appUrl}">${appUrl}</a>\n` +
      `💡 लिंक्स बदलने के लिए: <code>/setlinks URL1 URL2 PREMIUM ADULT</code>`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          settings.autoSeedingEnabled ? '⏸️ Stop Seeding' : '▶️ Start Seeding',
          'admin_toggle_seed'
        ),
        Markup.button.callback(
          settings.autoPublishEnabled ? '⏸️ Stop Publish' : '▶️ Start Publish',
          'admin_toggle_pub'
        )
      ],
      [
        Markup.button.callback('🧹 Clean Non-Priority Queue', 'admin_clean_queue'),
        Markup.button.callback('🛑 Emergency Stop All', 'admin_stop_all')
      ]
    ])
  );
});

bot.command('setlinks', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ केवल एडमिन के लिए।');
  const parts = ctx.message.text.split(/\s+/).slice(1);
  if (parts.length < 2) {
    return ctx.reply(
      'उपयोग: /setlinks <Channel1_URL> <Channel2_URL> [Premium_URL] [Adult_URL]'
    );
  }
  await AppSettings.updateOne(
    { key: 'global' },
    {
      $set: {
        channel01Url: parts[0],
        channel02Url: parts[1],
        premiumUrl: parts[2] || parts[0],
        adultContentUrl: parts[3] || parts[1]
      }
    },
    { upsert: true }
  );
  return ctx.reply('✅ सभी चैनल लिंक्स सफलतापूर्वक अपडेट हो गए हैं!');
});

bot.action('admin_toggle_seed', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const settings = await AppSettings.findOne({ key: 'global' });
  const nextState = !(settings?.autoSeedingEnabled ?? true);
  await AppSettings.updateOne(
    { key: 'global' },
    { $set: { autoSeedingEnabled: nextState } },
    { upsert: true }
  );
  await ctx.answerCbQuery(`Auto Seeding: ${nextState ? 'ON' : 'OFF'}`);
  return ctx.reply(`🌱 Auto Seeding अब ${nextState ? '✅ चालू' : '⏸️ बंद'} है।`);
});

bot.action('admin_toggle_pub', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const settings = await AppSettings.findOne({ key: 'global' });
  const nextState = !(settings?.autoPublishEnabled ?? true);
  await AppSettings.updateOne(
    { key: 'global' },
    { $set: { autoPublishEnabled: nextState } },
    { upsert: true }
  );
  await ctx.answerCbQuery(`Auto Publishing: ${nextState ? 'ON' : 'OFF'}`);
  return ctx.reply(`📤 Auto Publishing अब ${nextState ? '✅ चालू' : '⏸️ बंद'} है।`);
});

bot.action('admin_clean_queue', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admins only');
  const settings = await AppSettings.findOne({ key: 'global' });
  const allowed = (settings?.allowedLanguages || 'hi,en,ta,te,ml,kn')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const res = await MediaItem.deleteMany({
    isPublished: false,
    originalLanguage: { $nin: allowed }
  });
  await ctx.answerCbQuery('Cleaned queue!');
  return ctx.reply(
    `🧹 क्यू से ${res.deletedCount} गैर-जरूरी भाषा (SU/ID आदि) वाली मूवीज हटा दी गईं!`
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
  return ctx.reply('🛑 EMERGENCY STOP ALL: सभी ऑटोमेटेड जॉब्स रोक दिए गए हैं।');
});

bot.command('status', async (ctx) => {
  const totalMovies = await MediaItem.countDocuments();
  const publishedCount = await MediaItem.countDocuments({ isPublished: true });
  const pendingCount = await MediaItem.countDocuments({ isPublished: false });
  const activeJob = await MonthJob.findOne({ status: { $ne: 'COMPLETED' } }).sort({ month: -1 });
  const settings = await AppSettings.findOne({ key: 'global' });

  return ctx.replyWithHTML(
    `📊 <b>Bot & Database Status:</b>\n\n` +
      `🌱 <b>Auto Seeding:</b> ${settings?.autoSeedingEnabled ? '✅ ON' : '⏸️ OFF'}\n` +
      `📤 <b>Auto Publishing:</b> ${settings?.autoPublishEnabled ? '✅ ON' : '⏸️ OFF'}\n` +
      `📅 <b>Active Month:</b> ${
        activeJob
          ? `${activeJob.month} [${activeJob.mediaType.toUpperCase()}] (Page ${activeJob.currentPage}/${activeJob.totalPages})`
          : 'N/A'
      }\n` +
      `🎬 <b>Total Collected:</b> ${totalMovies}\n` +
      `✅ <b>Published:</b> ${publishedCount}\n` +
      `⏳ <b>Queued:</b> ${pendingCount}`
  );
});

bot.command('latest', async (ctx) => {
  try {
    const items = await MediaItem.find().sort({ releaseDate: -1 }).limit(10);
    if (items.length === 0) {
      return ctx.reply('अभी डेटाबेस में कोई रिकॉर्ड उपलब्ध नहीं है।');
    }

    const buttons = items.map((item: any, idx: number) => {
      const year = item.releaseDate ? String(item.releaseDate).substring(0, 4) : 'N/A';
      return [
        Markup.button.callback(
          `${idx + 1}. 🎬 ${item.title} (${year})`,
          `view_${item._id}`
        )
      ];
    });

    return ctx.replyWithHTML(
      '🆕 <b>Latest Titles in Database:</b>\n<i>(पूरी डिटेल और पोस्टर देखने के लिए किसी भी नाम पर क्लिक करें)</i>',
      Markup.inlineKeyboard(buttons)
    );
  } catch (error) {
    return ctx.reply('डेटा लोड करने में समस्या आई।');
  }
});

bot.action(/^view_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  try {
    const item = await MediaItem.findById(id);
    if (!item) return ctx.answerCbQuery('Item not found');
    await ctx.answerCbQuery();
    return sendMediaCardToChat(ctx, item);
  } catch (e) {
    return ctx.answerCbQuery('Error loading movie');
  }
});

const cleanUserQuery = (raw: string): string => {
  return raw
    .replace(/^\d+\.\s*/, '') // remove leading "1. "
    .replace(/🎬/g, '')
    .replace(/\(\d{4}\)\s*$/, '') // remove trailing "(2026)"
    .trim();
};

const handleTitleSearch = async (ctx: any, rawQuery: string) => {
  const cleanQuery = cleanUserQuery(rawQuery);
  if (!cleanQuery || cleanQuery.length < 2) {
    return ctx.reply('कृपया मूवी या वेब-सीरीज़ का सही नाम लिखें। उदाहरण: Kingsman');
  }

  try {
    const escapedQuery = cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let results = await MediaItem.find({
      title: { $regex: escapedQuery,$options: 'i' }
    })
      .sort({ voteCount: -1, releaseDate: -1 })
      .limit(8);

    // Live TMDB Fallback if not in local DB yet!
    if (results.length === 0) {
      const liveHits = await searchTMDBMulti(cleanQuery);
      for (const hit of liveHits.slice(0, 5)) {
        const mediaType: 'movie' | 'tv' = hit.media_type === 'tv' ? 'tv' : 'movie';
        const details = await fetchTMDBDetails(hit.id, mediaType);

        const genres =
          details?.genres?.map((g: any) => g.name) || mapGenreIds(hit.genre_ids || []);
        const runtime =
          details?.runtime ||
          (Array.isArray(details?.episode_run_time) ? details.episode_run_time[0] : 0) ||
          0;
        const seasonCount = details?.number_of_seasons || 0;
        const episodeCount = details?.number_of_episodes || 0;
        const imdbId = details?.external_ids?.imdb_id || details?.imdb_id || '';
        const spokenLanguages = Array.isArray(details?.spoken_languages)
          ? details.spoken_languages.map((l: any) => l.english_name || l.name).filter(Boolean)
          : [];

        await MediaItem.updateOne(
          { tmdbId: hit.id, mediaType },
          {
            $set: {
              title: hit.title || hit.name || 'Untitled',
              originalTitle: hit.original_title || hit.original_name || '',
              originalLanguage: hit.original_language || '',
              spokenLanguages,
              genres,
              overview: hit.overview || details?.overview || '',
              posterPath: hit.poster_path || details?.poster_path || '',
              releaseDate: hit.release_date || hit.first_air_date || '',
              tmdbRating: hit.vote_average || 0,
              voteCount: hit.vote_count || 0,
              runtime,
              seasonCount,
              episodeCount,
              imdbId
            }
          },
          { upsert: true }
        );
      }

      results = await MediaItem.find({
        title: { $regex: escapedQuery,$options: 'i' }
      })
        .sort({ voteCount: -1, releaseDate: -1 })
        .limit(8);
    }

    if (results.length === 0) {
      return ctx.reply(`"${cleanQuery}" के लिए कोई मूवी या वेब-सीरीज़ नहीं मिली।`);
    }

    // If only 1 match or exact match, send the full rich poster card directly
    if (results.length === 1) {
      return sendMediaCardToChat(ctx, results[0]);
    }

    const buttons = results.map((item: any) => {
      const year = item.releaseDate ? String(item.releaseDate).substring(0, 4) : 'N/A';
      const rating = item.tmdbRating ? `⭐${Number(item.tmdbRating).toFixed(1)}` : '';
      return [
        Markup.button.callback(
          `🎬 ${item.title} (${year}) ${rating}`,
          `view_${item._id}`
        )
      ];
    });

    return ctx.replyWithHTML(
      `🔎 <b>"${escapeHtml(cleanQuery)}" के लिए परिणाम:</b>\n<i>(पूरी डिटेल देखने के लिए नीचे क्लिक करें)</i>`,
      Markup.inlineKeyboard(buttons)
    );
  } catch (error) {
    console.error('Search error:', error);
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
