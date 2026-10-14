import axios from 'axios';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const GENRE_MAP: Record<number, string> = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Sci-Fi',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western',
  10759: 'Action & Adventure',
  10762: 'Kids',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics'
};

export const mapGenreIds = (ids: number[] = []): string[] => {
  return ids.map((id) => GENRE_MAP[id]).filter(Boolean);
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
  const params: Record<string, any> = { ...extraParams };

  if (isBearer) {
    headers.Authorization = `Bearer ${token}`;
  } else {
    params.api_key = token;
  }

  return { headers, params };
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
    append_to_response: 'external_ids'
  });

  try {
    const response = await axios.get(`${TMDB_BASE_URL}/${mediaType}/${tmdbId}`, {
      headers,
      params,
      timeout: 12000
    });
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
    const response = await axios.get(`${TMDB_BASE_URL}/search/multi`, {
      headers,
      params,
      timeout: 12000
    });
    const results = response.data?.results || [];
    return results.filter((r: any) => r.media_type === 'movie' || r.media_type === 'tv');
  } catch (error: any) {
    console.error('TMDB Search Error:', error?.message);
    return [];
  }
};
