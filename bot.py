import os
import re
import html
import time
import asyncio
import logging
import contextlib
import difflib
from datetime import datetime, timezone
from typing import Optional, Any

from aiohttp import web, ClientSession, ClientTimeout
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, DESCENDING
from pyrogram import Client, filters, idle
from pyrogram.errors import FloodWait
from pyrogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InlineQueryResultArticle,
    InputTextMessageContent,
)

# ============================================================
# MOVIE SEARCH BOT — FINAL V17 (STANDALONE)
# ============================================================
# ONLY MOVIE / TV SEARCH. No file-store, FTP, StreamHG, Oracle.
# TMDB = source of movie/TV metadata.
# MongoDB = cache + users + settings + analytics.
# Optional AI = spelling/query correction + candidate ranking only.
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
log = logging.getLogger("movie-search-bot")

# -------------------- ENV --------------------
API_ID = int(os.getenv("API_ID", "0"))
API_HASH = os.getenv("API_HASH", "")
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
MONGO_URI = os.getenv("MONGO_URI", "")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "movie_search_bot")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))
PORT = int(os.getenv("PORT", "10000"))

TMDB_API_TOKEN = os.getenv("TMDB_API_TOKEN", "").strip()
TMDB_API_KEY = os.getenv("TMDB_API_KEY", "").strip()
TMDB_LANGUAGE = os.getenv("TMDB_LANGUAGE", "en-US").strip() or "en-US"
TMDB_REGION = os.getenv("TMDB_REGION", "IN").strip().upper() or "IN"

MOVIE_IMAGE_BASE = os.getenv(
    "TMDB_IMAGE_BASE", "https://image.tmdb.org/t/p/w500"
).rstrip("/")

CACHE_DAYS = max(1, int(os.getenv("MOVIE_CACHE_DAYS", "30")))
WATCH_CACHE_HOURS = max(1, int(os.getenv("WATCH_CACHE_HOURS", "12")))
SEARCH_LIMIT = max(3, min(int(os.getenv("MOVIE_SEARCH_LIMIT", "8")), 10))
AI_TIMEOUT = max(5, int(os.getenv("AI_TIMEOUT", "10")))

PUBLISH_CANONICAL = os.getenv("PUBLISH_CANONICAL", "1").lower() in {"1", "true", "yes", "on"}

BRAND_NAME = os.getenv("BRAND_NAME", "Your Brand").strip() or "Your Brand"
BRAND_CHANNEL_URL = os.getenv("BRAND_CHANNEL_URL", "").strip()
BRAND_BOT_URL = os.getenv("BRAND_BOT_URL", "").strip()
BRAND_INSTAGRAM_URL = os.getenv("BRAND_INSTAGRAM_URL", "").strip()

# Initial values only; admin can modify these at runtime in MongoDB.
INITIAL_JOIN_1 = os.getenv("REQUIRED_CHANNEL_1", "").strip()
INITIAL_JOIN_2 = os.getenv("REQUIRED_CHANNEL_2", "").strip()
INITIAL_JOIN_1_URL = os.getenv("REQUIRED_CHANNEL_1_URL", "").strip()
INITIAL_JOIN_2_URL = os.getenv("REQUIRED_CHANNEL_2_URL", "").strip()
INITIAL_RESULT_CHANNEL = os.getenv("RESULT_CHANNEL_ID", "").strip()

AI_PROVIDER = os.getenv("AI_PROVIDER", "auto").strip().lower()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite").strip()
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b").strip()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5-mini").strip()

SEED_ENABLED_ENV = os.getenv("SEED_ENABLED", "0").lower() in {"1", "true", "yes", "on"}
SEED_INTERVAL_MINUTES = max(5, int(os.getenv("SEED_INTERVAL_MINUTES", "5")))
SEED_BATCH_SIZE = max(1, min(int(os.getenv("SEED_BATCH_SIZE", "2")), 10))

# -------------------- APP / DB --------------------
app = Client(
    "MovieSearchBotV18",
    api_id=API_ID,
    api_hash=API_HASH,
    bot_token=BOT_TOKEN,
    workers=8,
)

mongo = AsyncIOMotorClient(
    MONGO_URI,
    maxPoolSize=30,
    serverSelectionTimeoutMS=8000,
    connectTimeoutMS=8000,
)
db = mongo[MONGO_DB_NAME]
users = db.users
movies = db.movies
settings_col = db.settings
analytics = db.analytics

# -------------------- SETTINGS --------------------
DEFAULT_SETTINGS = {
    "maintenance_mode": False,
    "movie_search_enabled": True,
    "released_enabled": True,
    "upcoming_enabled": True,
    "join_gate_enabled": bool(INITIAL_JOIN_1 or INITIAL_JOIN_2),
    "canonical_cache_enabled": True,
    "referral_enabled": True,
    "analytics_enabled": True,
    "broadcast_enabled": True,
    "seeder_enabled": SEED_ENABLED_ENV,
    "seed_interval_minutes": SEED_INTERVAL_MINUTES,
    "seed_batch_size": SEED_BATCH_SIZE,
    "seed_page": 1,
    "seed_source_index": 0,
    "watch_region": TMDB_REGION,
    "join_1": INITIAL_JOIN_1,
    "join_2": INITIAL_JOIN_2,
    "join_1_url": INITIAL_JOIN_1_URL,
    "join_2_url": INITIAL_JOIN_2_URL,
    "result_channel": INITIAL_RESULT_CHANNEL,
    "brand_name": BRAND_NAME,
    "brand_channel_url": BRAND_CHANNEL_URL,
    "brand_bot_url": BRAND_BOT_URL,
    "brand_instagram_url": BRAND_INSTAGRAM_URL,
    "publish_canonical": PUBLISH_CANONICAL,
    "seed_queue": [],
    "seed_catalog_enabled": True,
}

# Short-lived states, never intended as permanent storage.
admin_input_state: dict[int, str] = {}
suggestion_state: dict[str, dict] = {}

SEED_SOURCES = [
    ("movie_popular", "/movie/popular", "movie"),
    ("movie_top_rated", "/movie/top_rated", "movie"),
    ("movie_now_playing", "/movie/now_playing", "movie"),
    ("movie_upcoming", "/movie/upcoming", "movie"),
    ("tv_popular", "/tv/popular", "tv"),
    ("trending_movie", "/trending/movie/week", "movie"),
    ("trending_tv", "/trending/tv/week", "tv"),
]

# -------------------- GENERAL HELPERS --------------------
def now_ts() -> int:
    return int(time.time())


def esc(value: Any) -> str:
    return html.escape(str(value or ""))


def slugify(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value or "movie").strip("-").lower()
    return value or "movie"


def norm_query(value: str) -> str:
    value = (value or "").lower().strip()
    # Preserve years because they are useful for disambiguation.
    value = re.sub(r"\b(?:movie|film|series|web\s*series|season|episode|ep)\b", " ", value)
    value = re.sub(r"[^\w\s]", " ", value, flags=re.UNICODE)
    return re.sub(r"\s+", " ", value).strip()


def title_of(item: dict, media_type: Optional[str] = None) -> str:
    mt = media_type or item.get("media_type")
    if mt == "movie":
        return item.get("title") or item.get("original_title") or "Unknown"
    return item.get("name") or item.get("original_name") or "Unknown"


def release_of(item: dict, media_type: Optional[str] = None) -> str:
    mt = media_type or item.get("media_type")
    return (item.get("release_date") if mt == "movie" else item.get("first_air_date")) or ""


def is_released(item: dict) -> bool:
    date = release_of(item)
    return bool(date and date <= datetime.now(timezone.utc).strftime("%Y-%m-%d"))


def is_upcoming(item: dict) -> bool:
    date = release_of(item)
    return bool(date and date > datetime.now(timezone.utc).strftime("%Y-%m-%d"))


def is_admin(uid: int) -> bool:
    return int(uid) == ADMIN_ID


def safe_text(value: str, limit: int = 500) -> str:
    value = re.sub(r"\s+", " ", value or "").strip()
    return value[:limit]


async def get_settings() -> dict:
    doc = await settings_col.find_one({"_id": "global"})
    if not doc:
        base = {"_id": "global", **DEFAULT_SETTINGS}
        with contextlib.suppress(Exception):
            await settings_col.insert_one(base)
        return dict(DEFAULT_SETTINGS)
    out = dict(DEFAULT_SETTINGS)
    out.update(doc)
    return out


async def set_setting(key: str, value: Any) -> None:
    await settings_col.update_one(
        {"_id": "global"}, {"$set": {key: value}}, upsert=True
    )


async def bump(event: str, n: int = 1) -> None:
    s = await get_settings()
    if not s.get("analytics_enabled", True):
        return
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with contextlib.suppress(Exception):
        await analytics.update_one(
            {"_id": day},
            {"$inc": {event: n}, "$set": {"updated_at": now_ts()}},
            upsert=True,
        )


async def ensure_user(user) -> dict:
    uid = int(user.id)
    doc = await users.find_one({"_id": uid})
    if doc:
        await users.update_one(
            {"_id": uid},
            {
                "$set": {
                    "username": user.username,
                    "first_name": user.first_name,
                    "last_name": user.last_name,
                    "updated_at": now_ts(),
                }
            },
        )
        return doc
    doc = {
        "_id": uid,
        "username": user.username,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "banned": False,
        "points": 0,
        "referrals": 0,
        "created_at": now_ts(),
        "updated_at": now_ts(),
    }
    with contextlib.suppress(Exception):
        await users.insert_one(doc)
    with contextlib.suppress(Exception):
        await bump("new_users")
    return await users.find_one({"_id": uid}) or doc


async def is_banned(uid: int) -> bool:
    doc = await users.find_one({"_id": int(uid)}, {"banned": 1})
    return bool(doc and doc.get("banned"))


