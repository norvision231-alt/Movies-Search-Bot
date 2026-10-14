import mongoose, { Document, Schema } from 'mongoose';

export interface IMediaItem extends Document {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  originalTitle?: string;
  normalizedTitle: string;
  releaseDate: string;
  releaseYear: string;
  originalLanguage: string;
  originCountries: string[];
  categoryBucket: string;
  genres: string[];
  overview: string;
  catchyDescription?: string;
  posterPath?: string;
  backdropPath?: string;
  tmdbRating: number;
  voteCount: number;
  runtime?: number;
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  imdbId?: string;
  adult: boolean;
  collectionMonth: string;
  publishStatus: 'QUEUED' | 'PUBLISHED' | 'SKIPPED_DUPLICATE' | 'FAILED';
  telegramMessageId?: number;
  publishedChannelId?: string;
}

const MediaItemSchema = new Schema<IMediaItem>({
  tmdbId: { type: Number, required: true },
  mediaType: { type: String, enum: ['movie', 'tv'], required: true },
  title: { type: String, required: true },
  originalTitle: { type: String },
  normalizedTitle: { type: String, required: true, index: true },
  releaseDate: { type: String, default: '' },
  releaseYear: { type: String, default: 'N/A' },
  originalLanguage: { type: String, default: 'en' },
  originCountries: [{ type: String }],
  categoryBucket: { type: String, default: 'GLOBAL' },
  genres: [{ type: String }],
  overview: { type: String, default: '' },
  catchyDescription: { type: String },
  posterPath: { type: String },
  backdropPath: { type: String },
  tmdbRating: { type: Number, default: 0 },
  voteCount: { type: Number, default: 0 },
  runtime: { type: Number },
  numberOfSeasons: { type: Number },
  numberOfEpisodes: { type: Number },
  imdbId: { type: String },
  adult: { type: Boolean, default: false },
  collectionMonth: { type: String, required: true, index: true },
  publishStatus: {
    type: String,
    enum: ['QUEUED', 'PUBLISHED', 'SKIPPED_DUPLICATE', 'FAILED'],
    default: 'QUEUED',
    index: true
  },
  telegramMessageId: { type: Number },
  publishedChannelId: { type: String }
}, { timestamps: true });

// Unique index so the same movie/series is never duplicated in media_items
MediaItemSchema.index({ tmdbId: 1, mediaType: 1 }, { unique: true });
MediaItemSchema.index({ normalizedTitle: 1, releaseYear: 1, mediaType: 1 });
MediaItemSchema.index({ collectionMonth: -1, publishStatus: 1, releaseDate: -1 });

export interface IMonthJob extends Document {
  month: string;
  mediaType: 'movie' | 'tv';
  bucket: string;
  currentPage: number;
  totalPages: number;
  collectedCount: number;
  status: 'PENDING' | 'RUNNING' | 'COLLECTED' | 'LIMITED_500' | 'ERROR';
  lastError?: string;
  retryCount: number;
}

const MonthJobSchema = new Schema<IMonthJob>({
  month: { type: String, required: true },
  mediaType: { type: String, enum: ['movie', 'tv'], required: true },
  bucket: { type: String, required: true },
  currentPage: { type: Number, default: 1 },
  totalPages: { type: Number, default: 1 },
  collectedCount: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['PENDING', 'RUNNING', 'COLLECTED', 'LIMITED_500', 'ERROR'],
    default: 'PENDING'
  },
  lastError: { type: String },
  retryCount: { type: Number, default: 0 }
}, { timestamps: true });

MonthJobSchema.index({ month: 1, mediaType: 1, bucket: 1 }, { unique: true });

export interface ITelegramPost extends Document {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  destinationChannelId: string;
  normalizedTitle: string;
  releaseYear: string;
  telegramMessageId?: number;
  status: 'PENDING_SEND' | 'PUBLISHED' | 'IMPORTED_HISTORY' | 'FAILED';
  errorText?: string;
}

const TelegramPostSchema = new Schema<ITelegramPost>({
  tmdbId: { type: Number, required: true },
  mediaType: { type: String, enum: ['movie', 'tv'], required: true },
  destinationChannelId: { type: String, required: true },
  normalizedTitle: { type: String, required: true },
  releaseYear: { type: String, default: 'N/A' },
  telegramMessageId: { type: Number },
  status: {
    type: String,
    enum: ['PENDING_SEND', 'PUBLISHED', 'IMPORTED_HISTORY', 'FAILED'],
    default: 'PENDING_SEND'
  },
  errorText: { type: String }
}, { timestamps: true });

// Strict database constraint preventing duplicate posts to the same channel
TelegramPostSchema.index({ tmdbId: 1, mediaType: 1, destinationChannelId: 1 }, { unique: true });
TelegramPostSchema.index({ normalizedTitle: 1, releaseYear: 1, mediaType: 1, destinationChannelId: 1 });

export interface IAppSettings extends Document {
  key: string;
  autoSeedingEnabled: boolean;
  autoPublishEnabled: boolean;
  aiFallbackEnabled: boolean;
  requireFullMonthBeforePublish: boolean;
  activeMonth: string;
  oldestMonth: string;
  channel01Url: string;
  channel02Url: string;
  premiumUrl: string;
  adultContentUrl: string;
  ourRating: string;
  aiCallsCount: number;
  aiMaxCallsLimit: number;
  lastAiProviderUsed: string;
  lockOwner?: string | null;
  lockExpiresAt?: Date | null;
  lastRunAt?: Date;
  lastError?: string;
}

const AppSettingsSchema = new Schema<IAppSettings>({
  key: { type: String, required: true, unique: true, default: 'global' },
  autoSeedingEnabled: { type: Boolean, default: true },
  autoPublishEnabled: { type: Boolean, default: true },
  aiFallbackEnabled: { type: Boolean, default: true },
  requireFullMonthBeforePublish: { type: Boolean, default: false },
  activeMonth: { type: String, default: '2026-10' },
  oldestMonth: { type: String, default: '1995-01' },
  channel01Url: { type: String, default: 'https://t.me/your_channel_01' },
  channel02Url: { type: String, default: 'https://t.me/your_channel_02' },
  premiumUrl: { type: String, default: 'https://t.me/your_premium_channel' },
  adultContentUrl: { type: String, default: 'https://t.me/your_18plus_channel' },
  ourRating: { type: String, default: '8.5/10' },
  aiCallsCount: { type: Number, default: 0 },
  aiMaxCallsLimit: { type: Number, default: 1000 },
  lastAiProviderUsed: { type: String, default: 'NONE' },
  lockOwner: { type: String, default: null },
  lockExpiresAt: { type: Date, default: null },
  lastRunAt: { type: Date },
  lastError: { type: String, default: '' }
}, { timestamps: true });

export const MediaItem = mongoose.model<IMediaItem>('MediaItem', MediaItemSchema);
export const MonthJob = mongoose.model<IMonthJob>('MonthJob', MonthJobSchema);
export const TelegramPost = mongoose.model<ITelegramPost>('TelegramPost', TelegramPostSchema);
export const AppSettings = mongoose.model<IAppSettings>('AppSettings', AppSettingsSchema);

export const normalizeTitle = (title: string): string => {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F]/g, '')
    .trim();
};
