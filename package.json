import axios from 'axios';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const tmdbHttp = axios.create({
  baseURL: TMDB_BASE_URL,
  timeout: 12000,
  headers: { accept: 'application/json' }
});

const GENRE_MAP: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
  10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
  10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics'
};

export const LANG_NAME_MAP: Record<string, string> = {
  hi: 'Hindi', en: 'English', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada',
  bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi', gu: 'Gujarati', ur: 'Urdu', ko: 'Korean',
  ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  ru: 'Russian', pt: 'Portuguese', tr: 'Turkish', th: 'Thai', id: 'Indonesian', ar: 'Arabic'
};

export const mapGenreIds = (ids: number[] = []): string[] =>
  ids.map((id: number) => GENRE_MAP[id]).filter(Boolean);

export const getMonthDateRange = (monthStr: string): { startDate: string; endDate: string } => {
  const [yearStr, monStr] = monthStr.split('-');
  const year = Number(yearStr);
  const month = Number(monStr);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    startDate: `${year}-${String(month).padStart(2, '0')}-01`,
    endDate: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  };
};

export const getPreviousMonth = (monthStr: string): string => {
  const [yearStr, monStr] = monthStr.split('-');
  let year = Number(yearStr);
  let month = Number(monStr) - 1;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
};

const getAuthConfig = (extraParams: Record<string, any> = {}) => {
  const token = (process.env.TMDB_API_TOKEN || process.env.TMDB_ACCESS_TOKEN || '').trim();
  const isBearer = token.startsWith('eyJ');
  const headers: Record<string, string> = {};
  const params: Record<string, any> = { ...extraParams, language: 'en-US' };

  if (isBearer) {
    headers.Authorization = `Bearer ${token}`;
  } else {
    params.api_key = token;
  }
  return { headers, params };
};

export const extractAvailableLanguages = (details: any, originalLangCode: string = ''): string[] => {
  const langSet = new Set<string>();
  const origCode = String(originalLangCode || details?.original_language || '').toLowerCase();
  if (origCode && LANG_NAME_MAP[origCode]) {
    langSet.add(LANG_NAME_MAP[origCode]);
  }

  if (Array.isArray(details?.spoken_languages)) {
    for (const l of details.spoken_languages) {
      const code = String(l.iso_639_1 || '').toLowerCase();
      const name = LANG_NAME_MAP[code] || l.english_name || l.name;
      if (name) langSet.add(name);
    }
  }

  const list = Array.from(langSet);
  return list.length > 0 ? list.slice(0, 6) : ['English'];
};

export const fetchTMDBDiscover = async (
  monthStart: string,
  monthEnd: string,
  page: number = 1,
  mediaType: 'movie' | 'tv' = 'movie',
  allowedLanguages: string = 'hi|en|ta|te|ml|kn'
): Promise<any> => {
  const dateFieldGte = mediaType === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte';
  const dateFieldLte = mediaType === 'tv' ? 'first_air_date.lte' : 'primary_release_date.lte';
  const sortBy = mediaType === 'tv' ? 'first_air_date.desc' : 'primary_release_date.desc';

  const { headers, params } = getAuthConfig({
    [dateFieldGte]: monthStart,
    [dateFieldLte]: monthEnd,
    with_original_language: allowedLanguages.replace(/,/g, '|'),
    page,
    sort_by: sortBy,
    include_adult: false
  });

  try {
    const response = await tmdbHttp.get(`/discover/${mediaType}`, { headers, params });
    return response.data;
  } catch (error: any) {
    console.error('TMDB Discover Error:', error?.response?.status || error?.message);
    return null;
  }
};

// Removed heavy "translations" append to save ~85% bandwidth
export const fetchTMDBDetails = async (
  tmdbId: number,
  mediaType: 'movie' | 'tv' = 'movie'
): Promise<any> => {
  const { headers, params } = getAuthConfig({
    append_to_response: 'external_ids'
  });

  try {
    const response = await tmdbHttp.get(`/${mediaType}/${tmdbId}`, { headers, params });
    return response.data;
  } catch (error: any) {
    console.error(`TMDB Details Error (${mediaType}/${tmdbId}):`, error?.message);
    return null;
  }
};