# ============================================================
# TMDB
# ============================================================
TMDB_BASE = "https://api.themoviedb.org/3"


def tmdb_headers() -> dict:
    headers = {"accept": "application/json"}
    if TMDB_API_TOKEN:
        headers["Authorization"] = f"Bearer {TMDB_API_TOKEN}"
    return headers


async def tmdb_get(path: str, params: Optional[dict] = None) -> dict:
    if not (TMDB_API_TOKEN or TMDB_API_KEY):
        raise RuntimeError("TMDB credential is not configured.")
    query = dict(params or {})
    if not TMDB_API_TOKEN:
        query["api_key"] = TMDB_API_KEY
    timeout = ClientTimeout(total=20)
    async with ClientSession(timeout=timeout) as session:
        async with session.get(
            f"{TMDB_BASE}{path}", headers=tmdb_headers(), params=query
        ) as resp:
            body = await resp.text()
            if resp.status == 401:
                raise RuntimeError("TMDB_AUTH_ERROR: invalid or inactive API credential.")
            if resp.status == 403:
                raise RuntimeError("TMDB_FORBIDDEN: API access was refused.")
            if resp.status == 429:
                raise RuntimeError("TMDB_RATE_LIMIT")
            if resp.status >= 500:
                raise RuntimeError(f"TMDB_SERVER_ERROR:{resp.status}")
            if resp.status >= 400:
                raise RuntimeError(f"TMDB_HTTP_ERROR:{resp.status}:{body[:250]}")
            return await resp.json()


async def tmdb_search(query: str) -> list[dict]:
    data = await tmdb_get(
        "/search/multi",
        {
            "query": query,
            "include_adult": "false",
            "language": TMDB_LANGUAGE,
            "region": TMDB_REGION,
            "page": 1,
        },
    )
    out = []
    for item in data.get("results", []):
        if item.get("media_type") in {"movie", "tv"} and item.get("id"):
            out.append(item)
    return out[:SEARCH_LIMIT]


async def tmdb_details(media_type: str, tmdb_id: int) -> dict:
    return await tmdb_get(
        f"/{media_type}/{int(tmdb_id)}",
        {
            "language": TMDB_LANGUAGE,
            "append_to_response": "credits,videos,external_ids",
        },
    )


async def tmdb_watch_providers(media_type: str, tmdb_id: int, region: str) -> dict:
    return await tmdb_get(
        f"/{media_type}/{int(tmdb_id)}/watch/providers",
        {"language": TMDB_LANGUAGE},
    )


async def seed_catalog_page(source: tuple[str, str, str], page: int, region: str) -> list[dict]:
    _name, endpoint, expected_type = source
    params = {"language": TMDB_LANGUAGE, "page": max(1, page)}
    if endpoint in {"/movie/now_playing", "/movie/upcoming"}:
        params["region"] = region
    data = await tmdb_get(endpoint, params)
    out = []
    for item in data.get("results", []):
        mt = item.get("media_type") or expected_type
        if mt not in {"movie", "tv"}:
            mt = expected_type
        item["media_type"] = mt
        if item.get("id"):
            out.append(item)
    return out


# ============================================================
# AI SEARCH ASSIST — optional fallback only
# ============================================================
async def ai_chat(prompt: str) -> Optional[str]:
    providers = []
    if AI_PROVIDER in {"auto", "gemini"} and GEMINI_API_KEY:
        providers.append("gemini")
    if AI_PROVIDER in {"auto", "groq"} and GROQ_API_KEY:
        providers.append("groq")
    if AI_PROVIDER in {"auto", "openai"} and OPENAI_API_KEY:
        providers.append("openai")
    if AI_PROVIDER == "none":
        return None

    timeout = ClientTimeout(total=AI_TIMEOUT)
    for provider in providers:
        try:
            async with ClientSession(timeout=timeout) as session:
                if provider == "gemini":
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
                    payload = {
                        "contents": [{"parts": [{"text": prompt}]}],
                        "generationConfig": {
                            "temperature": 0,
                            "maxOutputTokens": 180,
                        },
                    }
                    async with session.post(
                        url, params={"key": GEMINI_API_KEY}, json=payload
                    ) as resp:
                        if resp.status in {429, 500, 502, 503, 504}:
                            continue
                        if resp.status >= 400:
                            continue
                        data = await resp.json()
                        parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
                        return parts[0].get("text") if parts else None

                elif provider == "groq":
                    payload = {
                        "model": GROQ_MODEL,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": 0,
                        "max_tokens": 180,
                    }
                    async with session.post(
                        "https://api.groq.com/openai/v1/chat/completions",
                        headers={
                            "Authorization": f"Bearer {GROQ_API_KEY}",
                            "Content-Type": "application/json",
                        },
                        json=payload,
                    ) as resp:
                        if resp.status in {429, 500, 502, 503, 504}:
                            continue
                        if resp.status >= 400:
                            continue
                        data = await resp.json()
                        return (((data.get("choices") or [{}])[0].get("message") or {}).get("content"))

                else:
                    payload = {
                        "model": OPENAI_MODEL,
                        "input": prompt,
                        "temperature": 0,
                        "max_output_tokens": 180,
                    }
                    async with session.post(
                        "https://api.openai.com/v1/responses",
                        headers={
                            "Authorization": f"Bearer {OPENAI_API_KEY}",
                            "Content-Type": "application/json",
                        },
                        json=payload,
                    ) as resp:
                        if resp.status in {429, 500, 502, 503, 504}:
                            continue
                        if resp.status >= 400:
                            continue
                        data = await resp.json()
                        if data.get("output_text"):
                            return data["output_text"]
                        chunks = []
                        for item in data.get("output", []):
                            for content in item.get("content", []):
                                if content.get("type") == "output_text":
                                    chunks.append(content.get("text", ""))
                        return "\n".join(chunks).strip() or None
        except Exception:
            log.exception("AI provider %s failed", provider)
    return None


def heuristic_score(query: str, candidate: dict) -> float:
    q = norm_query(query)
    t = norm_query(title_of(candidate))
    if not q or not t:
        return 0.0
    direct = difflib.SequenceMatcher(None, q, t).ratio()
    q_words = set(q.split())
    t_words = set(t.split())
    overlap = len(q_words & t_words) / max(1, len(q_words))
    prefix = 1.0 if t.startswith(q) or q.startswith(t) else 0.0
    return min(1.0, direct * 0.60 + overlap * 0.30 + prefix * 0.10)


async def rank_candidates(query: str, candidates: list[dict]) -> list[int]:
    if not candidates:
        return []
    scored = sorted(
        [(heuristic_score(query, c), idx + 1) for idx, c in enumerate(candidates)],
        reverse=True,
    )
    # Clear winner: avoid any AI request.
    if scored and (scored[0][0] >= 0.90 or (scored[0][0] >= 0.84 and scored[0][0] - scored[1][0] >= 0.10 if len(scored) > 1 else True)):
        return [idx for _score, idx in scored]

    lines = []
    for i, c in enumerate(candidates[:SEARCH_LIMIT], 1):
        mt = c.get("media_type")
        lines.append(
            f"{i}. {title_of(c, mt)} | {release_of(c, mt) or 'N/A'} | {mt} | id={c.get('id')}"
        )
    prompt = (
        "You rank movie/TV search candidates. The user may have typos, transliteration, "
        "missing words, season/year hints, or spelling errors. Rank only the supplied candidates. "
        "Return ONLY comma-separated candidate numbers, best first. Do not invent anything.\n"
        f"USER: {query}\nCANDIDATES:\n" + "\n".join(lines)
    )
    text = await ai_chat(prompt)
    if text:
        nums = []
        seen = set()
        for n in re.findall(r"\b\d+\b", text):
            i = int(n)
            if 1 <= i <= len(candidates) and i not in seen:
                seen.add(i)
                nums.append(i)
        if nums:
            return nums
    return [idx for _score, idx in scored]


async def corrected_query(query: str) -> Optional[str]:
    prompt = (
        "You are a movie and TV search correction assistant. Correct only the user's search phrase. "
        "Handle typos, misspellings, transliteration, missing spaces, year hints and season hints. "
        "Do not invent a title. Return ONLY the corrected movie/TV title. "
        "If you cannot confidently identify a likely title, return exactly NO_CONFIDENT_MATCH.\n"
        f"USER QUERY: {query}"
    )
    result = await ai_chat(prompt)
    if not result:
        return None
    result = result.strip().strip('"\'')
    if result.upper() == "NO_CONFIDENT_MATCH":
        return None
    return safe_text(result, 160) if result else None


def google_spell_url(text: str) -> str:
    from urllib.parse import quote_plus
    return "https://www.google.com/search?q=" + quote_plus(f"{text} correct spelling movie")



# ============================================================
# WATCH / DETAILS / OUTPUT
# ============================================================
def trailer_url(details: dict) -> Optional[str]:
    videos = ((details.get("videos") or {}).get("results") or [])
    candidates = [
        x for x in videos
        if x.get("site") == "YouTube"
        and x.get("type") in {"Trailer", "Teaser"}
        and x.get("key")
    ]
    candidates.sort(key=lambda x: (x.get("official") is not True, x.get("published_at") or ""))
    return f"https://www.youtube.com/watch?v={candidates[0]['key']}" if candidates else None


def director(details: dict) -> Optional[str]:
    for person in ((details.get("credits") or {}).get("crew") or []):
        if person.get("job") == "Director" and person.get("name"):
            return person["name"]
    return None


def top_cast(details: dict, limit: int = 5) -> list[str]:
    return [
        x.get("name")
        for x in ((details.get("credits") or {}).get("cast") or [])[:limit]
        if x.get("name")
    ]


