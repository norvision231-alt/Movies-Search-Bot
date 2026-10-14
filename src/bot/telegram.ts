import { Telegraf } from 'telegraf';
import { MediaItem } from '../database/models';

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN is missing");

export const bot = new Telegraf(token);
const LOG_CHANNEL = process.env.LOG_CHANNEL || '';

// Format Post matching your exact requirements
export const formatCaption = (media: any, settings: any) => {
  const year = media.releaseDate ? media.releaseDate.substring(0, 4) : 'N/A';
  return `🔥 <b>${media.title}</b> (${year})

🌐 <b>Language:</b> ${media.originalLanguage?.toUpperCase() || 'N/A'}
⭐ <b>TMDB Rating:</b> ${media.tmdbRating || 'N/A'}

${media.overview ? media.overview.substring(0, 200) + '...' : ''}
━━━━━━━━━━━━━━
🔗 <b>JOIN CHANNEL 01:</b> 👉 <a href="${settings.channel01Url}">JOIN NOW</a>
🔗 <b>JOIN CHANNEL 02:</b> 👉 <a href="${settings.channel02Url}">JOIN NOW</a>`;
};

bot.command('start', (ctx) => ctx.reply('Welcome to the Movie Database Bot! Send a movie name to search.'));

bot.command('search', async (ctx) => {
  const query = ctx.message.text.replace('/search', '').trim();
  if (!query) return ctx.reply("Please provide a title to search. Example: /search Inception");
  
  const results = await MediaItem.find({ title: { $regex: query,$options: 'i' } }).limit(5);
  if (results.length === 0) return ctx.reply("No results found in the private archive.");

  let responseText = "🔎 <b>Search Results:</b>\n\n";
  results.forEach((item: any) => {
    responseText += `🎬 ${item.title} (${item.releaseDate?.substring(0, 4) || 'N/A'})\n`;
  });
  ctx.replyWithHTML(responseText);
});

export const sendToLogChannel = async (message: string) => {
  if (LOG_CHANNEL) {
    try {
      await bot.telegram.sendMessage(LOG_CHANNEL, message, { parse_mode: 'HTML' });
    } catch (e) {
      console.error("Failed to send to log channel:", e);
    }
  }
};
