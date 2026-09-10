import os, re, html, time, asyncio, logging, contextlib, secrets
from datetime import datetime, timezone
from typing import Optional

from aiohttp import web, ClientTimeout
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, DESCENDING
from pyrogram import Client, filters, idle
from pyrogram.errors import FloodWait
from pyrogram.types import InlineKeyboardButton, InlineKeyboardMarkup

# ============================================================
# MOVIE SEARCH BOT — STANDALONE PROJECT
# No file-store / no StreamHG / no FTP / no Oracle code.
# TMDB = metadata source, MongoDB = cache, optional AI = query
# correction/candidate ranking only.
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
log = logging.getLogger("movie-search-bot")

# ---------------- CONFIG ----------------
API_ID = int(os.getenv("API_ID", "0"))
API_HASH = os.getenv("API_HASH", "")
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
MONGO_URI = os.getenv("MONGO_URI", "")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "movie_search_bot")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))
LOG_CHANNEL = int(os.getenv("LOG_CHANNEL", "0"))
PORT = int(os.getenv("PORT", "10000"))

TMDB_API_TOKEN = os.getenv("TMDB_API_TOKEN", "").strip()
TMDB_API_KEY = os.getenv("TMDB_API_KEY", "").strip()
TMDB_LANGUAGE = os.getenv("TMDB_LANGUAGE", "en-US").strip()
TMDB_REGION = os.getenv("TMDB_REGION", "IN").strip()
TMDB_IMAGE_BASE = os.getenv("TMDB_IMAGE_BASE", "https://image.tmdb.org/t/p/w500").rstrip("/")

MOVIE_WEBSITE_URL = os.getenv("MOVIE_WEBSITE_URL", "").strip().rstrip("/")
TRAILER_BUTTON = os.getenv("TRAILER_BUTTON", "1").lower() in {"1", "true", "yes", "on"}
PUBLISH_CANONICAL = os.getenv("PUBLISH_CANONICAL", "1").lower() in {"1", "true", "yes", "on"}

REQUIRED_CHANNEL_1 = os.getenv("REQUIRED_CHANNEL_1", "").strip()
REQUIRED_CHANNEL_2 = os.getenv("REQUIRED_CHANNEL_2", "").strip()
REQUIRED_CHANNEL_1_URL = os.getenv("REQUIRED_CHANNEL_1_URL", "").strip()
REQUIRED_CHANNEL_2_URL = os.getenv("REQUIRED_CHANNEL_2_URL", "").strip()

AI_PROVIDER = os.getenv("AI_PROVIDER", "auto").lower().strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
AI_MODEL = os.getenv("AI_MODEL", "gemini-2.5-flash-lite").strip()

CACHE_DAYS = max(1, int(os.getenv("MOVIE_CACHE_DAYS", "30")))
SEARCH_LIMIT = max(3, min(int(os.getenv("MOVIE_SEARCH_LIMIT", "8")), 10))
AI_CANDIDATE_LIMIT = max(3, min(int(os.getenv("AI_CANDIDATE_LIMIT", "8")), 10))
AI_TIMEOUT = max(5, int(os.getenv("AI_TIMEOUT", "12")))

app = Client(
    "StandaloneMovieSearchBot",
    api_id=API_ID,
    api_hash=API_HASH,
    bot_token=BOT_TOKEN,
    workers=8,
)

mongo = AsyncIOMotorClient(MONGO_URI, maxPoolSize=30, serverSelectionTimeoutMS=8000)
db = mongo[MONGO_DB_NAME]
users = db.users
movies = db.movies
settings_col = db.settings
analytics = db.analytics

# Per-user short-lived state
search_state: dict[int, dict] = {}

DEFAULT_SETTINGS = {
    "maintenance_mode": False,
    "movie_search_enabled": True,
    "released_enabled": True,
    "upcoming_enabled": True,
    "join_gate_enabled": bool(REQUIRED_CHANNEL_1 or REQUIRED_CHANNEL_2),
    "canonical_cache_enabled": True,
    "referral_enabled": True,
    "analytics_enabled": True,
    "broadcast_enabled": True,
}

# ---------------- HELPERS ----------------
def now_ts() -> int:
    return int(time.time())


def esc(v) -> str:
    return html.escape(str(v or ""))


def norm_query(q: str) -> str:
    q = (q or "").lower().strip()
    q = re.sub(r"\b(?:movie|film|series|season|s\d+|episode|ep)\b", " ", q)
    q = re.sub(r"[\W_]+", " ", q, flags=re.UNICODE)
    return re.sub(r"\s+", " ", q).strip()


def title_of(item: dict, media_type: Optional[str] = None) -> str:
    mt = media_type or item.get("media_type")
    return (item.get("title") if mt == "movie" else item.get("name")) or item.get("original_title") or item.get("original_name") or "Unknown"


def release_of(item: dict, media_type: Optional[str] = None) -> str:
    mt = media_type or item.get("media_type")
    return (item.get("release_date") if mt == "movie" else item.get("first_air_date")) or ""