def provider_names(provider_doc: dict, region: str) -> tuple[list[str], Optional[str]]:
    """Return only free/ad-supported providers and one regional link when free is available."""
    region_data = (provider_doc.get("results") or {}).get(region) or {}
    names = []
    seen = set()
    for bucket in ("free", "ads"):
        for provider in region_data.get(bucket) or []:
            name = provider.get("provider_name")
            if name and name not in seen:
                seen.add(name)
                names.append(name)
    return names[:6], (region_data.get("link") if names else None)


def watch_page_url(media_type: str, tmdb_id: int) -> str:
    return f"https://www.themoviedb.org/{media_type}/{int(tmdb_id)}/watch"


def wrap_overview(text: str, max_lines: int = 5, width: int = 60) -> str:
    words = re.findall(r"\S+", text or "")
    lines = []
    current = ""
    for word in words:
        if len(current) + len(word) + (1 if current else 0) <= width:
            current = f"{current} {word}".strip()
        else:
            if current:
                lines.append(current)
            current = word
            if len(lines) >= max_lines:
                break
    if len(lines) < max_lines and current:
        lines.append(current)
    return "\n".join(lines[:max_lines])


def brand_button_rows(settings: dict) -> list[list[InlineKeyboardButton]]:
    items = []
    if str(settings.get("brand_channel_url") or "").strip():
        items.append(("📢 TELEGRAM", settings.get("brand_channel_url")))
    if str(settings.get("brand_bot_url") or "").strip():
        items.append(("🤖 TELEGRAM BOT", settings.get("brand_bot_url")))
    if str(settings.get("brand_instagram_url") or "").strip():
        items.append(("📸 INSTAGRAM", settings.get("brand_instagram_url")))
    rows = []
    for i in range(0, len(items), 2):
        row = [InlineKeyboardButton(items[i][0], url=str(items[i][1]))]
        if i + 1 < len(items):
            row.append(InlineKeyboardButton(items[i + 1][0], url=str(items[i + 1][1])))
        rows.append(row)
    return rows


def format_caption(details: dict, mt: str, providers: Optional[list[str]] = None, region: str = "IN", settings: Optional[dict] = None) -> str:
    settings = settings or {}
    title = title_of(details, mt)
    original = details.get("original_title") if mt == "movie" else details.get("original_name")
    rating = details.get("vote_average")
    rating_text = f"{float(rating):.1f}/10" if isinstance(rating, (int, float)) else "N/A"
    langs = [x.get("english_name") or x.get("iso_639_1") for x in (details.get("spoken_languages") or []) if x.get("english_name") or x.get("iso_639_1")]
    lang_text = ", ".join(langs) or details.get("original_language") or "N/A"
    genres = " • ".join(x.get("name") for x in (details.get("genres") or []) if x.get("name")) or "N/A"
    countries = ", ".join(x.get("name") for x in (details.get("production_countries") or []) if x.get("name")) or "N/A"
    release = release_of(details, mt) or "N/A"
    lines = [
        f"🔥 <b>{esc(title)}</b>", "",
        f"⭐ <b>TMDB:</b> {rating_text}",
        f"🌐 <b>Language:</b> {esc(lang_text)}",
        f"🎭 <b>Genre:</b> {esc(genres)}",
    ]
    if mt == "movie":
        lines.extend([f"⏱️ <b>Runtime:</b> {details.get('runtime') or 'N/A'} min", f"📅 <b>Release:</b> {esc(release)}"])
    else:
        lines.extend([f"📺 <b>Seasons:</b> {details.get('number_of_seasons') or 'N/A'}", f"⏱️ <b>Episodes:</b> {details.get('number_of_episodes') or 'N/A'}", f"📅 <b>First Air:</b> {esc(release)}"])
    lines.append(f"🌍 <b>Country:</b> {esc(countries)}")
    if original and original != title:
        lines.append(f"📝 <b>Original:</b> {esc(original)}")
    d = director(details)
    if d:
        lines.append(f"🎬 <b>Director:</b> {esc(d)}")
    cs = top_cast(details)
    if cs:
        lines.append(f"👥 <b>Cast:</b> {esc(', '.join(cs))}")
    overview = wrap_overview(details.get("overview") or "No description available.", max_lines=5, width=62)
    lines.extend(["", "📖 <b>Overview:</b>", esc(overview)])
    if providers:
        lines.extend(["", f"🆓 <b>Free to watch in {esc(region)}:</b> {esc(' • '.join(providers))}"])
    lines.extend(["", "━━━━━━━━━━━━━━", f"<b>{esc(settings.get('brand_name') or BRAND_NAME)}</b>"])
    return "\n".join(lines)[:4096]


async def movie_keyboard(details: dict, mt: str, settings: Optional[dict] = None, watch_link: Optional[str] = None) -> InlineKeyboardMarkup:
    settings = settings or await get_settings()
    rows = []
    if watch_link:
        rows.append([InlineKeyboardButton("🆓 WHERE TO WATCH FREE", url=watch_link)])
    rows.extend(brand_button_rows(settings))
    return InlineKeyboardMarkup(rows)


# ============================================================
# CACHE + CANONICAL CHANNEL
# ============================================================
async def get_watch_data(mt: str, tmdb_id: int, region: str, force: bool = False) -> tuple[list[str], Optional[str]]:
    if not force:
        existing = await movies.find_one({"_id": f"{mt}:{int(tmdb_id)}"}, {"watch_providers": 1, "watch_link": 1, "watch_region": 1, "watch_fetched_at": 1})
        if existing:
            fetched = int(existing.get("watch_fetched_at", 0) or 0)
            if existing.get("watch_region") == region and now_ts() - fetched <= WATCH_CACHE_HOURS * 3600:
                return list(existing.get("watch_providers") or []), existing.get("watch_link")
    try:
        provider_doc = await tmdb_watch_providers(mt, tmdb_id, region)
        names, link = provider_names(provider_doc, region)
    except Exception as exc:
        log.warning("watch provider lookup failed %s:%s: %s", mt, tmdb_id, exc)
        names, link = [], None
    await movies.update_one({"_id": f"{mt}:{int(tmdb_id)}"}, {"$set": {"watch_providers": names, "watch_link": link, "watch_region": region, "watch_fetched_at": now_ts()}}, upsert=True)
    return names, link


async def publish_canonical(details: dict, mt: str, caption: str, settings: dict, watch_link: Optional[str]) -> tuple[Optional[str], Optional[int], Optional[str]]:
    if not settings.get("canonical_cache_enabled", True):
        return None, None, None
    target = str(settings.get("result_channel") or "").strip()
    if not target:
        return None, None, "RESULT_CHANNEL_NOT_SET"
    try:
        chat = await app.get_chat(target)
        markup = await movie_keyboard(details, mt, settings, watch_link)
        poster = details.get("poster_path")
        if poster:
            msg = await app.send_photo(chat.id, photo=f"{MOVIE_IMAGE_BASE}{poster}", caption=caption[:1024], reply_markup=markup)
        else:
            msg = await app.send_message(chat.id, caption[:4096], reply_markup=markup)
        log.info("CANONICAL_PUBLISH_OK channel=%s msg=%s title=%s", chat.id, msg.id, title_of(details, mt))
        return str(chat.id), int(msg.id), None
    except Exception as exc:
        error = f"{type(exc).__name__}: {str(exc)[:220]}"
        log.error("CANONICAL_PUBLISH_FAIL target=%s error=%s", target, error)
        return None, None, error


async def cache_details(details: dict, mt: str, *, force_watch: bool = False, publish: bool = True) -> dict:
    settings = await get_settings()
    region = (settings.get("watch_region") or TMDB_REGION).upper()
    providers, watch_link = await get_watch_data(mt, int(details["id"]), region, force=force_watch)
    caption = format_caption(details, mt, providers, region, settings)
    doc_id = f"{mt}:{int(details['id'])}"
    old = await movies.find_one({"_id": doc_id}, {"canonical_message_id": 1})
    canonical_id = old.get("canonical_message_id") if old else None

    canonical_chat_id = old.get("canonical_chat_id") if old else None
    canonical_error = None
    if publish and not canonical_id:
        canonical_chat_id, canonical_id, canonical_error = await publish_canonical(details, mt, caption, settings, watch_link)

    title = title_of(details, mt)
    original = details.get("original_title") if mt == "movie" else details.get("original_name")
    aliases = {norm_query(title), norm_query(original or "")}
    aliases.discard("")
    now = now_ts()

    doc = {
        "_id": doc_id,
        "tmdb_id": int(details["id"]),
        "media_type": mt,
        "title": title,
        "normalized_title": norm_query(title),
        "aliases": sorted(aliases),
        "original_title": original,
        "poster_path": details.get("poster_path"),
        "release_date": release_of(details, mt),
        "tmdb_rating": details.get("vote_average"),
        "caption": caption,
        "details": details,
        "canonical_message_id": canonical_id,
        "canonical_chat_id": canonical_chat_id,
        "canonical_publish_error": canonical_error,
        "watch_providers": providers,
        "watch_link": watch_link,
        "watch_region": region,
        "watch_fetched_at": now,
        "updated_at": now,
        "created_at": old.get("created_at", now) if old else now,
    }
    await movies.update_one({"_id": doc_id}, {"$set": doc}, upsert=True)
    return doc


async def find_cached(query: str, mode: str = "search") -> Optional[dict]:
    n = norm_query(query)
    if not n or mode != "search":
        return None
    doc = await movies.find_one({"$or": [{"aliases": n}, {"normalized_title": n}]})
    if not doc:
        return None
    if now_ts() - int(doc.get("updated_at", 0) or 0) > CACHE_DAYS * 86400:
        return None
    return doc


