import mongoose from 'mongoose';

const MediaItemSchema = new mongoose.Schema(
  {
    tmdbId: { type: Number, required: true },
    mediaType: { type: String, enum: ['movie', 'tv'], required: true },
    title: { type: String, required: true },
    originalTitle: { type: String, default: '' },
    originalLanguage: { type: String, default: '' },
    spokenLanguages: { type: [String], default: [] },
    genres: { type: [String], default: [] },
    originCountries: { type: [String], default: [] },
    overview: { type: String, default: '' },
    posterPath: { type: String, default: '' },
    backdropPath: { type: String, default: '' },
    releaseDate: { type: String, default: '' },
    tmdbRating: { type: Number, default: 0 },
    imdbRating: { type: String, default: '' },
    rtRating: { type: String, default: '' },
    voteCount: { type: Number, default: 0 },
    runtime: { type: Number, default: 0 },
    seasonCount: { type: Number, default: 0 },
    episodeCount: { type: Number, default: 0 },
    imdbId: { type: String, default: '' },
    isPublished: { type: Boolean, default: false },
    telegramMessageId: { type: Number, default: 0 },
    collectionMonth: { type: String, default: '' }
  },
  { timestamps: true }
);

MediaItemSchema.index({ tmdbId: 1, mediaType: 1 }, { unique: true });
MediaItemSchema.index({ title: 1 });
MediaItemSchema.index({ isPublished: 1, releaseDate: -1 });

const MonthJobSchema = new mongoose.Schema(
  {
    month: { type: String, required: true },
    mediaType: { type: String, enum: ['movie', 'tv'], default: 'movie' },
    currentPage: { type: Number, default: 1 },
    totalPages: { type: Number, default: 1 },
    status: {
      type: String,
      enum: ['PENDING', 'RUNNING', 'COMPLETED', 'PAUSED', 'ERROR'],
      default: 'PENDING'
    },
    lastError: { type: String, default: '' }
  },
  { timestamps: true }
);

MonthJobSchema.index({ month: 1, mediaType: 1 }, { unique: true });

const AppSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    autoSeedingEnabled: { type: Boolean, default: true },
    autoPublishEnabled: { type: Boolean, default: true },
    aiEnabled: { type: Boolean, default: true },
    publishIntervalMinutes: { type: Number, default: 20 },
    lastPublishAt: { type: Date, default: new Date(0) },
    lastSeedAt: { type: Date, default: new Date(0) },
    startMonth: { type: String, default: '2026-10' },
    oldestMonth: { type: String, default: '2020-01' },
    allowedLanguages: { type: String, default: 'hi,en,ta,te,ml,kn' },
    ourRating: { type: String, default: '4.7/5' },
    channel01Url: { type: String, default: 'https://t.me/yourchannel1' },
    channel02Url: { type: String, default: 'https://t.me/yourchannel2' },
    premiumUrl: { type: String, default: 'https://t.me/yourchannel1' },
    adultContentUrl: { type: String, default: 'https://t.me/yourchannel2' }
  },
  { timestamps: true }
);

const BotUserSchema = new mongoose.Schema(
  {
    telegramId: { type: Number, required: true, unique: true },
    firstName: { type: String, default: '' },
    username: { type: String, default: '' },
    isBanned: { type: Boolean, default: false }
  },
  { timestamps: true }
);

export const MediaItem = mongoose.model<any>('MediaItem', MediaItemSchema);
export const MonthJob = mongoose.model<any>('MonthJob', MonthJobSchema);
export const AppSettings = mongoose.model<any>('AppSettings', AppSettingsSchema);
export const BotUser = mongoose.model<any>('BotUser', BotUserSchema);