def is_released(item: dict) -> bool:
    d = release_of(item)
    if not d:
        return False
    return d <= datetime.now(timezone.utc).strftime("%Y-%m-%d")


def is_upcoming(item: dict) -> bool:
    d = release_of(item)
    return bool(d and d > datetime.now(timezone.utc).strftime("%Y-%m-%d"))


def is_admin(uid: int) -> bool:
    return int(uid) == ADMIN_ID


def slugify(s: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s or "movie").strip("-").lower()
    return s or "movie"


async def get_settings() -> dict:
    doc = await settings_col.find_one({"_id": "global"})
    if not doc:
        await settings_col.insert_one({"_id": "global", **DEFAULT_SETTINGS})
        return dict(DEFAULT_SETTINGS)
    out = dict(DEFAULT_SETTINGS)
    out.update(doc)
    return out


async def set_setting(key: str, value):
    await settings_col.update_one({"_id": "global"}, {"$set": {key: value}}, upsert=True)


async def bump(event: str, n: int = 1):
    s = await get_settings()
    if not s.get("analytics_enabled", True):
        return
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with contextlib.suppress(Exception):
        await analytics.update_one({"_id": day}, {"$inc": {event: n}, "$set": {"updated_at": now_ts()}}, upsert=True)


async def ensure_user(user) -> dict:
    uid = int(user.id)
    doc = await users.find_one({"_id": uid})
    if doc:
        await users.update_one({"_id": uid}, {"$set": {
            "username": user.username,
            "first_name": user.first_name,
            "last_name": user.last_name,
            "updated_at": now_ts(),
        }})
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
    try:
        await users.insert_one(doc)
        await bump("new_users")
    except Exception:
        pass
    return await users.find_one({"_id": uid}) or doc


async def is_banned(uid: int) -> bool:
    u = await users.find_one({"_id": int(uid)}, {"banned": 1})
    return bool(u and u.get("banned"))


# ---------------- TMDB ----------------
def tmdb_headers() -> dict:
    h = {"accept": "application/json"}
    if TMDB_API_TOKEN:
        h["Authorization"] = f"Bearer {TMDB_API_TOKEN}"
    return h


async def tmdb_get(path: str, params: Optional[dict] = None) -> dict:
    import aiohttp
    if not TMDB_API_TOKEN and not TMDB_API_KEY:
        raise RuntimeError("TMDB_API_TOKEN or TMDB_API_KEY is not configured.")
    p = dict(params or {})
    if not TMDB_API_TOKEN and TMDB_API_KEY:
        p["api_key"] = TMDB_API_KEY
    timeout = aiohttp.ClientTimeout(total=20)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(f"https://api.themoviedb.org/3{path}", params=p, headers=tmdb_headers()) as r:
            if r.status == 429:
                raise RuntimeError("TMDB_RATE_LIMIT")
            if r.status in (401, 403):
                body = await r.text()
                raise RuntimeError("TMDB_AUTH_ERROR: invalid/inactive API credential. Check TMDB_API_TOKEN or TMDB_API_KEY in Render Environment.")
            if r.status >= 500:
                raise RuntimeError(f"TMDB_SERVER_ERROR: HTTP {r.status}")
            if r.status >= 400:
                body = await r.text()
                raise RuntimeError(f"TMDB_HTTP_ERROR: HTTP {r.status}: {body[:250]}")
            return await r.json()


async def tmdb_search(query: str) -> list[dict]:
    data = await tmdb_get("/search/multi", {
        "query": query,
        "include_adult": "false",
        "language": TMDB_LANGUAGE,
        "region": TMDB_REGION,
        "page": 1,
    })
    out = []
    for x in data.get("results", []):
        if x.get("media_type") in {"movie", "tv"} and x.get("id"):
            out.append(x)
    return out[:SEARCH_LIMIT]


async def tmdb_details(mt: str, tmdb_id: int) -> dict:
    return await tmdb_get(f"/{mt}/{int(tmdb_id)}", {
        "language": TMDB_LANGUAGE,
        "append_to_response": "credits,videos,external_ids,images",
    })