async def ensure_canonical_for_doc(doc: dict) -> dict:
    """Retry canonical channel publish when an earlier attempt failed or channel was configured later."""
    settings = await get_settings()
    if not settings.get("canonical_cache_enabled", True):
        return doc
    if doc.get("canonical_message_id") and doc.get("canonical_chat_id"):
        return doc
    details = doc.get("details") or {}
    mt = doc.get("media_type") or "movie"
    if not details.get("id"):
        return doc
    refreshed = await cache_details(details, mt, publish=True)
    return refreshed


async def send_cached(uid: int, doc: dict) -> None:
    settings = await get_settings()
    with contextlib.suppress(Exception):
        doc = await ensure_canonical_for_doc(doc)
    canonical = doc.get("canonical_message_id")
    canonical_chat = doc.get("canonical_chat_id")
    if canonical and canonical_chat:
        try:
            await app.copy_message(uid, str(canonical_chat), int(canonical))
            await bump("cache_hits")
            return
        except Exception:
            log.exception("canonical copy failed; falling back to cached metadata")
    details = doc.get("details") or {}
    mt = doc.get("media_type") or "movie"
    markup = await movie_keyboard(details, mt, settings, doc.get("watch_link"))
    poster = doc.get("poster_path")
    if poster:
        try:
            await app.send_photo(uid, f"{MOVIE_IMAGE_BASE}{poster}", caption=(doc.get("caption") or "Movie found.")[:1024], reply_markup=markup)
            return
        except Exception:
            log.exception("cached poster send failed")
    await app.send_message(uid, doc.get("caption", "Movie found."), reply_markup=markup)


# ============================================================
# JOIN GATE / PROMO / MENUS
# ============================================================
async def joined(uid: int, channel: str) -> bool:
    channel = str(channel or "").strip()
    if not channel:
        return True
    try:
        member = await app.get_chat_member(channel, uid)
        return member.status in {"owner", "administrator", "member", "restricted"}
    except Exception as exc:
        log.warning("join check failed for %s: %s", channel, exc)
        return False


async def join_ok(uid: int) -> bool:
    s = await get_settings()
    if not s.get("join_gate_enabled", False):
        return True
    channels = [str(s.get("join_1") or "").strip(), str(s.get("join_2") or "").strip()]
    channels = [x for x in channels if x]
    if not channels:
        return True
    for ch in channels:
        if not await joined(uid, ch):
            return False
    return True


def join_keyboard(settings: dict) -> InlineKeyboardMarkup:
    rows = []
    if settings.get("join_1_url"):
        rows.append([InlineKeyboardButton("🔗 JOIN CHANNEL 01", url=str(settings["join_1_url"]))])
    if settings.get("join_2_url"):
        rows.append([InlineKeyboardButton("🔗 JOIN CHANNEL 02", url=str(settings["join_2_url"]))])
    rows.append([InlineKeyboardButton("✅ I'VE JOINED", callback_data="verify_join")])
    return InlineKeyboardMarkup(rows)


def home_keyboard(settings: dict) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton("🔎 SEARCH MOVIE", callback_data="search_help")],
        [InlineKeyboardButton("🆕 UPCOMING", callback_data="upcoming_help"), InlineKeyboardButton("✅ RELEASED", callback_data="released_help")],
        [InlineKeyboardButton("💎 REFERRAL", callback_data="referral"), InlineKeyboardButton("🤖 BOT STATUS", callback_data="status")],
    ]
    rows.extend(brand_button_rows(settings))
    rows.append([InlineKeyboardButton("ℹ️ CREDITS", callback_data="credits")])
    return InlineKeyboardMarkup(rows)


# ============================================================
# ADMIN PANEL
# ============================================================
def toggle_button(settings: dict, key: str, label: str) -> InlineKeyboardButton:
    icon = "🟢" if settings.get(key, False) else "🔴"
    return InlineKeyboardButton(f"{icon} {label}", callback_data=f"toggle:{key}")


def admin_keyboard(settings: dict) -> InlineKeyboardMarkup:
    rows = [
        [toggle_button(settings, "movie_search_enabled", "Search"), toggle_button(settings, "released_enabled", "Released")],
        [toggle_button(settings, "upcoming_enabled", "Upcoming"), toggle_button(settings, "join_gate_enabled", "Join Gate")],
        [toggle_button(settings, "canonical_cache_enabled", "Channel Cache"), toggle_button(settings, "referral_enabled", "Referral")],
        [toggle_button(settings, "analytics_enabled", "Analytics"), toggle_button(settings, "broadcast_enabled", "Broadcast")],
        [toggle_button(settings, "seeder_enabled", "Auto Seeder"), toggle_button(settings, "maintenance_mode", "Maintenance")],
        [toggle_button(settings, "seed_catalog_enabled", "Catalog Seed")],
        [InlineKeyboardButton("⚙️ CHANNELS / BRANDING", callback_data="admin_links")],
        [InlineKeyboardButton("🌱 SEEDER", callback_data="admin_seeder"), InlineKeyboardButton("📊 ANALYTICS", callback_data="admin_analytics")],
        [InlineKeyboardButton("👥 USERS", callback_data="admin_users"), InlineKeyboardButton("📁 CACHE", callback_data="admin_cache")],
        [InlineKeyboardButton("📢 BROADCAST", callback_data="admin_broadcast")],
    ]
    return InlineKeyboardMarkup(rows)


async def admin_panel_text(settings: dict) -> str:
    result_channel = settings.get("result_channel") or "Not set"
    return (
        "👑 <b>MASTER MOVIE ADMIN</b>\n\n"
        f"🔎 Search: {'ON' if settings.get('movie_search_enabled') else 'OFF'}\n"
        f"🆕 Upcoming: {'ON' if settings.get('upcoming_enabled') else 'OFF'}\n"
        f"✅ Released: {'ON' if settings.get('released_enabled') else 'OFF'}\n"
        f"🔐 Join Gate: {'ON' if settings.get('join_gate_enabled') else 'OFF'}\n"
        f"💾 Cache: {'ON' if settings.get('canonical_cache_enabled') else 'OFF'}\n"
        f"🌱 Auto Seeder: {'ON' if settings.get('seeder_enabled') else 'OFF'}\n"
        f"🛠 Maintenance: {'ON' if settings.get('maintenance_mode') else 'OFF'}\n\n"
        f"🌍 Watch Region: <b>{esc(settings.get('watch_region') or TMDB_REGION)}</b>\n"
        f"📺 Result Channel: <code>{esc(result_channel)}</code>\n"
        f"🏷️ Brand: <b>{esc(settings.get('brand_name') or BRAND_NAME)}</b>\n\n"
        "Use the buttons below to change settings without redeploying."
    )


async def maintenance_block(message) -> bool:
    s = await get_settings()
    if s.get("maintenance_mode") and not is_admin(message.from_user.id):
        await message.reply_text(
            "🛠 <b>Bot Maintenance</b>\n\n"
            "The Movie Search Bot is temporarily under maintenance.\n"
            "Please try again later."
        )
        return True
    return False


# ============================================================
# SEARCH CORE
# ============================================================
async def process_search(message, query: str, mode: str = "search"):
    uid = int(message.from_user.id)
    if await is_banned(uid) and not is_admin(uid):
        return await message.reply_text("🚫 You are banned from this bot.")
    s = await get_settings()
    if mode == "search" and not s.get("movie_search_enabled", True):
        return await message.reply_text("❌ Movie Search is disabled by admin.")
    if mode == "released" and not s.get("released_enabled", True):
        return await message.reply_text("❌ Released search is disabled.")
    if mode == "upcoming" and not s.get("upcoming_enabled", True):
        return await message.reply_text("❌ Upcoming search is disabled.")
    if await maintenance_block(message):
        return
    if not await join_ok(uid):
        return await message.reply_text("🔐 <b>Join required channel(s) first.</b>", reply_markup=join_keyboard(s))
    query = (query or "").strip()
    if not query:
        return await message.reply_text("Usage: <code>/search movie name</code>")
    cached = await find_cached(query, mode)
    if cached:
        await bump("searches")
        return await send_cached(uid, cached)
    status = await message.reply_text("🔎 <b>Searching…</b>")
    try:
        results = await tmdb_search(query)
        if mode == "released":
            results = [x for x in results if is_released(x)]
        elif mode == "upcoming":
            results = [x for x in results if is_upcoming(x)]
        fixed = None
        if not results:
            fixed = await corrected_query(query)
            if fixed and norm_query(fixed) != norm_query(query):
                results = await tmdb_search(fixed)
                if mode == "released":
                    results = [x for x in results if is_released(x)]
                elif mode == "upcoming":
                    results = [x for x in results if is_upcoming(x)]
        if not results:
            suggestion = fixed or query
            token = f"{uid}_{int(time.time()*1000)}"
            suggestion_state[token] = {"uid": uid, "text": suggestion, "expires": now_ts() + 600}
            google = "https://www.google.com/search?q=" + __import__("urllib.parse", fromlist=["quote"]).quote(suggestion)
            return await status.edit_text(
                "❌ <b>No matching title found.</b>\n\n"
                f"💡 <b>Suggested spelling:</b> <code>{esc(suggestion)}</code>\n\n"
                "Choose one:",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("✅ SEARCH SUGGESTION", callback_data=f"suggest:{token}")],
                    [InlineKeyboardButton("🔎 GOOGLE — CHECK SPELLING", url=google)],
                ]),
            )
        order = await rank_candidates(query, results)
        ordered = [results[i-1] for i in order if 1 <= i <= len(results)] or results
        top_score = heuristic_score(query, ordered[0])
        second_score = heuristic_score(query, ordered[1]) if len(ordered) > 1 else 0.0
        confident = len(ordered) == 1 or (top_score >= 0.93 and top_score - second_score >= 0.14)
        if confident:
            item = ordered[0]
            details = await tmdb_details(item["media_type"], int(item["id"]))
            doc = await cache_details(details, item["media_type"], publish=True)
            with contextlib.suppress(Exception):
                await status.delete()
            await send_cached(uid, doc)
            await bump("searches")
            return
        rows = []
        for item in ordered[:SEARCH_LIMIT]:
            mt = item.get("media_type")
            date = release_of(item, mt) or "----"
            icon = "🎬" if mt == "movie" else "📺"
            label = f"{icon} {title_of(item, mt)[:42]} ({date[:4] or '----'})"
            rows.append([InlineKeyboardButton(label, callback_data=f"pick:{mt}:{int(item['id'])}")])
        rows.append([InlineKeyboardButton("❌ Close", callback_data="close")])
        await status.edit_text("🎯 <b>Which title did you mean?</b>\n\nSelect the correct one:", reply_markup=InlineKeyboardMarkup(rows))
        await bump("searches")
    except Exception as exc:
        log.exception("search failed")
        message_text = str(exc)
        if "TMDB_AUTH_ERROR" in message_text:
            message_text = "TMDB credential invalid. Check TMDB_API_TOKEN/TMDB_API_KEY in Render Environment."
        elif "TMDB_RATE_LIMIT" in message_text:
            message_text = "TMDB rate limit reached. Please try again shortly."
        await status.edit_text(f"❌ Search failed.\n\n<code>{esc(message_text)[:900]}</code>")