export const searchTMDBMulti = async (query: string): Promise<any[]> => {
  const { headers, params } = getAuthConfig({
    query,
    include_adult: false,
    page: 1
  });

  try {
    const response = await tmdbHttp.get('/search/multi', { headers, params });
    const results = response.data?.results || [];
    return results.filter((r: any) => r.media_type === 'movie' || r.media_type === 'tv');
  } catch (error: any) {
    console.error('TMDB Search Error:', error?.message);
    return [];
  }
};

export const suggestCorrectTitleWithAI = async (typoQuery: string): Promise<string> => {
  const deepseekKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  const chatgptKey = (process.env.CHATGPT_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const apiKey = deepseekKey || chatgptKey;
  if (!apiKey) return '';

  const prompt = `The user typed a possibly misspelled movie or web-series title: "${typoQuery}". Return ONLY the corrected official movie/series title in plain text (nothing else, no quotes).`;

  const callAI = async (url: string, key: string, model: string) => {
    const res = await axios.post(
      url,
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 30
      },
      { headers: { Authorization: `Bearer ${key}` }, timeout: 8000 }
    );
    return String(res.data?.choices?.[0]?.message?.content || '').replace(/["']/g, '').trim();
  };

  try {
    if (deepseekKey) {
      return await callAI('https://api.deepseek.com/v1/chat/completions', deepseekKey, 'deepseek-chat');
    }
    return await callAI('https://api.openai.com/v1/chat/completions', chatgptKey, 'gpt-4o-mini');
  } catch (_e) {
    return '';
  }
};

export const enrichWithAI = async (media: any): Promise<any> => {
  const deepseekKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  const chatgptKey = (process.env.CHATGPT_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  if (!deepseekKey && !chatgptKey) return media;

  const year = media.releaseDate ? String(media.releaseDate).substring(0, 4) : 'Recent';
  const prompt = `Provide accurate English metadata for the ${
    media.mediaType === 'tv' ? 'TV Series' : 'Movie'
  } titled "${media.title}" (${year}), original language "${media.originalLanguage || 'en'}".
Return ONLY a valid JSON object:
{
  "overview": "A catchy 2-sentence English synopsis (max 200 chars)",
  "genres": ["Genre1", "Genre2"],
  "availableLanguages": ["English", "Hindi"],
  "runtime": 120,
  "seasonCount": 1,
  "imdbRating": "7.5/10",
  "rtRating": "86%"
}`;

  const callProvider = async (url: string, apiKey: string, model: string) => {
    const res = await axios.post(
      url,
      {
        model,
        messages: [
          { role: 'system', content: 'Respond with valid raw JSON only.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 260
      },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 12000 }
    );
    const content = res.data?.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  };

  let aiData: any = null;
  if (deepseekKey) {
    try {
      const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
      aiData = await callProvider(
        `${baseUrl}/v1/chat/completions`,
        deepseekKey,
        process.env.DEEPSEEK_MODEL || 'deepseek-chat'
      );
    } catch (_e) {}
  }
  if (!aiData && chatgptKey) {
    try {
      aiData = await callProvider(
        'https://api.openai.com/v1/chat/completions',
        chatgptKey,
        process.env.OPENAI_MODEL || 'gpt-4o-mini'
      );
    } catch (_e) {}
  }

  if (aiData) {
    if ((!media.overview || media.overview.length < 25) && aiData.overview) {
      media.overview = String(aiData.overview).trim();
    }
    if ((!Array.isArray(media.genres) || media.genres.length === 0) && Array.isArray(aiData.genres)) {
      media.genres = aiData.genres.map((g: any) => String(g));
    }
    if ((!Array.isArray(media.availableLanguages) || media.availableLanguages.length <= 1) && Array.isArray(aiData.availableLanguages)) {
      media.availableLanguages = aiData.availableLanguages.map((l: any) => String(l));
    }
    if (!media.runtime && Number(aiData.runtime) > 0) {
      media.runtime = Number(aiData.runtime);
    }
    if (media.mediaType === 'tv' && !media.seasonCount && Number(aiData.seasonCount) > 0) {
      media.seasonCount = Number(aiData.seasonCount);
    }
    if (!media.imdbRating && aiData.imdbRating && String(aiData.imdbRating) !== 'N/A') {
      media.imdbRating = String(aiData.imdbRating);
    }
    if (!media.rtRating && aiData.rtRating && String(aiData.rtRating) !== 'N/A') {
      media.rtRating = String(aiData.rtRating);
    }
  }
  return media;
};