# ---------------- AI SEARCH ASSIST (OPTIONAL) ----------------
async def ai_chat(prompt: str) -> Optional[str]:
    import aiohttp
    providers = []
    if AI_PROVIDER in {"gemini", "auto"} and GEMINI_API_KEY:
        providers.append("gemini")
    if AI_PROVIDER in {"groq", "auto"} and GROQ_API_KEY:
        providers.append("groq")
    if AI_PROVIDER in {"openai", "auto"} and OPENAI_API_KEY:
        providers.append("openai")
    if AI_PROVIDER == "none":
        return None
    for p in providers:
        try:
            timeout = aiohttp.ClientTimeout(total=AI_TIMEOUT)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                if p == "gemini":
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/{AI_MODEL}:generateContent"
                    body = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0, "maxOutputTokens": 180}}
                    async with session.post(url, params={"key": GEMINI_API_KEY}, json=body) as r:
                        if r.status == 429:
                            continue
                        if r.status >= 400:
                            continue
                        data = await r.json()
                        return (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [{}])[0].get("text")
                elif p == "groq":
                    body = {"model": "openai/gpt-oss-20b", "messages": [{"role": "user", "content": prompt}], "temperature": 0, "max_tokens": 180}
                    async with session.post("https://api.groq.com/openai/v1/chat/completions", headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"}, json=body) as r:
                        if r.status == 429:
                            continue
                        if r.status >= 400:
                            continue
                        data = await r.json()
                        return (((data.get("choices") or [{}])[0].get("message") or {}).get("content"))
                else:
                    body = {"model": "gpt-4.1-mini", "input": prompt, "temperature": 0, "max_output_tokens": 180}
                    async with session.post("https://api.openai.com/v1/responses", headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"}, json=body) as r:
                        if r.status == 429:
                            continue
                        if r.status >= 400:
                            continue
                        data = await r.json()
                        return data.get("output_text")
        except Exception:
            continue
    return None


async def rank_candidates(original_query: str, candidates: list[dict]) -> list[int]:
    if not candidates:
        return []
    lines = []
    for i, c in enumerate(candidates[:AI_CANDIDATE_LIMIT], 1):
        mt = c.get("media_type")
        lines.append(f"{i}. {title_of(c)} | {release_of(c, mt) or 'N/A'} | {mt} | id={c.get('id')}")
    prompt = (
        "You are a movie search assistant. The user's search may contain spelling mistakes. "
        "Rank the candidate titles that best match the user's intent. Do not invent titles. "
        "Return ONLY a comma-separated list of candidate numbers, best first.\n"
        f"User query: {original_query}\nCandidates:\n" + "\n".join(lines)
    )
    text = await ai_chat(prompt)
    if not text:
        return list(range(1, len(candidates) + 1))
    nums = [int(x) for x in re.findall(r"\b\d+\b", text)]
    nums = [n for n in nums if 1 <= n <= len(candidates)]
    seen = set()
    out = []
    for n in nums:
        if n not in seen:
            seen.add(n); out.append(n)
    return out or list(range(1, len(candidates) + 1))


# ---------------- FORMATTING ----------------
def trailer_url(details: dict) -> Optional[str]:
    vids = ((details.get("videos") or {}).get("results") or [])
    vids = [v for v in vids if v.get("site") == "YouTube" and v.get("type") in {"Trailer", "Teaser"} and v.get("key")]
    vids.sort(key=lambda v: (v.get("official") is not True, v.get("published_at") or ""))
    return f"https://www.youtube.com/watch?v={vids[0]['key']}" if vids else None


def director(details: dict) -> Optional[str]:
    for c in ((details.get("credits") or {}).get("crew") or []):
        if c.get("job") == "Director":
            return c.get("name")
    return None


def cast(details: dict, n=5) -> list[str]:
    return [x.get("name") for x in ((details.get("credits") or {}).get("cast") or [])[:n] if x.get("name")]


def format_caption(details: dict, mt: str) -> str:
    title = title_of(details, mt)
    original = details.get("original_title") if mt == "movie" else details.get("original_name")
    rating = details.get("vote_average")
    rating_text = f"{float(rating):.1f}/10" if isinstance(rating, (int, float)) else "N/A"
    langs = [x.get("english_name") or x.get("iso_639_1") for x in details.get("spoken_languages", []) if x.get("english_name") or x.get("iso_639_1")]
    lang = ", ".join(langs) or details.get("original_language") or "N/A"
    genres = " • ".join(g.get("name") for g in details.get("genres", []) if g.get("name")) or "N/A"
    countries = ", ".join(c.get("name") for c in details.get("production_countries", []) if c.get("name")) or "N/A"
    date = release_of(details, mt) or "N/A"
    lines = [
        f"🔥 <b>{esc(title)}</b>", "",
        f"⭐ <b>TMDB:</b> {rating_text}",
        f"🇮🇳 <b>Language:</b> {esc(lang)}",
        f"🎭 <b>Genre:</b> {esc(genres)}",
    ]
    if mt == "movie":
        runtime = details.get("runtime")
        lines += [f"⏱️ <b>Runtime:</b> {runtime or 'N/A'} min", f"📅 <b>Release:</b> {esc(date)}"]
    else:
        lines += [
            f"📺 <b>Seasons:</b> {details.get('number_of_seasons') or 'N/A'}",
            f"⏱️ <b>Episodes:</b> {details.get('number_of_episodes') or 'N/A'}",
            f"📅 <b>First Air:</b> {esc(date)}",
        ]
    lines.append(f"🌍 <b>Country:</b> {esc(countries)}")
    if original and original != title:
        lines.append(f"📝 <b>Original:</b> {esc(original)}")
    d = director(details)
    if d:
        lines.append(f"🎬 <b>Director:</b> {esc(d)}")
    cs = cast(details)
    if cs:
        lines.append(f"👥 <b>Cast:</b> {esc(', '.join(cs))}")
    overview = re.sub(r"\s+", " ", details.get("overview") or "No description available.").strip()
    lines += ["", f"📖 <b>Overview:</b> {esc(overview[:1000])}", "", "━━━━━━━━━━━━━━"]
    lines.append("ℹ️ <i>Metadata: TMDB</i>")
    return "\n".join(lines)[:4096]


def movie_keyboard(details: dict, mt: str) -> InlineKeyboardMarkup:
    title = title_of(details, mt)
    tid = int(details["id"])
    rows = []
    if MOVIE_WEBSITE_URL:
        url = f"{MOVIE_WEBSITE_URL}/watch/{mt}/{tid}/{slugify(title)}"
        rows.append([InlineKeyboardButton("▶️ WATCH HERE", url=url)])
    tr = trailer_url(details)
    if TRAILER_BUTTON and tr:
        rows.append([InlineKeyboardButton("🎬 TRAILER", url=tr)])
    imdb = ((details.get("external_ids") or {}).get("imdb_id"))
    if imdb:
        rows.append([InlineKeyboardButton("⭐ IMDb", url=f"https://www.imdb.com/title/{imdb}/")])
    rows.append([InlineKeyboardButton("📤 SHARE", switch_inline_query=title)])
    return InlineKeyboardMarkup(rows)


# ---------------- CACHE + CANONICAL CHANNEL ----------------
async def publish_canonical(details: dict, mt: str, caption: str):
    s = await get_settings()
    if not PUBLISH_CANONICAL or not s.get("canonical_cache_enabled", True) or not LOG_CHANNEL:
        return None
    try:
        kb = movie_keyboard(details, mt)
        if details.get("poster_path"):
            msg = await app.send_photo(LOG_CHANNEL, f"{TMDB_IMAGE_BASE}{details['poster_path']}", caption=caption[:1024], reply_markup=kb)
        else:
            msg = await app.send_message(LOG_CHANNEL, caption[:4096], reply_markup=kb)
        return int(msg.id)
    except Exception as e:
        log.warning("canonical publish failed: %s", e)
        return None


async def cache_details(details: dict, mt: str) -> dict:
    title = title_of(details, mt)
    original = details.get("original_title") if mt == "movie" else details.get("original_name")
    aliases = {norm_query(title), norm_query(original or "")}
    aliases.discard("")
    caption = format_caption(details, mt)
    doc_id = f"{mt}:{int(details['id'])}"
    existing = await movies.find_one({"_id": doc_id})
    canonical_id = existing.get("canonical_message_id") if existing else None
    if not canonical_id:
        canonical_id = await publish_canonical(details, mt, caption)
    doc = {
        "_id": doc_id,
        "tmdb_id": int(details["id"]),
        "media_type": mt,
        "title": title,
        "normalized_title": norm_query(title),
        "aliases": list(aliases),
        "poster_path": details.get("poster_path"),
        "release_date": release_of(details, mt),
        "tmdb_rating": details.get("vote_average"),
        "caption": caption,
        "details": details,
        "canonical_message_id": canonical_id,
        "updated_at": now_ts(),
    }
    await movies.update_one({"_id": doc_id}, {"$set": doc}, upsert=True)
    return doc


async def find_cached(query: str) -> Optional[dict]:
    n = norm_query(query)
    if not n:
        return None
    doc = await movies.find_one({"$or": [{"aliases": n}, {"normalized_title": n}]})
    if not doc:
        return None
    if now_ts() - int(doc.get("updated_at", 0)) > CACHE_DAYS * 86400:
        return None
    return doc


async def send_cached(uid: int, doc: dict):
    if doc.get("canonical_message_id") and LOG_CHANNEL:
        try:
            await app.copy_message(uid, LOG_CHANNEL, int(doc["canonical_message_id"]))
            await bump("cache_hits")
            return
        except Exception:
            pass
    details = doc.get("details") or {}
    mt = doc.get("media_type") or "movie"
    kb = movie_keyboard(details, mt)
    if doc.get("poster_path"):
        with contextlib.suppress(Exception):
            await app.send_photo(uid, f"{TMDB_IMAGE_BASE}{doc['poster_path']}", caption=doc.get("caption", "")[:1024], reply_markup=kb)
            return
    await app.send_message(uid, doc.get("caption", "Movie found."), reply_markup=kb)


# ---------------- JOIN GATE ----------------
async def joined(uid: int, channel: str) -> bool:
    if not channel:
        return True
    try:
        m = await app.get_chat_member(channel, uid)
        return m.status in {"owner", "administrator", "member", "restricted"}
    except Exception:
        return False


async def join_ok(uid: int) -> bool:
    s = await get_settings()
    if not s.get("join_gate_enabled", False):
        return True
    ch = [x for x in (REQUIRED_CHANNEL_1, REQUIRED_CHANNEL_2) if x]
    return all(await joined(uid, x) for x in ch)


def join_keyboard():
    rows = []
    if REQUIRED_CHANNEL_1_URL:
        rows.append([InlineKeyboardButton("🔗 JOIN CHANNEL 01", url=REQUIRED_CHANNEL_1_URL)])
    if REQUIRED_CHANNEL_2_URL:
        rows.append([InlineKeyboardButton("🔗 JOIN CHANNEL 02", url=REQUIRED_CHANNEL_2_URL)])
    rows.append([InlineKeyboardButton("✅ I'VE JOINED", callback_data="verify_join")])
    return InlineKeyboardMarkup(rows)


# ---------------- USER UI ----------------
def home_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🔎 SEARCH MOVIE", callback_data="search_help")],
        [InlineKeyboardButton("🆕 UPCOMING", callback_data="upcoming_help"), InlineKeyboardButton("✅ RELEASED", callback_data="released_help")],
        [InlineKeyboardButton("💎 REFERRAL", callback_data="referral")],
        [InlineKeyboardButton("🤖 BOT STATUS", callback_data="status")],
    ])