# ============================================================
# SEEDER — automatic database preparation
# ============================================================
async def seed_specific_query(query: str, settings: Optional[dict] = None) -> int:
    query = (query or "").strip()
    if not query:
        return 0
    settings = settings or await get_settings()
    try:
        results = await tmdb_search(query)
        order = await rank_candidates(query, results)
        if order:
            results = [results[i - 1] for i in order if 1 <= i <= len(results)]
        if not results:
            return 0
        # Store the best candidate only from a seed query.
        item = results[0]
        details = await tmdb_details(item["media_type"], int(item["id"]))
        await cache_details(details, item["media_type"], publish=True)
        await bump("seeded_titles")
        return 1
    except Exception as exc:
        log.warning("seed query failed %r: %s", query, exc)
        return 0


async def seed_once() -> dict:
    settings = await get_settings()
    if not settings.get("seeder_enabled", False):
        return {"seeded": 0, "reason": "disabled"}

    seeded = 0
    errors = 0
    batch = int(settings.get("seed_batch_size", SEED_BATCH_SIZE) or SEED_BATCH_SIZE)

    # Priority: manually queued search terms.
    queue = list(settings.get("seed_queue") or [])
    if queue:
        remaining = []
        for query in queue[:batch]:
            count = await seed_specific_query(query, settings)
            if count:
                seeded += count
            else:
                errors += 1
        remaining.extend(queue[batch:])
        await set_setting("seed_queue", remaining)
        return {"seeded": seeded, "errors": errors, "mode": "queries"}

    if not settings.get("seed_catalog_enabled", True):
        return {"seeded": 0, "reason": "catalog disabled"}

    source_index = int(settings.get("seed_source_index", 0)) % len(SEED_SOURCES)
    page = max(1, int(settings.get("seed_page", 1) or 1))
    source = SEED_SOURCES[source_index]
    region = str(settings.get("watch_region") or TMDB_REGION).upper()

    try:
        candidates = await seed_catalog_page(source, page, region)
        # Only process titles that do not already exist.
        fresh = []
        for item in candidates:
            mt = item.get("media_type") or source[2]
            doc_id = f"{mt}:{int(item['id'])}"
            exists = await movies.find_one({"_id": doc_id}, {"_id": 1, "canonical_message_id": 1})
            if not exists or not exists.get("canonical_message_id"):
                fresh.append(item)
            if len(fresh) >= batch:
                break

        for item in fresh:
            try:
                details = await tmdb_details(item["media_type"], int(item["id"]))
                await cache_details(details, item["media_type"], publish=True)
                seeded += 1
                await bump("seeded_titles")
            except Exception as exc:
                errors += 1
                log.warning("seed detail failed: %s", exc)

        # Rotate page; after a reasonable page cycle, move to another source.
        total_pages = 20
        if page >= total_pages:
            next_page = 1
            next_source = (source_index + 1) % len(SEED_SOURCES)
        else:
            next_page = page + 1
            next_source = source_index
        await set_setting("seed_page", next_page)
        await set_setting("seed_source_index", next_source)
        return {
            "seeded": seeded,
            "errors": errors,
            "mode": source[0],
            "page": page,
        }
    except Exception as exc:
        log.warning("catalog seeder failed: %s", exc)
        return {"seeded": seeded, "errors": errors + 1, "reason": str(exc)[:160]}


async def seeder_loop(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            settings = await get_settings()
            if settings.get("seeder_enabled", False):
                result = await seed_once()
                if result.get("seeded") or result.get("errors"):
                    log.info("Seeder: %s", result)
            interval = max(5, int((await get_settings()).get("seed_interval_minutes", SEED_INTERVAL_MINUTES))) * 60
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=interval)
            except asyncio.TimeoutError:
                continue
        except asyncio.CancelledError:
            return
        except Exception:
            log.exception("seeder loop error")
            await asyncio.sleep(30)


# ============================================================
# COMMANDS
# ============================================================
@app.on_message(filters.command("start") & filters.private)
async def start_cmd(client, message):
    user = await ensure_user(message.from_user)
    uid = int(message.from_user.id)
    if user.get("banned"):
        return await message.reply_text("🚫 You are banned from this bot.")

    settings = await get_settings()
    args = message.command[1:] if len(message.command) > 1 else []
    if args and args[0].startswith("ref_") and settings.get("referral_enabled", True):
        with contextlib.suppress(Exception):
            ref = int(args[0].split("_", 1)[1])
            if ref != uid:
                old = await users.find_one({"_id": uid}, {"referred_by": 1})
                if old and not old.get("referred_by"):
                    await users.update_one({"_id": uid}, {"$set": {"referred_by": ref}})
                    await users.update_one(
                        {"_id": ref},
                        {"$inc": {"referrals": 1, "points": 10}},
                        upsert=False,
                    )
                    await bump("referrals")

    if settings.get("maintenance_mode") and not is_admin(uid):
        return await message.reply_text(
            "🛠 <b>Movie Bot Maintenance</b>\n\nPlease try again later."
        )

    await message.reply_text(
        f"👋 <b>Welcome, {esc(message.from_user.first_name or 'User')}!</b>\n\n"
        "🎬 <b>Movie Search Bot</b>\n"
        "Search movies and series by name. Typing mistakes are handled automatically.\n\n"
        "Examples:\n"
        "<code>/search kingsman</code>\n"
        "<code>/upcoming avengers</code>\n"
        "<code>/released dune</code>",
        reply_markup=home_keyboard(settings),
    )


@app.on_message(filters.command("search") & (filters.private | filters.group))
async def search_cmd(client, message):
    await ensure_user(message.from_user)
    await process_search(message, " ".join(message.command[1:]), "search")


@app.on_message(filters.command("upcoming") & (filters.private | filters.group))
async def upcoming_cmd(client, message):
    await ensure_user(message.from_user)
    await process_search(message, " ".join(message.command[1:]), "upcoming")


@app.on_message(filters.command("released") & (filters.private | filters.group))
async def released_cmd(client, message):
    await ensure_user(message.from_user)
    await process_search(message, " ".join(message.command[1:]), "released")


@app.on_message(
    filters.text
    & filters.private
    & ~filters.command([
        "start", "search", "upcoming", "released", "admin", "stats", "ban", "unban",
        "broadcast", "maintenance", "ping", "diagnose", "seednow", "seedadd", "seedlist",
        "seedclear", "seedstatus", "channel_test", "setresultchannel", "cancel",
    ])
)
async def plain_search(client, message):
    uid = int(message.from_user.id)
    # Admin text is handled by the runtime configuration/broadcast state handler below.
    if uid == ADMIN_ID and uid in admin_input_state:
        return
    await ensure_user(message.from_user)
    if await is_banned(uid):
        return await message.reply_text("🚫 You are banned.")
    await process_search(message, message.text, "search")


# ============================================================
# INLINE SEARCH
# ============================================================
@app.on_inline_query()
async def inline_search(client, query):
    q = (query.query or "").strip()
    if not q:
        return await query.answer([], cache_time=2, is_personal=True)
    uid = int(query.from_user.id)
    try:
        if await is_banned(uid) and not is_admin(uid):
            return await query.answer([], cache_time=1, is_personal=True)
        settings = await get_settings()
        if settings.get("maintenance_mode") and not is_admin(uid):
            return await query.answer([], cache_time=1, is_personal=True)
        if not settings.get("movie_search_enabled", True):
            return await query.answer([], cache_time=2, is_personal=True)

        cached = await find_cached(q)
        candidates = []
        if cached:
            candidates = [{
                "id": cached["tmdb_id"],
                "media_type": cached["media_type"],
                "title": cached.get("title"),
                "name": cached.get("title"),
                "release_date": cached.get("release_date", "") if cached["media_type"] == "movie" else None,
                "first_air_date": cached.get("release_date", "") if cached["media_type"] == "tv" else None,
                "overview": safe_text((cached.get("details") or {}).get("overview", ""), 140),
            }]
        else:
            candidates = await tmdb_search(q)

        results = []
        for item in candidates[:SEARCH_LIMIT]:
            mt = item.get("media_type")
            tid = int(item.get("id"))
            title = title_of(item, mt)
            year = (release_of(item, mt) or "")[:4] or "----"
            desc = safe_text(item.get("overview") or "Movie / TV details", 160)
            text = f"🎬 <b>{esc(title)}</b> ({year})\n\n/search {esc(title)}"
            results.append(
                InlineQueryResultArticle(
                    id=f"{mt}:{tid}",
                    title=f"{'🎬' if mt == 'movie' else '📺'} {title} ({year})",
                    description=desc,
                    input_message_content=InputTextMessageContent(text),
                    reply_markup=InlineKeyboardMarkup([
                        [InlineKeyboardButton("🔎 OPEN SEARCH", switch_inline_query_current_chat=title)]
                    ]),
                )
            )
        return await query.answer(results, cache_time=10, is_personal=True)
    except Exception:
        log.exception("inline search failed")
        return await query.answer([], cache_time=2, is_personal=True)


