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
  53: 'Thriller',
  10752: 'War',
  37: 'Western'
};

export const mapGenreIds = (ids: number[] = []): string[] => {
  return ids.map((id) => GENRE_MAP[id]).filter(Boolean);
};

export const getMonthDateRange = (monthStr: string): { startDate: string; endDate: string } => {
  const [yearStr, monStr] = monthStr.split('-');
  const year = Number(yearStr);
  const month = Number(monStr);
  const lastDay = new Date(year, month, 0).getDate();
  const paddedMonth = String(month).padStart(2, '0');
  const paddedDay = String(lastDay).padStart(2, '0');
  return {
    startDate: `${year}-${paddedMonth}-01`,
    endDate: `${year}-${paddedMonth}-${paddedDay}`
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

export const fetchTMDBDiscover = async (
  monthStart: string,
  monthEnd: string,
  page: number = 1
): Promise<any> => {
  const token = (process.env.TMDB_API_TOKEN || process.env.TMDB_ACCESS_TOKEN || '').trim();
  if (!token) {
    console.error('TMDB_API_TOKEN is missing');
    return null;
  }

  const isBearer = token.startsWith('eyJ');
  const headers: Record<string, string> = { accept: 'application/json' };
  const params: Record<string, any> = {
    'primary_release_date.gte': monthStart,
    'primary_release_date.lte': monthEnd,
    page,
    sort_by: 'primary_release_date.desc',
    include_adult: false
  };

  if (isBearer) {
    headers.Authorization = `Bearer ${token}`;
  } else {
    params.api_key = token;
  }

  try {
    const response = await axios.get(`${TMDB_BASE_URL}/discover/movie`, {
      headers,
      params,
      timeout: 15000
    });
    return response.data;
  } catch (error: any) {
    console.error('TMDB Fetch Error:', error?.response?.status || error?.message);
    return null;
  }
};