def admin_keyboard(s: dict):
    keys = [
        ("movie_search_enabled", "Movie Search"),
        ("released_enabled", "Released"),
        ("upcoming_enabled", "Upcoming"),
        ("join_gate_enabled", "Join Gate"),
        ("canonical_cache_enabled", "Channel Cache"),
        ("referral_enabled", "Referral"),
        ("analytics_enabled", "Analytics"),
        ("broadcast_enabled", "Broadcast"),
        ("maintenance_mode", "Maintenance"),
    ]
    rows = []
    for i in range(0, len(keys), 2):
        row = []
        for k, label in keys[i:i+2]:
            row.append(InlineKeyboardButton(("🟢 " if s.get(k) else "🔴 ") + label, callback_data=f"toggle:{k}"))
        rows.append(row)
    rows += [
        [InlineKeyboardButton("📊 Analytics", callback_data="admin_analytics"), InlineKeyboardButton("👥 Users", callback_data="admin_users")],
        [InlineKeyboardButton("📢 Broadcast", callback_data="admin_broadcast")],
    ]
    return InlineKeyboardMarkup(rows)


async def maintenance_block(msg) -> bool:
    s = await get_settings()
    if s.get("maintenance_mode") and not is_admin(msg.from_user.id):
        await msg.reply_text("🛠 <b>Bot Maintenance</b>\n\nThe bot is currently under maintenance. Please try again later.")
        return True
    return False