# ============================================================
# CALLBACKS
# ============================================================
@app.on_callback_query()
async def callbacks(client, query):
    uid = int(query.from_user.id)
    data = query.data or ""
    settings = await get_settings()

    if await is_banned(uid) and not is_admin(uid):
        return await query.answer("🚫 Banned.", show_alert=True)

    if data == "verify_join":
        ok = await join_ok(uid)
        return await query.answer(
            "✅ Join verified." if ok else "❌ Please join all required channels.",
            show_alert=True,
        )

    if data == "close":
        with contextlib.suppress(Exception):
            await query.message.delete()
        return

    if data == "status":
        if settings.get("maintenance_mode") and not is_admin(uid):
            return await query.answer("🛠 Bot is under maintenance.", show_alert=True)
        return await query.answer("✅ Movie Search Bot is active.", show_alert=True)

    if data == "credits":
        return await query.message.edit_text(
            "ℹ️ <b>Credits</b>\n\n"
            "This product uses the TMDB API but is not endorsed or certified by TMDB.\n\n"
            "Watch-availability information is powered by JustWatch via TMDB and is shown as provided by the API.\n\n"
            f"🏷️ <b>{esc(settings.get('brand_name') or BRAND_NAME)}</b>",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Back", callback_data="home_back")]]),
        )

    if data == "home_back":
        return await query.message.edit_text(
            f"🏠 <b>{esc(settings.get('brand_name') or BRAND_NAME)}</b>",
            reply_markup=home_keyboard(settings),
        )

    if data == "channel_test":
        target = str(settings.get("result_channel") or "").strip()
        if not target:
            return await query.answer("Result channel is not configured.", show_alert=True)
        try:
            chat = await app.get_chat(target)
            test = await app.send_message(chat.id, "🧪 <b>Movie result channel test</b>\n✅ Bot can post here.")
            with contextlib.suppress(Exception):
                await app.delete_messages(chat.id, test.id)
            return await query.answer(f"✅ Channel OK: {chat.id}", show_alert=True)
        except Exception as exc:
            log.error("Result channel test failed: %s", exc)
            return await query.answer(f"❌ {type(exc).__name__}: {str(exc)[:180]}", show_alert=True)

    if data == "search_help":
        return await query.message.edit_text(
            "🔎 <b>Search</b>\n\n"
            "Send any movie/series name or use:\n"
            "<code>/search movie name</code>\n\n"
            "Typos and spelling mistakes are handled automatically.",
            reply_markup=home_keyboard(settings),
        )

    if data == "upcoming_help":
        return await query.message.edit_text(
            "🆕 <b>Upcoming</b>\n\nUse <code>/upcoming title</code>",
            reply_markup=home_keyboard(settings),
        )

    if data == "released_help":
        return await query.message.edit_text(
            "✅ <b>Released</b>\n\nUse <code>/released title</code>",
            reply_markup=home_keyboard(settings),
        )

    if data == "referral":
        me = await client.get_me()
        u = await users.find_one({"_id": uid}) or {}
        link = f"https://t.me/{me.username}?start=ref_{uid}"
        return await query.message.edit_text(
            "💎 <b>Referral</b>\n\n"
            f"👥 Referrals: <b>{int(u.get('referrals', 0))}</b>\n"
            f"💎 Points: <b>{int(u.get('points', 0))}</b>\n\n"
            f"🔗 <code>{esc(link)}</code>",
            reply_markup=home_keyboard(settings),
        )

    if data.startswith("suggest:"):
        token = data.split(":", 1)[1]
        item = suggestion_state.get(token)
        if not item or int(item.get("uid", 0)) != uid or int(item.get("expires", 0)) < now_ts():
            suggestion_state.pop(token, None)
            return await query.answer("Suggestion expired. Search again.", show_alert=True)
        suggestion_state.pop(token, None)
        with contextlib.suppress(Exception):
            await query.message.delete()
        await process_search(query.message, item["text"], "search")
        return await query.answer("Searching corrected spelling…")

    if data.startswith("pick:"):
        if not await join_ok(uid) and not is_admin(uid):
            return await query.answer("Join required channels first.", show_alert=True)
        try:
            _, mt, raw_id = data.split(":", 2)
            details = await tmdb_details(mt, int(raw_id))
            doc = await cache_details(details, mt, publish=True)
            await query.message.delete()
            await send_cached(uid, doc)
            return await query.answer("✅ Done")
        except Exception as exc:
            return await query.answer(f"Error: {str(exc)[:140]}", show_alert=True)

    # ---------------- ADMIN ONLY ----------------
    if uid != ADMIN_ID:
        return await query.answer("🚫 Admin only.", show_alert=True)

    if data.startswith("toggle:"):
        key = data.split(":", 1)[1]
        if key not in DEFAULT_SETTINGS:
            return await query.answer("Unknown setting.", show_alert=True)
        new_value = not bool(settings.get(key, False))
        await set_setting(key, new_value)
        settings = await get_settings()
        if key == "maintenance_mode":
            await query.message.edit_text(await admin_panel_text(settings), reply_markup=admin_keyboard(settings))
            return await query.answer("Maintenance changed; status broadcast is available via /maintenance on|off.")
        await query.message.edit_text(await admin_panel_text(settings), reply_markup=admin_keyboard(settings))
        return await query.answer(f"{key}: {'ON' if new_value else 'OFF'}")

    if data == "admin_links":
        return await query.message.edit_text(
            "⚙️ <b>CHANNELS / BRANDING</b>\n\n"
            "Configure result channel, join gates and your own branded links.",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("📺 Result Channel", callback_data="cfg:result_channel")],
                [InlineKeyboardButton("🔐 Join Channel 01", callback_data="cfg:join1"), InlineKeyboardButton("🔐 Join Channel 02", callback_data="cfg:join2")],
                [InlineKeyboardButton("🌍 Watch Region", callback_data="cfg:watch_region")],
                [InlineKeyboardButton("🏷️ Brand Name", callback_data="cfg:brand_name")],
                [InlineKeyboardButton("📢 Brand Telegram", callback_data="cfg:brand_channel"), InlineKeyboardButton("📸 Instagram", callback_data="cfg:brand_instagram")],
                [InlineKeyboardButton("🤖 Brand Bot", callback_data="cfg:brand_bot")],
                [InlineKeyboardButton("🧪 RESULT CHANNEL TEST", callback_data="channel_test")],
                [InlineKeyboardButton("🔙 Admin", callback_data="admin_back")],
            ]),
        )

    if data.startswith("cfg:"):
        key = data.split(":", 1)[1]
        admin_input_state[uid] = key
        hints = {
            "join1": "Send: <code>CHANNEL_ID_OR_USERNAME | JOIN_URL</code>",
            "join2": "Send: <code>CHANNEL_ID_OR_USERNAME | JOIN_URL</code>",
            "result_channel": "Send result channel ID/username. The bot must be an administrator with permission to post.",
            "watch_region": "Send 2-letter region, e.g. <code>IN</code>, <code>US</code>, <code>GB</code>.",
            "brand_name": "Send your brand name.",
            "brand_channel": "Send your Telegram channel/profile URL or <code>off</code>.",
            "brand_instagram": "Send your Instagram URL or <code>off</code>.",
            "brand_bot": "Send your Telegram bot URL or <code>off</code>.",
        }
        if query.message.chat.type != "private":
            admin_input_state.pop(uid, None)
            return await query.answer("Open the bot privately to edit this setting.", show_alert=True)
        return await query.message.edit_text(
            f"✏️ <b>Edit {esc(key)}</b>\n\n{hints.get(key, 'Send the value now.')}\n\nUse /cancel to abort."
        )

    if data == "admin_seeder":
        count = await movies.count_documents({})
        s = await get_settings()
        queue = list(s.get("seed_queue") or [])
        return await query.message.edit_text(
            "🌱 <b>SEEDER</b>\n\n"
            f"Status: <b>{'ON' if s.get('seeder_enabled') else 'OFF'}</b>\n"
            f"Interval: <b>{int(s.get('seed_interval_minutes', 5))} min</b>\n"
            f"Batch: <b>{int(s.get('seed_batch_size', 2))}</b>\n"
            f"Cached titles: <b>{count}</b>\n"
            f"Manual queue: <b>{len(queue)}</b>\n\n"
            "Commands:\n"
            "<code>/seedadd MOVIE NAME</code>\n"
            "<code>/seednow</code>\n"
            "<code>/seedstatus</code>",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("🌱 RUN NOW", callback_data="seed_run_now")],
                [InlineKeyboardButton("🟢/🔴 Toggle", callback_data="toggle:seeder_enabled")],
                [InlineKeyboardButton("🔙 Admin", callback_data="admin_back")],
            ]),
        )

    if data == "seed_run_now":
        result = await seed_once()
        return await query.answer(f"Seeded: {result.get('seeded', 0)}", show_alert=True)

    if data == "admin_analytics":
        docs = await analytics.find().sort("_id", DESCENDING).limit(7).to_list(7)
        lines = ["📊 <b>Analytics — last 7 days</b>", ""]
        for d in docs:
            lines.append(
                f"<b>{esc(d.get('_id'))}</b> — users {d.get('new_users',0)} | searches {d.get('searches',0)} | cache {d.get('cache_hits',0)} | seeded {d.get('seeded_titles',0)}"
            )
        return await query.message.edit_text("\n".join(lines), reply_markup=admin_keyboard(settings))

    if data == "admin_users":
        total = await users.count_documents({})
        banned = await users.count_documents({"banned": True})
        refs = await users.aggregate([
            {"$group": {"_id": None, "total": {"$sum": "$referrals"}}}
        ]).to_list(1)
        referral_total = int(refs[0]["total"]) if refs else 0
        return await query.message.edit_text(
            f"👥 <b>Users</b>\n\nTotal: <b>{total}</b>\nBanned: <b>{banned}</b>\nReferrals: <b>{referral_total}</b>",
            reply_markup=admin_keyboard(settings),
        )

    if data == "admin_cache":
        total = await movies.count_documents({})
        movies_count = await movies.count_documents({"media_type": "movie"})
        tv_count = await movies.count_documents({"media_type": "tv"})
        return await query.message.edit_text(
            f"💾 <b>MOVIE CACHE</b>\n\nTotal: <b>{total}</b>\n🎬 Movies: <b>{movies_count}</b>\n📺 TV: <b>{tv_count}</b>",
            reply_markup=admin_keyboard(settings),
        )

    if data == "admin_broadcast":
        admin_input_state[uid] = "broadcast"
        return await query.message.edit_text(
            "📢 <b>Broadcast</b>\n\nSend the message now.\nUse /cancel to abort."
        )

    if data == "admin_back":
        settings = await get_settings()
        return await query.message.edit_text(await admin_panel_text(settings), reply_markup=admin_keyboard(settings))


