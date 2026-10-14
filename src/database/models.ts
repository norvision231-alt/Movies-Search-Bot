import mongoose from 'mongoose';

const MediaItemSchema = new mongoose.Schema({
  tmdbId: { type: Number, required: true },
  mediaType: { type: String, enum: ['movie', 'tv'], required: true },
  title: { type: String, required: true },
  originalLanguage: String,
  genres: [String],
  overview: String,
  posterPath: String,
  releaseDate: String,
  tmdbRating: Number,
  isPublished: { type: Boolean, default: false },
  collectionMonth: String // e.g., "2026-10"
}, { timestamps: true });

MediaItemSchema.index({ tmdbId: 1, mediaType: 1 }, { unique: true });

const MonthJobSchema = new mongoose.Schema({
  month: { type: String, required: true, unique: true }, // e.g., "2026-10"
  currentPage: { type: Number, default: 1 },
  totalPages: { type: Number, default: 1 },
  status: { type: String, enum: ['PENDING', 'RUNNING', 'COMPLETED'], default: 'PENDING' }
}, { timestamps: true });

const AppSettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  autoSeedingEnabled: { type: Boolean, default: true },
  autoPublishEnabled: { type: Boolean, default: true },
  channel01Url: { type: String, default: "https://t.me/yourchannel1" },
  channel02Url: { type: String, default: "https://t.me/yourchannel2" }
});

export const MediaItem = mongoose.model('MediaItem', MediaItemSchema);
export const MonthJob = mongoose.model('MonthJob', MonthJobSchema);
export const AppSettings = mongoose.model('AppSettings', AppSettingsSchema);