# ---------------- SEARCH CORE ----------------
async def process_search(message, query: str, mode: str = "search"):
    uid = int(message.from_user.id)
    s = await get_settings()
    if mode == "search" and not s.get("movie_search_enabled", True):
        return await message.reply_text("❌ Movie search is disabled by admin.")
    if mode == "released" and not s.get("released_enabled", True):
        return await message.reply_text("❌ Released search is disabled.")
    if mode == "upcoming" and not s.get("upcoming_enabled", True):
        return await message.reply_text("❌ Upcoming search is disabled.")
    if await maintenance_block(message):
        return
    if not await join_ok(uid):
        return await message.reply_text("🔐 <b>Join required channel(s) first.</b>", reply_markup=join_keyboard())
    query = (query or "").strip()
    if not query:
        return await message.reply_text("Send a movie/series name, e.g. <code>mirjapur</code>")

    # Exact cache only for normal search; special modes always verify date.
    if mode == "search":
        cached = await find_cached(query)
        if cached:
            return await send_cached(uid, cached)

    status = await message.reply_text("🔎 <b>Searching…</b>")
    try:
        results = await tmdb_search(query)
        if mode == "released":
            results = [x for x in results if is_released(x)]
        elif mode == "upcoming":
            results = [x for x in results if is_upcoming(x)]

        if not results:
            # spelling-assist path: ask AI to clean the query, then search again.
            corrected = await ai_chat(
                "Correct this movie/series search query. Return ONLY the corrected title, no quotes. "
                f"Query: {query}"
            )
            if corrected and norm_query(corrected) != norm_query(query):
                results = await tmdb_search(corrected.strip())
                if mode == "released":
                    results = [x for x in results if is_released(x)]
                elif mode == "upcoming":
                    results = [x for x in results if is_upcoming(x)]

        if not results:
            return await status.edit_text("❌ No matching movie/series found. Try another spelling.")

        ranking = await rank_candidates(query, results)
        ordered = [results[i-1] for i in ranking if 1 <= i <= len(results)]
        if not ordered:
            ordered = results

        if len(ordered) == 1:
            item = ordered[0]
            details = await tmdb_details(item["media_type"], int(item["id"]))
            doc = await cache_details(details, item["media_type"])
            await status.delete()
            await send_cached(uid, doc)
            await bump("searches")
            return

        rows = []
        for item in ordered[:SEARCH_LIMIT]:
            mt = item["media_type"]
            icon = "🎬" if mt == "movie" else "📺"
            date = release_of(item, mt) or "----"
            rows.append([InlineKeyboardButton(f"{icon} {title_of(item, mt)[:48]} ({date[:4]})", callback_data=f"pick:{mt}:{int(item['id'])}")])
        rows.append([InlineKeyboardButton("❌ Close", callback_data="close")])
        await status.edit_text("🎯 <b>Select the correct title:</b>", reply_markup=InlineKeyboardMarkup(rows))
        search_state[uid] = {"query": query, "mode": mode}
        await bump("searches")
    except Exception as e:
        log.exception("search error")
        await status.edit_text(f"❌ Search failed.\n\n<code>{esc(str(e))[:800]}</code>")