@app.on_message(filters.command("panel") & (filters.private | filters.group))
async def panel_cmd(client, message):
    uid = int(message.from_user.id)
    settings = await get_settings()
    if settings.get("maintenance_mode") and not is_admin(uid):
        return await message.reply_text("🛠 <b>Bot is under maintenance.</b>")
    await message.reply_text(
        f"👤 <b>{esc(settings.get('brand_name') or BRAND_NAME)} — User Panel</b>\n\n"
        "Use buttons below or /search Movie Name.",
        reply_markup=home_keyboard(settings),
    )


# ============================================================
# ADMIN COMMANDS + ADMIN INPUT STATE
# ============================================================
@app.on_message(filters.command("admin") & (filters.private | filters.group))
async def admin_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    settings = await get_settings()
    await message.reply_text(await admin_panel_text(settings), reply_markup=admin_keyboard(settings))


@app.on_message(filters.command("stats") & (filters.private | filters.group))
async def stats_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    user_count = await users.count_documents({})
    cache_count = await movies.count_documents({})
    a = await analytics.find().sort("_id", DESCENDING).limit(1).to_list(1)
    latest = a[0] if a else {}
    await message.reply_text(
        f"📊 <b>STATS</b>\n\n"
        f"👥 Users: <b>{user_count}</b>\n"
        f"🎬 Cached titles: <b>{cache_count}</b>\n"
        f"🔎 Today searches: <b>{latest.get('searches', 0)}</b>\n"
        f"⚡ Today cache hits: <b>{latest.get('cache_hits', 0)}</b>\n"
        f"🌱 Today seeded: <b>{latest.get('seeded_titles', 0)}</b>"
    )


@app.on_message(filters.command("ban") & (filters.private | filters.group))
async def ban_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    if len(message.command) < 2:
        return await message.reply_text("Usage: /ban USER_ID")
    try:
        uid = int(message.command[1])
    except ValueError:
        return await message.reply_text("Invalid USER_ID")
    await users.update_one({"_id": uid}, {"$set": {"banned": True}}, upsert=True)
    await message.reply_text(f"🚫 Banned <code>{uid}</code>")


@app.on_message(filters.command("unban") & (filters.private | filters.group))
async def unban_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    if len(message.command) < 2:
        return await message.reply_text("Usage: /unban USER_ID")
    try:
        uid = int(message.command[1])
    except ValueError:
        return await message.reply_text("Invalid USER_ID")
    await users.update_one({"_id": uid}, {"$set": {"banned": False}}, upsert=True)
    await message.reply_text(f"✅ Unbanned <code>{uid}</code>")


@app.on_message(filters.command("maintenance") & (filters.private | filters.group))
async def maintenance_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    if len(message.command) < 2 or message.command[1].lower() not in {"on", "off"}:
        s = await get_settings()
        return await message.reply_text(
            f"🛠 Maintenance: <b>{'ON' if s.get('maintenance_mode') else 'OFF'}</b>\n\n"
            "Use <code>/maintenance on</code> or <code>/maintenance off</code>"
        )
    active = message.command[1].lower() == "on"
    await set_setting("maintenance_mode", active)
    status_text = (
        "🛠 <b>Movie Bot Maintenance</b>\n\nPlease try again later."
        if active else
        "✅ <b>Movie Bot is Active</b>\n\nNormal movie search services are online."
    )
    await message.reply_text(status_text)
    # Broadcast only if enabled.
    s = await get_settings()
    if s.get("broadcast_enabled", True):
        sent = failed = 0
        async for doc in users.find({"banned": {"$ne": True}}, {"_id": 1}):
            try:
                await client.send_message(int(doc["_id"]), status_text)
                sent += 1
            except FloodWait as exc:
                await asyncio.sleep(exc.value)
                with contextlib.suppress(Exception):
                    await client.send_message(int(doc["_id"]), status_text)
                    sent += 1
            except Exception:
                failed += 1
            if (sent + failed) % 25 == 0:
                await asyncio.sleep(1)
        await message.reply_text(f"📢 Status broadcast complete\n✅ {sent}\n❌ {failed}")


@app.on_message(filters.command("broadcast") & filters.private)
async def broadcast_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    text = " ".join(message.command[1:]).strip()
    if not text:
        admin_input_state[int(message.from_user.id)] = "broadcast"
        return await message.reply_text("📢 Send the broadcast message now. /cancel to abort.")
    await do_broadcast(text)


async def do_broadcast(text: str) -> tuple[int, int]:
    sent = failed = 0
    async for doc in users.find({"banned": {"$ne": True}}, {"_id": 1}):
        try:
            await app.send_message(int(doc["_id"]), text[:4000])
            sent += 1
        except FloodWait as exc:
            await asyncio.sleep(exc.value)
            with contextlib.suppress(Exception):
                await app.send_message(int(doc["_id"]), text[:4000])
                sent += 1
        except Exception:
            failed += 1
        if (sent + failed) % 25 == 0:
            await asyncio.sleep(1)
    return sent, failed


@app.on_message(filters.command("seedadd") & (filters.private | filters.group))
async def seedadd_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    query = " ".join(message.command[1:]).strip()
    if not query:
        return await message.reply_text("Usage: /seedadd MOVIE NAME")
    s = await get_settings()
    queue = list(s.get("seed_queue") or [])
    if norm_query(query) not in {norm_query(x) for x in queue}:
        queue.append(query[:160])
        await set_setting("seed_queue", queue)
    await message.reply_text(f"✅ Added to seed queue. Queue size: <b>{len(queue)}</b>")


@app.on_message(filters.command("seedlist") & (filters.private | filters.group))
async def seedlist_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    s = await get_settings()
    queue = list(s.get("seed_queue") or [])
    if not queue:
        return await message.reply_text("🌱 Seed queue is empty.")
    text = "🌱 <b>SEED QUEUE</b>\n\n" + "\n".join(f"{i+1}. {esc(q)}" for i, q in enumerate(queue[:50]))
    await message.reply_text(text)


@app.on_message(filters.command("seedclear") & (filters.private | filters.group))
async def seedclear_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    await set_setting("seed_queue", [])
    await message.reply_text("✅ Seed queue cleared.")


@app.on_message(filters.command("seednow") & (filters.private | filters.group))
async def seednow_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    result = await seed_once()
    await message.reply_text(
        "🌱 <b>Seeder Run</b>\n\n"
        f"✅ Seeded: <b>{result.get('seeded', 0)}</b>\n"
        f"❌ Errors: <b>{result.get('errors', 0)}</b>\n"
        f"Mode: <code>{esc(result.get('mode') or result.get('reason') or 'n/a')}</code>"
    )


@app.on_message(filters.command("seedstatus") & (filters.private | filters.group))
async def seedstatus_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    s = await get_settings()
    count = await movies.count_documents({})
    await message.reply_text(
        "🌱 <b>SEED STATUS</b>\n\n"
        f"Enabled: <b>{'ON' if s.get('seeder_enabled') else 'OFF'}</b>\n"
        f"Interval: <b>{int(s.get('seed_interval_minutes', 5))} min</b>\n"
        f"Batch: <b>{int(s.get('seed_batch_size', 2))}</b>\n"
        f"Cached: <b>{count}</b>\n"
        f"Page: <b>{int(s.get('seed_page', 1))}</b>\n"
        f"Source index: <b>{int(s.get('seed_source_index', 0))}</b>\n"
        f"Queue: <b>{len(s.get('seed_queue') or [])}</b>"
    )


@app.on_message(filters.command("setresultchannel") & (filters.private | filters.group))
async def setresultchannel_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    value = " ".join(message.command[1:]).strip()
    if not value:
        return await message.reply_text("Usage: /setresultchannel @channelusername or -1001234567890")
    await set_setting("result_channel", value)
    await message.reply_text("✅ Result channel saved. Run /channel_test now.")


