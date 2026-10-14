import axios from 'axios';
import { AppSettings } from '../database/models';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Genre mapping for fast lookup
const GENRE_MAP: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
  53: 'Thriller', 10752: 'War', 37: 'Western', 10759: 'Action & Adventure',
  10765: 'Sci-Fi & Fantasy', 10768: 'War & Politics'
};

export const mapGenreIds = (ids: number[] = []): string[] => {
  return ids.map((id) => GENRE_MAP[id]).filter(Boolean);
};

// Self-healing TMDB request with auto auth detection (v3 API key vs v4 Bearer Token) & 429 retry
const tmdbRequest = async (endpoint: string, params: Record<string, any> = {}, retries = 3): Promise<any> => {
  const rawToken = (process.env.TMDB_API_TOKEN || process.env.TMDB_ACCESS_TOKEN || '').trim();
  if (!rawToken) throw new Error('TMDB_API_TOKEN is missing in Environment Variables');

  const isV3ApiKey = rawToken.length === 32 && !rawToken.includes('.');
  const headers: Record<string, string> = { accept: 'application/json' };
  const queryParams: Record<string, any> = { ...params };

  if (isV3ApiKey) {
    queryParams.api_key = rawToken;
  } else {
    headers.Authorization = `Bearer ${rawToken}`;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(`${TMDB_BASE_URL}${endpoint}`, {
        headers,
        params: queryParams,
        timeout: 15000
      });
      return response.data;
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 429) {
        const retryAfterSec = parseInt(error.response.headers?.['retry-after'] || '5', 10);
        console.warn(`TMDB 429 Rate Limit hit. Waiting ${retryAfterSec}s before retry...`);
        await sleep(retryAfterSec * 1000 + 500);
        continue;
      }
      if (attempt === retries) {
        throw new Error(`TMDB Error (${status || 'Network'}): ${error.message}`);
      }
      await sleep(1500 * attempt);
    }
  }
  return null;
};

export interface QueryBucketConfig {
  bucket: string;
  params: Record<string, any>;
}

// Language & Industry Priority Buckets
export const QUERY_BUCKETS: QueryBucketConfig[] = [
  { bucket: 'HINDI_BOLLYWOOD', params: { with_original_language: 'hi' } },
  { bucket: 'SOUTH_INDIAN', params: { with_original_language: 'ta|te|ml|kn' } },
  { bucket: 'INDIAN_OTHER', params: { with_origin_country: 'IN' } },
  { bucket: 'ENGLISH_HOLLYWOOD', params: { with_original_language: 'en' } },
  { bucket: 'INTERNATIONAL', params: {} }
];

export const getLastDayOfMonth = (monthStr: string): string => {
  const [year, month] = monthStr.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return `${monthStr}-${String(lastDay).padStart(2, '0')}`;
};

export const fetchTMDBDiscoverBucket = async (
  mediaType: 'movie' | 'tv',
  monthStr: string,
  bucketName: string,
  page: number = 1
) => {
  const startDate = `${monthStr}-01`;
  const endDate = getLastDayOfMonth(monthStr);
  const bucketObj = QUERY_BUCKETS.find((b) => b.bucket === bucketName) || QUERY_BUCKETS[4];

  const dateParams =
    mediaType === 'movie'
      ? {
          'primary_release_date.gte': startDate,
          'primary_release_date.lte': endDate,
          sort_by: 'primary_release_date.desc'
        }
      : {
          'first_air_date.gte': startDate,
          'first_air_date.lte': endDate,
          sort_by: 'first_air_date.desc'
        };

  return await tmdbRequest(`/discover/${mediaType}`, {
    ...dateParams,
    ...bucketObj.params,
    include_adult: false,
    page
  });
};

// Fetch extra verified details (runtime, seasons, imdb_id) before publishing
export const fetchTMDBItemDetails = async (mediaType: 'movie' | 'tv', tmdbId: number) => {
  try {
    return await tmdbRequest(`/${mediaType}/${tmdbId}`, {
      append_to_response: 'external_ids'
    });
  } catch (e) {
    console.warn(`Could not fetch extra details for ${mediaType}/${tmdbId}`);
    return null;
  }
};

// AI FALLBACK CHAIN: 1. DeepSeek API -> 2. ChatGPT (OpenAI) API -> 3. Deterministic Synopsis
export const generateCatchyDescriptionWithFallback = async (
  title: string,
  year: string,
  mediaType: string,
  genres: string[],
  verifiedOverview: string
): Promise<string> => {
  const cleanOverview = (verifiedOverview || '').trim();

  // If overview is already good and concise, only call AI when overview is missing or too dry
  const settings = await AppSettings.findOne({ key: 'global' });
  if (!settings || !settings.aiFallbackEnabled || settings.aiCallsCount >= settings.aiMaxCallsLimit) {
    return cleanOverview || `Watch ${title} (${year}), an engaging ${genres.join(', ') || mediaType} release.`;
  }

  const systemPrompt =
    'You write ultra-concise, engaging 2-sentence movie/series hooks for a Telegram channel. Never invent actors, ratings, or plot points not implied by the input. No markdown or hashtags.';
  const userPrompt = `Title: ${title} (${year})\nType: ${mediaType.toUpperCase()}\nGenres: ${genres.join(', ') || 'Drama'}\nVerified Synopsis: ${cleanOverview || 'Not provided'}\nWrite a 2-sentence catchy summary (max 220 characters).`;

  // 1. Try DeepSeek First
  const deepseekKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (deepseekKey) {
    try {
      const dsBaseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
      const dsModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
      const res = await axios.post(
        `${dsBaseUrl}/chat/completions`,
        {
          model: dsModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 100,
          temperature: 0.6
        },
        {
          headers: { Authorization: `Bearer ${deepseekKey}`, 'Content-Type': 'application/json' },
          timeout: 12000
        }
      );

      const text = res.data?.choices?.[0]?.message?.content?.trim();
      if (text) {
        settings.aiCallsCount += 1;
        settings.lastAiProviderUsed = 'DEEPSEEK';
        await settings.save();
        return text;
      }
    } catch (dsErr: any) {
      console.warn(`DeepSeek fallback failed (${dsErr?.response?.status || dsErr.message}). Trying ChatGPT...`);
    }
  }

  // 2. Fallback to ChatGPT (OpenAI)
  const openAiKey = (process.env.CHATGPT_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  if (openAiKey) {
    try {
      const oaModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: oaModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 100,
          temperature: 0.6
        },
        {
          headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' },
          timeout: 12000
        }
      );

      const text = res.data?.choices?.[0]?.message?.content?.trim();
      if (text) {
        settings.aiCallsCount += 1;
        settings.lastAiProviderUsed = 'CHATGPT';
        await settings.save();
        return text;
      }
    } catch (oaErr: any) {
      console.warn(`ChatGPT fallback also failed (${oaErr?.response?.status || oaErr.message}).`);
    }
  }

  // 3. Safe deterministic fallback
  return cleanOverview
    ? cleanOverview.substring(0, 240)
    : `Experience ${title} (${year}) — a ${genres.join(', ') || 'featured'} ${mediaType === 'tv' ? 'series' : 'movie'}.`;
};