# ---------------- COMMANDS / MESSAGE ----------------
@app.on_message(filters.command("start") & filters.private)
async def start_cmd(client, message):
    user = await ensure_user(message.from_user)
    uid = int(message.from_user.id)
    if user.get("banned"):
        return await message.reply_text("🚫 You are banned.")
    args = message.command[1:] if len(message.command) > 1 else []
    s = await get_settings()
    if args and args[0].startswith("ref_") and s.get("referral_enabled", True):
        with contextlib.suppress(Exception):
            ref = int(args[0].split("_", 1)[1])
            if ref != uid:
                old = await users.find_one({"_id": uid}, {"referred_by": 1})
                if old and not old.get("referred_by"):
                    await users.update_one({"_id": uid}, {"$set": {"referred_by": ref}})
                    await users.update_one({"_id": ref}, {"$inc": {"referrals": 1, "points": 10}})
                    await bump("referrals")
    if s.get("maintenance_mode") and not is_admin(uid):
        return await message.reply_text("🛠 <b>Bot Maintenance</b>\n\nThe bot is currently under maintenance. Please try again later.")
    await message.reply_text(
        f"👋 <b>Welcome, {esc(message.from_user.first_name or 'User')}!</b>\n\n"
        "🎬 <b>Movie Search Bot</b>\n"
        "Send any movie or series name. Spelling mistakes are handled and repeated results are cached.",
        reply_markup=home_keyboard(),
    )


@app.on_message(filters.command("search") & filters.private)
async def search_cmd(client, message):
    await ensure_user(message.from_user)
    await process_search(message, " ".join(message.command[1:]), "search")


@app.on_message(filters.command("upcoming") & filters.private)
async def upcoming_cmd(client, message):
    await ensure_user(message.from_user)
    await process_search(message, " ".join(message.command[1:]), "upcoming")


@app.on_message(filters.command("released") & filters.private)
async def released_cmd(client, message):
    await ensure_user(message.from_user)
    await process_search(message, " ".join(message.command[1:]), "released")


@app.on_message(filters.text & filters.private & ~filters.command(["start", "search", "upcoming", "released", "admin", "stats", "ban", "unban", "broadcast", "maintenance", "ping"]))
async def plain_search(client, message):
    if await maintenance_block(message):
        return
    await ensure_user(message.from_user)
    if await is_banned(message.from_user.id):
        return await message.reply_text("🚫 You are banned.")
    await process_search(message, message.text, "search")


# ---------------- CALLBACKS ----------------

# ---------------- INLINE SEARCH ----------------
@app.on_inline_query()
async def inline_search(client, query):
    q = (query.query or "").strip()
    if not q:
        await query.answer([], cache_time=2, is_personal=True)
        return
    uid = int(query.from_user.id)
    try:
        if await is_banned(uid) and not is_admin(uid):
            await query.answer([], cache_time=1, is_personal=True)
            return
        s = await get_settings()
        if s.get("maintenance_mode") and not is_admin(uid):
            await query.answer([], cache_time=1, is_personal=True)
            return
        if not s.get("movie_search_enabled", True):
            await query.answer([], cache_time=2, is_personal=True)
            return
        results = await tmdb_search(q)
        from pyrogram.types import InlineQueryResultArticle, InputTextMessageContent
        inline_results = []
        for item in results[:SEARCH_LIMIT]:
            mt = item.get("media_type")
            tid = int(item.get("id"))
            title = title_of(item, mt)
            year = (release_of(item, mt) or "")[:4] or "----"
            desc = (item.get("overview") or "").replace("\n", " ")[:120]
            text = f"🔎 {title} ({year})\n\n/search {title}"
            inline_results.append(
                InlineQueryResultArticle(
                    id=f"{mt}:{tid}",
                    title=f"{'🎬' if mt == 'movie' else '📺'} {title} ({year})",
                    description=desc or "Open movie details",
                    input_message_content=InputTextMessageContent(text),
                )
            )
        await query.answer(inline_results, cache_time=30, is_personal=False, switch_pm_text="Open Movie Bot", switch_pm_parameter="start")
    except Exception:
        await query.answer([], cache_time=1, is_personal=True)