@app.on_message(filters.command("channel_test") & (filters.private | filters.group))
async def channel_test_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    target = str((await get_settings()).get("result_channel") or "").strip()
    if not target:
        return await message.reply_text("❌ Result channel is not configured. Use /setresultchannel ...")
    try:
        chat = await client.get_chat(target)
        test = await client.send_message(chat.id, "✅ <b>Movie Search Bot channel test</b>\n\nThe bot can post here.")
        with contextlib.suppress(Exception):
            await client.delete_messages(chat.id, test.id)
        await message.reply_text(f"✅ Channel OK\nID: <code>{chat.id}</code>\nTitle: <b>{esc(getattr(chat, 'title', '') or '')}</b>")
    except Exception as exc:
        await message.reply_text(f"❌ Channel test failed\n<code>{esc(type(exc).__name__)}: {esc(str(exc)[:1200])}</code>")


@app.on_message(filters.command("ping") & (filters.private | filters.group))
async def ping_cmd(client, message):
    await message.reply_text("🏓 <b>PONG</b>\n\n✅ Movie Search Bot is online.")


@app.on_message(filters.command("diagnose") & (filters.private | filters.group))
async def diagnose_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    s = await get_settings()
    users_count = await users.count_documents({})
    movies_count = await movies.count_documents({})
    try:
        mongo_ok = bool((await mongo.admin.command("ping")).get("ok"))
    except Exception:
        mongo_ok = False
    tmdb_ok = bool(TMDB_API_TOKEN or TMDB_API_KEY)
    try:
        me = await client.get_me()
        bot_name = me.username or str(me.id)
    except Exception:
        bot_name = "unknown"
    result_channel = str(s.get("result_channel") or "").strip()
    channel_status = "NOT SET"
    if result_channel:
        try:
            ch = await client.get_chat(result_channel)
            channel_status = f"OK: {ch.id} / {getattr(ch, 'title', '') or ''}"
        except Exception as exc:
            channel_status = f"ERROR: {type(exc).__name__}: {str(exc)[:100]}"

    await message.reply_text(
        "🩺 <b>MOVIE BOT DIAGNOSTICS</b>\n\n"
        f"Bot: <b>{esc(bot_name)}</b>\n"
        f"Mongo: <b>{'OK' if mongo_ok else 'ERROR'}</b>\n"
        f"TMDB credential: <b>{'SET' if tmdb_ok else 'MISSING'}</b>\n"
        f"Python API mode: <b>Pyrofork</b>\n\n"
        f"Users: <b>{users_count}</b>\n"
        f"Cached titles: <b>{movies_count}</b>\n\n"
        f"Search: {'ON' if s.get('movie_search_enabled') else 'OFF'}\n"
        f"Upcoming: {'ON' if s.get('upcoming_enabled') else 'OFF'}\n"
        f"Released: {'ON' if s.get('released_enabled') else 'OFF'}\n"
        f"Join Gate: {'ON' if s.get('join_gate_enabled') else 'OFF'}\n"
        f"Auto Seeder: {'ON' if s.get('seeder_enabled') else 'OFF'}\n"
        f"Watch Region: <b>{esc(s.get('watch_region'))}</b>\n"
        f"Result Channel: <code>{esc(result_channel or 'NOT SET')}</code>\n"
        f"Channel Check: <b>{esc(channel_status)}</b>\n"
        f"Brand: <b>{esc(s.get('brand_name') or BRAND_NAME)}</b>\n"
        f"Brand Telegram: {'SET' if s.get('brand_channel_url') else 'OFF'}\n"
        f"Brand Bot: {'SET' if s.get('brand_bot_url') else 'OFF'}\n"
        f"Brand Instagram: {'SET' if s.get('brand_instagram_url') else 'OFF'}\n"
        f"Free Watch Link: provider-only"
    )


@app.on_message(filters.command("cancel") & filters.private)
async def cancel_cmd(client, message):
    if is_admin(message.from_user.id):
        admin_input_state.pop(int(message.from_user.id), None)
    await message.reply_text("✅ Cancelled.")


# ---------------- ADMIN INPUT TEXT ----------------
@app.on_message(filters.text & filters.private)
async def admin_input_handler(client, message):
    uid = int(message.from_user.id)
    if uid != ADMIN_ID:
        return
    key = admin_input_state.get(uid)
    if not key:
        return

    text = (message.text or "").strip()
    if text.lower() == "/cancel":
        admin_input_state.pop(uid, None)
        return await message.reply_text("✅ Cancelled.")

    try:
        if key == "join1":
            parts = [x.strip() for x in text.split("|", 1)]
            if len(parts) != 2:
                return await message.reply_text("Format: <code>CHANNEL_ID_OR_USERNAME | JOIN_URL</code>")
            await set_setting("join_1", parts[0])
            await set_setting("join_1_url", parts[1])
            await set_setting("join_gate_enabled", True)
            msg = "✅ Join Channel 01 saved."

        elif key == "join2":
            parts = [x.strip() for x in text.split("|", 1)]
            if len(parts) != 2:
                return await message.reply_text("Format: <code>CHANNEL_ID_OR_USERNAME | JOIN_URL</code>")
            await set_setting("join_2", parts[0])
            await set_setting("join_2_url", parts[1])
            await set_setting("join_gate_enabled", True)
            msg = "✅ Join Channel 02 saved."

        elif key == "result_channel":
            await set_setting("result_channel", text)
            msg = "✅ Result channel saved. Make sure the bot can post there."

        elif key == "watch_region":
            region = text.upper().strip()
            if not re.fullmatch(r"[A-Z]{2}", region):
                return await message.reply_text("Use a 2-letter ISO country code such as IN, US, GB.")
            await set_setting("watch_region", region)
            msg = f"✅ Watch region set to <b>{region}</b>."

        elif key == "brand_name":
            await set_setting("brand_name", text[:80] or BRAND_NAME)
            msg = "✅ Brand name saved."

        elif key in {"brand_channel", "brand_instagram", "brand_bot"}:
            field = {"brand_channel": "brand_channel_url", "brand_instagram": "brand_instagram_url", "brand_bot": "brand_bot_url"}[key]
            value = "" if text.lower() == "off" else text
            if value and not value.startswith(("http://", "https://", "tg://")):
                return await message.reply_text("Use a valid http(s):// or tg:// URL, or <code>off</code>.")
            await set_setting(field, value)
            msg = "✅ Branding link saved."

        elif key == "broadcast":
            admin_input_state.pop(uid, None)
            sent, failed = await do_broadcast(text)
            return await message.reply_text(f"📢 Broadcast complete\n✅ Sent: {sent}\n❌ Failed: {failed}")

        else:
            msg = "Unknown admin input."
    finally:
        admin_input_state.pop(uid, None)

    await message.reply_text(msg)


# ============================================================
# HEALTH SERVER / MAIN
# ============================================================
async def health(_request: web.Request):
    settings = await get_settings()
    return web.json_response({
        "ok": True,
        "service": "movie-search-bot",
        "time": now_ts(),
        "maintenance": bool(settings.get("maintenance_mode", False)),
        "cached_titles": await movies.count_documents({}),
    })


async def main():
    required = [
        ("API_ID", API_ID),
        ("API_HASH", API_HASH),
        ("BOT_TOKEN", BOT_TOKEN),
        ("MONGO_URI", MONGO_URI),
        ("ADMIN_ID", ADMIN_ID),
    ]
    missing = [name for name, value in required if not value]
    if missing:
        raise RuntimeError("Missing environment variables: " + ", ".join(missing))

    # Best-effort DB indexes; bot should still start if Mongo is temporarily unavailable.
    index_jobs = [
        (users, [("banned", ASCENDING)]),
        (users, [("referred_by", ASCENDING)]),
        (movies, [("aliases", ASCENDING)]),
        (movies, [("normalized_title", ASCENDING)]),
        (movies, [("release_date", ASCENDING)]),
        (movies, [("updated_at", DESCENDING)]),
    ]
    for collection, spec in index_jobs:
        with contextlib.suppress(Exception):
            await collection.create_index(spec)
    with contextlib.suppress(Exception):
        await settings_col.update_one(
            {"_id": "global"}, {"$setOnInsert": DEFAULT_SETTINGS}, upsert=True
        )

    web_app = web.Application()
    web_app.router.add_get("/", health)
    web_app.router.add_get("/health", health)
    runner = web.AppRunner(web_app, access_log=log)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()

    stop_event = asyncio.Event()
    seed_task: Optional[asyncio.Task] = None

    try:
        # Pyrofork managed run lifecycle: app.run(main()) owns the event loop.
        await app.start()
        me = await app.get_me()
        log.info("Movie bot started as @%s", me.username)
        log.info("Web server listening on %s", PORT)
        log.info("TMDB credential: %s", "configured" if (TMDB_API_TOKEN or TMDB_API_KEY) else "MISSING")

        # Validate Mongo without making startup dependent on it.
        try:
            await mongo.admin.command("ping")
            log.info("MongoDB connection OK")
        except Exception as exc:
            log.warning("MongoDB ping failed: %s", exc)

        if (await get_settings()).get("seeder_enabled", False):
            seed_task = asyncio.create_task(seeder_loop(stop_event), name="movie-seeder")
        await idle()
    except FloodWait as exc:
        log.error("Telegram FloodWait during startup: %s sec", exc.value)
        await asyncio.sleep(exc.value)
    finally:
        stop_event.set()
        if seed_task:
            seed_task.cancel()
            with contextlib.suppress(Exception, asyncio.CancelledError):
                await seed_task
        with contextlib.suppress(Exception):
            await runner.cleanup()
        with contextlib.suppress(Exception):
            if app.is_connected:
                await app.stop()
        with contextlib.suppress(Exception):
            mongo.close()


if __name__ == "__main__":
    try:
        app.run(main())
    except KeyboardInterrupt:
        pass
