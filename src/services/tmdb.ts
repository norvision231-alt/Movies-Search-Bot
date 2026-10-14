import axios from 'axios';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_TOKEN = process.env.TMDB_API_TOKEN;

export const fetchTMDBDiscover = async (monthStart: string, monthEnd: string, page: number = 1) => {
  try {
    const response = await axios.get(`${TMDB_BASE_URL}/discover/movie`, {
      headers: {
        Authorization: `Bearer ${TMDB_TOKEN}`,
        accept: 'application/json'
      },
      params: {
        'primary_release_date.gte': monthStart,
        'primary_release_date.lte': monthEnd,
        page: page,
        sort_by: 'primary_release_date.desc'
      }
    });
    return response.data;
  } catch (error) {
    console.error("TMDB Fetch Error:", error);
    return null;
  }
};