@app.on_callback_query()
async def callbacks(client, q):
    uid = int(q.from_user.id)
    data = q.data or ""
    if await is_banned(uid) and not is_admin(uid):
        return await q.answer("🚫 Banned", show_alert=True)
    s = await get_settings()

    if data == "verify_join":
        ok = await join_ok(uid)
        return await q.answer("✅ Join verified." if ok else "❌ Join all required channels first.", show_alert=True)
    if data == "close":
        return await q.message.delete()
    if data == "status":
        return await q.answer("🛠 Maintenance mode" if s.get("maintenance_mode") and not is_admin(uid) else "✅ Bot is active", show_alert=True)
    if data == "search_help":
        return await q.message.edit_text("🔎 <b>Search</b>\n\nSend the movie/series name directly, or use <code>/search title</code>.", reply_markup=home_keyboard())
    if data == "upcoming_help":
        return await q.message.edit_text("🆕 <b>Upcoming</b>\n\nUse <code>/upcoming title</code> or send a title after tapping search.", reply_markup=home_keyboard())
    if data == "released_help":
        return await q.message.edit_text("✅ <b>Released</b>\n\nUse <code>/released title</code>.", reply_markup=home_keyboard())
    if data == "referral":
        me = await client.get_me()
        u = await users.find_one({"_id": uid}) or {}
        link = f"https://t.me/{me.username}?start=ref_{uid}"
        return await q.message.edit_text(
            "💎 <b>Referral</b>\n\n"
            f"👥 Referrals: <b>{int(u.get('referrals', 0))}</b>\n"
            f"💎 Points: <b>{int(u.get('points', 0))}</b>\n\n"
            f"🔗 <code>{esc(link)}</code>",
            reply_markup=home_keyboard(),
        )
    if data.startswith("pick:"):
        if not await join_ok(uid) and not is_admin(uid):
            return await q.answer("Join required channels first.", show_alert=True)
        try:
            _, mt, sid = data.split(":", 2)
            details = await tmdb_details(mt, int(sid))
            doc = await cache_details(details, mt)
            await q.message.delete()
            await send_cached(uid, doc)
            return await q.answer("✅ Done")
        except Exception as e:
            return await q.answer(f"Error: {str(e)[:120]}", show_alert=True)

    if uid != ADMIN_ID:
        return await q.answer("🚫 Admin only", show_alert=True)
    if data.startswith("toggle:"):
        key = data.split(":", 1)[1]
        if key not in DEFAULT_SETTINGS:
            return await q.answer("Unknown setting", show_alert=True)
        new = not bool(s.get(key, False))
        await set_setting(key, new)
        s = await get_settings()
        return await q.message.edit_text("👑 <b>ADMIN PANEL</b>", reply_markup=admin_keyboard(s))
    if data == "admin_analytics":
        docs = await analytics.find().sort("_id", DESCENDING).limit(7).to_list(7)
        txt = ["📊 <b>Analytics</b>", ""]
        for d in docs:
            txt.append(f"<b>{esc(d.get('_id'))}</b> — users {d.get('new_users',0)} | searches {d.get('searches',0)} | cache {d.get('cache_hits',0)}")
        return await q.message.edit_text("\n".join(txt), reply_markup=admin_keyboard(s))
    if data == "admin_users":
        total = await users.count_documents({})
        banned = await users.count_documents({"banned": True})
        return await q.message.edit_text(f"👥 <b>Users</b>\n\nTotal: <b>{total}</b>\nBanned: <b>{banned}</b>", reply_markup=admin_keyboard(s))
    if data == "admin_broadcast":
        return await q.answer("Use /broadcast TEXT", show_alert=True)


# ---------------- ADMIN COMMANDS ----------------
@app.on_message(filters.command("admin") & filters.private)
async def admin_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    s = await get_settings()
    await message.reply_text("👑 <b>MASTER ADMIN PANEL — MOVIE BOT ONLY</b>", reply_markup=admin_keyboard(s))


@app.on_message(filters.command("stats") & filters.private)
async def stats_cmd(client, message):
    if not is_admin(message.from_user.id):
        return
    us = await users.count_documents({}); ms = await movies.count_documents({})
    await message.reply_text(f"📊 <b>Stats</b>\n\n👥 Users: <b>{us}</b>\n🎬 Cached titles: <b>{ms}</b>")


@app.on_message(filters.command("ban") & filters.private)
async def ban_cmd(client, message):
    if not is_admin(message.from_user.id): return
    if len(message.command) < 2: return await message.reply_text("Usage: /ban USER_ID")
    try: uid = int(message.command[1])
    except: return await message.reply_text("Invalid USER_ID")
    await users.update_one({"_id": uid}, {"$set": {"banned": True}}, upsert=True)
    await message.reply_text(f"🚫 Banned <code>{uid}</code>")


@app.on_message(filters.command("unban") & filters.private)
async def unban_cmd(client, message):
    if not is_admin(message.from_user.id): return
    if len(message.command) < 2: return await message.reply_text("Usage: /unban USER_ID")
    try: uid = int(message.command[1])
    except: return await message.reply_text("Invalid USER_ID")
    await users.update_one({"_id": uid}, {"$set": {"banned": False}}, upsert=True)
    await message.reply_text(f"✅ Unbanned <code>{uid}</code>")


