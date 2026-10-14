import axios from 'axios';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

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

export const mapGenreIds = (ids: number[] = []): string[] => {
  return ids.map((id: number) => GENRE_MAP[id]).filter(Boolean);
};

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
  const headers: Record<string, string> = { accept: 'application/json' };
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

  const priorityCodes = ['hi', 'en', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa', 'es', 'fr', 'ko', 'ja'];
  const transList = details?.translations?.translations;
  if (Array.isArray(transList)) {
    for (const t of transList) {
      const code = String(t.iso_639_1 || '').toLowerCase();
      if (priorityCodes.includes(code) && LANG_NAME_MAP[code]) {
        langSet.add(LANG_NAME_MAP[code]);
      }
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
    const response = await axios.get(`${TMDB_BASE_URL}/discover/${mediaType}`, {
      headers,
      params,
      timeout: 15000
    });
    return response.data;
  } catch (error: any) {
    console.error('TMDB Discover Error:', error?.response?.status || error?.message);
    return null;
  }
};

export const fetchTMDBDetails = async (
  tmdbId: number,
  mediaType: 'movie' | 'tv' = 'movie'
): Promise<any> => {
  const { headers, params } = getAuthConfig({
    append_to_response: 'external_ids,translations'
