import { Telegraf, Markup } from 'telegraf';
import { MediaItem, AppSettings, TelegramPost, normalizeTitle } from '../database/models';

const token = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!token) throw new Error('BOT_TOKEN is missing');

export const bot = new Telegraf(token);

export const getTargetChannel = (): string => {
  return (process.env.LOG_CHANNEL || process.env.TELEGRAM_MAIN_CHANNEL_ID || '').trim();
};

const isAdmin = (userId?: number): boolean => {
  if (!userId) return false;
  const adminEnv = (process.env.ADMIN_ID || process.env.ADMIN_TELEGRAM_IDS || '').trim();
  const adminIds = adminEnv.split(',').map((id) => id.trim());
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
  hi: 'Hindi', en: 'English', ta: 'Tamil', te: 'Telugu
