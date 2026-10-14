import mongoose from 'mongoose';

const MediaItemSchema = new mongoose.Schema(
  {
    tmdbId: { type: Number, required: true },
    mediaType: { type: String, enum: ['movie', 'tv'], required: true },
    title: { type: String, required: true },
    originalLanguage: { type: String, default: '' },
    genres: { type: [String], default: [] },
    overview: { type: String, default: '' },
    posterPath: { type: String, default: '' },
    releaseDate: { type: String, default: '' },
    tmdbRating: { type: Number, default: 0 },
    runtime: { type: Number, default: 0 },
    seasonCount: { type: Number, default: 0 },
    isPublished: { type: Boolean, default: false },
    collectionMonth: { type: String, default: '' }
  },
  { timestamps: true }
);

MediaItemSchema.index({ tmdbId: 1, mediaType: 1 }, { unique: true });
MediaItemSchema.index({ title: 1 });
MediaItemSchema.index({ isPublished: 1, releaseDate: -1 });

const MonthJobSchema = new mongoose.Schema(
  {
    month: { type: String, required: true, unique: true },
    mediaType: { type: String, default: 'movie' },
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

const AppSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    autoSeedingEnabled: { type: Boolean, default: true },
    autoPublishEnabled: { type: Boolean, default: true },
    aiEnabled: { type: Boolean, default: false },
    startMonth: { type: String, default: '2026-10' },
    oldestMonth: { type: String, default: '2020-01' },
    channel01Url: { type: String, default: 'https://t.me/yourchannel1' },
    channel02Url: { type: String, default: 'https://t.me/yourchannel2' },
    premiumUrl: { type: String, default: '' },
    adultContentUrl: { type: String, default: '' }
  },
  { timestamps: true }
);

export const MediaItem = mongoose.model('MediaItem', MediaItemSchema);
export const MonthJob = mongoose.model('MonthJob', MonthJobSchema);
export const AppSettings = mongoose.model('AppSettings', AppSettingsSchema);