@app.on_message(filters.command("maintenance") & filters.private)
async def maintenance_cmd(client, message):
    if not is_admin(message.from_user.id): return
    if len(message.command) < 2 or message.command[1].lower() not in {"on", "off"}:
        s = await get_settings(); return await message.reply_text(f"Maintenance: {'ON' if s.get('maintenance_mode') else 'OFF'}\nUse /maintenance on|off")
    active = message.command[1].lower() == "on"
    await set_setting("maintenance_mode", active)
    await message.reply_text("🛠 Maintenance ON" if active else "✅ Bot is Active")


@app.on_message(filters.command("broadcast") & filters.private)
async def broadcast_cmd(client, message):
    if not is_admin(message.from_user.id): return
    s = await get_settings()
    if not s.get("broadcast_enabled", True): return await message.reply_text("❌ Broadcast disabled")
    text = " ".join(message.command[1:]).strip()
    if not text: return await message.reply_text("Usage: /broadcast MESSAGE")
    sent = failed = 0
    async for d in users.find({"banned": {"$ne": True}}, {"_id": 1}):
        try:
            await client.send_message(int(d["_id"]), text[:4000]); sent += 1
        except FloodWait as e:
            await asyncio.sleep(e.value)
            with contextlib.suppress(Exception):
                await client.send_message(int(d["_id"]), text[:4000]); sent += 1
        except Exception:
            failed += 1
        if (sent + failed) % 25 == 0: await asyncio.sleep(1)
    await message.reply_text(f"📢 Broadcast complete\n✅ {sent}\n❌ {failed}")


@app.on_message(filters.command("ping") & filters.private)
async def ping_cmd(client, message):
    await message.reply_text("🏓 <b>PONG</b>\n\n✅ Movie Search Bot is online.")


@app.on_message(filters.command("diagnose") & filters.private)
async def diagnose_cmd(client, message):
    if not is_admin(message.from_user.id): return
    s = await get_settings()
    await message.reply_text(
        "🩺 <b>MOVIE BOT DIAGNOSTICS</b>\n\n"
        f"Bot: {'SET' if BOT_TOKEN else 'MISSING'}\n"
        f"Mongo: {'SET' if MONGO_URI else 'MISSING'}\n"
        f"TMDB: {'SET' if (TMDB_API_TOKEN or TMDB_API_KEY) else 'MISSING'}\n"
        f"TMDB language: {esc(TMDB_LANGUAGE)}\n"
        f"Region: {esc(TMDB_REGION)}\n"
        f"Movie Search: {'ON' if s.get('movie_search_enabled') else 'OFF'}\n"
        f"Upcoming: {'ON' if s.get('upcoming_enabled') else 'OFF'}\n"
        f"Released: {'ON' if s.get('released_enabled') else 'OFF'}\n"
        f"Join Gate: {'ON' if s.get('join_gate_enabled') else 'OFF'}\n"
        f"Canonical Cache: {'ON' if s.get('canonical_cache_enabled') else 'OFF'}\n"
        f"AI: {AI_PROVIDER} / {'configured' if (GEMINI_API_KEY or GROQ_API_KEY or OPENAI_API_KEY) else 'off'}"
    )


# ---------------- HEALTH SERVER ----------------
async def health(_request):
    return web.json_response({"ok": True, "service": "movie-search-bot", "time": now_ts()})


async def main():
    required = [("API_ID", API_ID), ("API_HASH", API_HASH), ("BOT_TOKEN", BOT_TOKEN), ("MONGO_URI", MONGO_URI), ("ADMIN_ID", ADMIN_ID)]
    missing = [k for k, v in required if not v]
    if missing:
        raise RuntimeError("Missing environment variables: " + ", ".join(missing))

    # Index creation is best-effort so a transient Mongo issue does not prevent Telegram startup.
    for collection, spec in (
        (users, [("banned", ASCENDING)]),
        (users, [("referred_by", ASCENDING)]),
        (movies, [("aliases", ASCENDING)]),
        (movies, [("normalized_title", ASCENDING)]),
        (movies, [("release_date", ASCENDING)]),
        (movies, [("updated_at", DESCENDING)]),
    ):
        with contextlib.suppress(Exception):
            await collection.create_index(spec)
    with contextlib.suppress(Exception):
        await settings_col.update_one({"_id": "global"}, {"$setOnInsert": DEFAULT_SETTINGS}, upsert=True)

    web_app = web.Application()
    web_app.router.add_get("/", health)
    web_app.router.add_get("/health", health)
    runner = web.AppRunner(web_app, access_log=log)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()
    log.info("Web server listening on %s", PORT)

    if TMDB_API_TOKEN or TMDB_API_KEY:
        log.info("TMDB credential configured: %s", "Bearer token" if TMDB_API_TOKEN else "v3 API key")
    else:
        log.warning("TMDB credential missing; bot will stay online but movie search cannot work.")

    try:
        # Use Pyrofork's managed client.run() loop; it avoids the manual start/asyncio.run
        # lifecycle that can leave dispatcher tasks attached to a closing loop during Render deploys.
        await app.start()
        me = await app.get_me()
        log.info("Movie bot started as @%s", me.username)
        await idle()
    finally:
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
