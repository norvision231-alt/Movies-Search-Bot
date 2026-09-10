import os
import asyncio
import contextlib
import html
import logging
import math
import re
import secrets
import signal
import string
import time
from datetime import datetime, timezone
from typing import Optional

from aiohttp import web
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, DESCENDING
from pyrogram import Client, filters
from pyrogram.errors import FloodWait
from pyrogram.types import InlineKeyboardButton, InlineKeyboardMarkup

# ============================================================
# FILE STORE + MOVIE SEARCH BOT — FINAL V13 (Python 3.11 / Render safe)
# ============================================================
# Scope of this version:
#   Telegram file upload -> private Telegram storage channel
#   -> MongoDB metadata -> secure deep link -> controlled download
#
# Deliberately removed for now:
#   - StreamHG
#   - FTP
#   - Watch Online / WebApp streaming
#   - Stream encoding workers
#
# When Oracle worker is ready, streaming can be added as a separate module.
#
# Maintenance behavior:
#   /maintenance on  = logical maintenance mode + user announcement
#   /maintenance off = bot active + user announcement
#
# IMPORTANT:
#   A process that is truly powered OFF cannot send Telegram messages.
#   Therefore "bot off" is implemented as MAINTENANCE MODE while the bot
#   remains online enough to answer users with the maintenance notice.
# ============================================================


# ============================================================
# 1) CONFIGURATION
# ============================================================
API_ID = int(os.environ.get("API_ID", "0"))
API_HASH = os.environ.get("API_HASH", "")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
MONGO_URI = os.environ.get("MONGO_URI", "")
LOG_CHANNEL = int(os.environ.get("LOG_CHANNEL", "0"))
ADMIN_ID = int(os.environ.get("ADMIN_ID", "0"))
PORT = int(os.environ.get("PORT", "10000"))

# Movie Search / TMDB configuration
TMDB_API_TOKEN = os.environ.get("TMDB_API_TOKEN", "").strip()
TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "").strip()
TMDB_LANGUAGE = os.environ.get("TMDB_LANGUAGE", "en-US").strip()
TMDB_REGION = os.environ.get("TMDB_REGION", "IN").strip()
MOVIE_WEBSITE_URL = os.environ.get("MOVIE_WEBSITE_URL", "").strip().rstrip("/")
MOVIE_TRAILER_BUTTON = os.environ.get("MOVIE_TRAILER_BUTTON", "1").lower() in {"1", "true", "yes", "on"}
MOVIE_PUBLISH_TO_CHANNEL = os.environ.get("MOVIE_PUBLISH_TO_CHANNEL", "1").lower() in {"1", "true", "yes", "on"}
REQUIRED_CHANNEL_1 = os.environ.get("REQUIRED_CHANNEL_1", "").strip()
REQUIRED_CHANNEL_2 = os.environ.get("REQUIRED_CHANNEL_2", "").strip()
REQUIRED_CHANNEL_1_URL = os.environ.get("REQUIRED_CHANNEL_1_URL", "").strip()
REQUIRED_CHANNEL_2_URL = os.environ.get("REQUIRED_CHANNEL_2_URL", "").strip()
JOIN_GATE_ENABLED = os.environ.get("JOIN_GATE_ENABLED", "1").lower() in {"1", "true", "yes", "on"}
MOVIE_CACHE_TTL_DAYS = int(os.environ.get("MOVIE_CACHE_TTL_DAYS", "30"))
MOVIE_SEARCH_LIMIT = max(1, min(int(os.environ.get("MOVIE_SEARCH_LIMIT", "6")), 10))

MAX_FILE_GB = float(os.environ.get("MAX_FILE_GB", "5"))
MAX_FILE_BYTES = int(MAX_FILE_GB * 1024 ** 3)

BRANDING_TEXT = os.environ.get("BRANDING_TEXT", "🤖 Powered by Open Book")
OFFICIAL_CHANNEL_URL = os.environ.get("OFFICIAL_CHANNEL_URL", "https://t.me/openbook506")
YOUTUBE_URL = os.environ.get("YOUTUBE_URL", "https://youtube.com/@openbook506")
INSTAGRAM_URL = os.environ.get("INSTAGRAM_URL", "https://instagram.com/openbook506")

BLOCKED_UPLOAD_KEYWORDS = tuple(
    k.strip().lower()
    for k in os.environ.get(
        "BLOCKED_UPLOAD_KEYWORDS", "porn,xxx,sex,nude,childporn"
    ).split(",")
    if k.strip()
)

DEFAULT_SETTINGS = {
    "registration_enabled": True,
    "upload_enabled": True,
    "link_generation_enabled": True,
    "download_enabled": True,
    "password_enabled": True,
    "expiry_enabled": True,
    "one_time_enabled": True,
    "broadcast_enabled": True,
    "referral_enabled": True,
    "analytics_enabled": True,
    "maintenance_mode": False,
    "movie_search_enabled": True,
    "upcoming_enabled": True,
    "released_enabled": True,
    "movie_publish_enabled": MOVIE_PUBLISH_TO_CHANNEL,
    "movie_join_gate_enabled": JOIN_GATE_ENABLED,
    "max_file_bytes": MAX_FILE_BYTES,
}


# ============================================================
# 2) LOGGING
# ============================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
log = logging.getLogger("file-store-bot")


# ============================================================
# 3) CLIENT + DATABASE
# ============================================================
app = Client(
    "MovieFileStoreBotV12",
    api_id=API_ID,
    api_hash=API_HASH,
    bot_token=BOT_TOKEN,
    workers=8,
)

db_client = AsyncIOMotorClient(MONGO_URI, maxPoolSize=40, minPoolSize=1)
db = db_client[os.environ.get("MONGO_DB_NAME", "file_store_bot")]

users_col = db["users"]
files_col = db["files"]
settings_col = db["settings"]
analytics_col = db["analytics"]
movie_col = db["movies"]

# Short-lived interaction state. Permanent state stays in MongoDB.
upload_states: dict[int, dict] = {}
pwd_wait: dict[int, str] = {}
admin_broadcast_wait: set[int] = set()


# ============================================================
# 4) GENERAL HELPERS
# ============================================================
def now_ts() -> int:
    return int(time.time())


def utc_iso(ts: Optional[int] = None) -> str:
    return datetime.fromtimestamp(ts or now_ts(), tz=timezone.utc).isoformat()


def generate_random_id(length: int = 12) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def humanbytes(size: Optional[int]) -> str:
    if not size:
        return "0 B"
    value = float(size)
    units = ["B", "KB", "MB", "GB", "TB"]
    idx = 0
    while value >= 1024 and idx < len(units) - 1:
        value /= 1024
        idx += 1
    return f"{value:.2f} {units[idx]}"


def safe_filename(name: Optional[str], fallback: str = "file") -> str:
    name = name or fallback
    name = name.replace("\\", "_").replace("/", "_")
    name = re.sub(r"[^A-Za-z0-9._()\- ]+", "_", name).strip(" .") or fallback
    return name[:180]


def get_media_size(message) -> int:
    for attr in ("video", "document", "animation", "audio", "voice", "video_note", "photo"):
        media = getattr(message, attr, None)
        if media and getattr(media, "file_size", None):
            return int(media.file_size)
    return 0


def get_media_name(message) -> str:
    for attr in ("video", "document", "animation", "audio", "voice", "video_note", "photo"):
        media = getattr(message, attr, None)
        if media:
            return safe_filename(
                getattr(media, "file_name", None)
                or getattr(media, "file_unique_id", None),
                fallback=f"telegram_{message.id}",
            )
    return f"telegram_{message.id}"


def text_has_blocked_keyword(text: str) -> Optional[str]:
    lower = (text or "").lower()
    for keyword in BLOCKED_UPLOAD_KEYWORDS:
        if keyword and keyword in lower:
            return keyword
    return None


def is_admin(user_id: int) -> bool:
    return int(user_id) == ADMIN_ID


def is_media_message(message) -> bool:
    return bool(
        message.photo
        or message.video
        or message.document
        or message.animation
        or message.audio
        or message.voice
        or message.video_note
    )


# ============================================================
# 5) SETTINGS / ANALYTICS / USERS
# ============================================================
async def get_settings() -> dict:
    doc = await settings_col.find_one({"_id": "global"})
    if not doc:
        await settings_col.update_one(
            {"_id": "global"},
            {"$set": DEFAULT_SETTINGS},
            upsert=True,
        )
        return dict(DEFAULT_SETTINGS)

    merged = dict(DEFAULT_SETTINGS)
    merged.update(doc)
    return merged


async def set_setting(key: str, value) -> None:
    await settings_col.update_one(
        {"_id": "global"},
        {"$set": {key: value}},
        upsert=True,
    )


async def bump_analytics(event: str, value: int = 1) -> None:
    settings = await get_settings()
    if not settings.get("analytics_enabled", True):
        return
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        await analytics_col.update_one(
            {"_id": day},
            {
                "$inc": {event: value},
                "$set": {"updated_at": now_ts()},
            },
            upsert=True,
        )
    except Exception:
        log.exception("analytics update failed")


async def get_or_create_user(user) -> dict:
    uid = int(user.id)
    doc = await users_col.find_one({"_id": uid})
    if doc:
        await users_col.update_one(
            {"_id": uid},
            {
                "$set": {
                    "username": user.username or None,
                    "first_name": user.first_name or None,
                    "last_name": user.last_name or None,
                    "updated_at": now_ts(),
                }
            },
        )
        doc.update(
            {
                "username": user.username,
                "first_name": user.first_name,
                "last_name": user.last_name,
            }
        )
        return doc

    settings = await get_settings()
    if not settings.get("registration_enabled", True) and not is_admin(uid):
        return {}

    doc = {
        "_id": uid,
        "username": user.username or None,
        "first_name": user.first_name or None,
        "last_name": user.last_name or None,
        "lang": "en",
        "banned": False,
        "upload_enabled": True,
        "link_enabled": True,
        "download_enabled": True,
        "points": 0,
        "referrals": 0,
        "created_at": now_ts(),
        "updated_at": now_ts(),
    }
    try:
        await users_col.insert_one(doc)
        await bump_analytics("new_users")
        return doc
    except Exception:
        return await users_col.find_one({"_id": uid}) or {}


async def is_banned(user_id: int) -> bool:
    doc = await users_col.find_one({"_id": int(user_id)}, {"banned": 1})
    return bool(doc and doc.get("banned", False))


async def admin_log(text: str, exc: Optional[BaseException] = None):
    if exc:
        log.error(text, exc_info=exc)
    else:
        log.error(text)
    if not ADMIN_ID or not BOT_TOKEN:
        return
    try:
        message = f"🚨 <b>ADMIN ALERT</b>\n\n{html.escape(text)}"
        if exc:
            message += f"\n\n<code>{html.escape(str(exc))[:2500]}</code>"
        await app.send_message(ADMIN_ID, message)
    except Exception:
        pass


# ============================================================
# 6) MAINTENANCE / ACTIVE STATUS
# ============================================================
MAINTENANCE_MESSAGE = (
    "🛠 <b>Bot Maintenance</b>\n\n"
    "The bot is currently under maintenance.\n"
    "Please try again later.\n\n"
    "⏳ Services will return automatically when maintenance ends."
)

ACTIVE_MESSAGE = (
    "✅ <b>Bot is Active</b>\n\n"
    "All normal file-store services are online."
)


async def broadcast_system_status(active: bool) -> tuple[int, int]:
    settings = await get_settings()
    if not settings.get("broadcast_enabled", True):
        return 0, 0

    text = ACTIVE_MESSAGE if active else MAINTENANCE_MESSAGE
    sent = failed = 0

    cursor = users_col.find(
        {"banned": {"$ne": True}},
        {"_id": 1},
    )
    async for doc in cursor:
        uid = int(doc["_id"])
        try:
            await app.send_message(uid, text)
            sent += 1
        except FloodWait as exc:
            await asyncio.sleep(exc.value)
            try:
                await app.send_message(uid, text)
                sent += 1
            except Exception:
                failed += 1
        except Exception:
            failed += 1

        # Gentle Telegram pacing.
        if (sent + failed) % 25 == 0:
            await asyncio.sleep(1)

    return sent, failed


async def set_maintenance(active: bool, announce: bool = True) -> tuple[int, int]:
    await set_setting("maintenance_mode", bool(active))
    if not announce:
        return 0, 0
    return await broadcast_system_status(not active)


async def maintenance_reply(message) -> bool:
    uid = int(message.from_user.id)
    if is_admin(uid):
        return False
    settings = await get_settings()
    if settings.get("maintenance_mode", False):
        await message.reply_text(MAINTENANCE_MESSAGE)
        return True
    return False


# ============================================================
# 7) USER MENUS
# ============================================================
def user_dashboard_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("🎬 Movie Search", callback_data="movie_help")],
            [InlineKeyboardButton("📤 Upload File", callback_data="user_upload_help")],
            [InlineKeyboardButton("📂 My Files", callback_data="my_files")],
            [InlineKeyboardButton("📊 My Stats", callback_data="my_stats")],
            [InlineKeyboardButton("💎 Rewards & Referrals", callback_data="refer")],
            [InlineKeyboardButton("✅ Bot Status", callback_data="bot_status")],
        ]
    )


def settings_menu(state: dict, settings: dict) -> InlineKeyboardMarkup:
    expiry_mode = int(state.get("expiry_mode", 0))
    expiry_label = {
        0: "Never",
        1: "1 Hour",
        2: "24 Hours",
        3: "1-View",
    }.get(expiry_mode, "Never")

    rows = [
        [InlineKeyboardButton(f"⏳ Expiry: {expiry_label}", callback_data="set_expiry")],
        [InlineKeyboardButton("📝 Edit Caption", callback_data="edit_cap")],
        [InlineKeyboardButton("🔒 Set Password", callback_data="edit_pwd")],
        [InlineKeyboardButton("✅ CREATE LINK", callback_data="generate_link")],
        [InlineKeyboardButton("❌ Cancel", callback_data="cancel_upload")],
    ]
    return InlineKeyboardMarkup(rows)


# ============================================================
# 8) ADMIN MENUS
# ============================================================
ADMIN_TOGGLE_KEYS = [
    "registration_enabled",
    "upload_enabled",
    "link_generation_enabled",
    "download_enabled",
    "password_enabled",
    "expiry_enabled",
    "one_time_enabled",
    "broadcast_enabled",
    "referral_enabled",
    "analytics_enabled",
    "maintenance_mode",
    "movie_search_enabled",
    "upcoming_enabled",
    "released_enabled",
    "movie_publish_enabled",
    "movie_join_gate_enabled",
]

ADMIN_LABELS = {
    "registration_enabled": "Registration",
    "upload_enabled": "Upload",
    "link_generation_enabled": "Link Generation",
    "download_enabled": "Download",
    "password_enabled": "Password",
    "expiry_enabled": "Expiry",
    "one_time_enabled": "One-Time Link",
    "broadcast_enabled": "Broadcast",
    "referral_enabled": "Referral",
    "analytics_enabled": "Analytics",
    "maintenance_mode": "Maintenance",
    "movie_search_enabled": "Movie Search",
    "upcoming_enabled": "Upcoming Movies",
    "released_enabled": "Released Filter",
    "movie_publish_enabled": "Movie Channel Cache",
    "movie_join_gate_enabled": "Movie Join Gate",
}


def admin_menu(settings: dict) -> InlineKeyboardMarkup:
    rows = []
    for i in range(0, len(ADMIN_TOGGLE_KEYS), 2):
        row = []
        for key in ADMIN_TOGGLE_KEYS[i:i + 2]:
            on = bool(settings.get(key, False))
            icon = "🟢" if on else "🔴"
            row.append(
                InlineKeyboardButton(
                    f"{icon} {ADMIN_LABELS[key]}",
                    callback_data=f"toggle:{key}",
                )
            )
        rows.append(row)

    rows.extend(
        [
            [InlineKeyboardButton("📊 Analytics", callback_data="admin:analytics")],
            [InlineKeyboardButton("👥 Users", callback_data="admin:users")],
            [InlineKeyboardButton("📁 Recent Files", callback_data="admin:files")],
            [InlineKeyboardButton("📢 Broadcast", callback_data="admin:broadcast")],
        ]
    )
    return InlineKeyboardMarkup(rows)


async def render_admin_panel() -> tuple[str, InlineKeyboardMarkup]:
    s = await get_settings()
    text = (
        "👑 <b>MASTER ADMIN PANEL</b>\n\n"
        f"📤 Upload: {'ON' if s['upload_enabled'] else 'OFF'}\n"
        f"🔗 Links: {'ON' if s['link_generation_enabled'] else 'OFF'}\n"
        f"📥 Download: {'ON' if s['download_enabled'] else 'OFF'}\n"
        f"🔒 Password: {'ON' if s['password_enabled'] else 'OFF'}\n"
        f"⏳ Expiry: {'ON' if s['expiry_enabled'] else 'OFF'}\n"
        f"1️⃣ One-Time: {'ON' if s['one_time_enabled'] else 'OFF'}\n"
        f"📢 Broadcast: {'ON' if s['broadcast_enabled'] else 'OFF'}\n"
        f"🛠 Maintenance: {'ON' if s['maintenance_mode'] else 'OFF'}\n\n"
        f"📦 Max File: <b>{humanbytes(int(s.get('max_file_bytes', MAX_FILE_BYTES)))}</b>\n"
        f"📚 Version: <code>MovieStore V12</code>"
    )
    return text, admin_menu(s)


# ============================================================
# 9) ACCESS RULES
# ============================================================
async def user_feature_allowed(user_id: int, key: str) -> bool:
    settings = await get_settings()
    if settings.get("maintenance_mode", False) and not is_admin(user_id):
        return False
    if not settings.get(key, False):
        return False

    user = await users_col.find_one({"_id": int(user_id)})
    if not user or user.get("banned"):
        return False

    user_key = {
        "link_generation_enabled": "link_enabled",
        "download_enabled": "download_enabled",
        "upload_enabled": "upload_enabled",
    }.get(key)
    if user_key and user.get(user_key) is False:
        return False
    return True


async def file_access_allowed(user_id: int, file_doc: dict, action: str) -> tuple[bool, str]:
    settings = await get_settings()
    if settings.get("maintenance_mode") and not is_admin(user_id):
        return False, "🛠 Bot is under maintenance."
    if await is_banned(user_id):
        return False, "🚫 You are banned."

    if action == "link" and not await user_feature_allowed(user_id, "link_generation_enabled"):
        return False, "❌ Link generation is disabled."
    if action == "download" and not await user_feature_allowed(user_id, "download_enabled"):
        return False, "❌ Download is currently disabled."

    if file_doc.get("disabled"):
        return False, "❌ This file has been disabled by admin."

    expires_at = file_doc.get("expires_at")
    if expires_at and now_ts() > int(expires_at):
        return False, "❌ This link has expired."

    if action == "download" and not file_doc.get("allow_download", True):
        return False, "❌ Download is disabled for this file."

    return True, "OK"


# ============================================================
# 9A) MOVIE SEARCH / TMDB
# ============================================================
TMDB_BASE = "https://api.themoviedb.org/3"
TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500"


def normalize_query(text: str) -> str:
    text = (text or "").lower().strip()
    text = re.sub(r"\b(19|20)\d{2}\b", " ", text)
    text = re.sub(r"[^\w\s]+", " ", text, flags=re.UNICODE)
    text = re.sub(r"\b(season|s\d+|episode|ep)\b", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def tmdb_headers() -> dict:
    headers = {"accept": "application/json"}
    token = TMDB_API_TOKEN or TMDB_API_KEY
    if TMDB_API_TOKEN:
        headers["Authorization"] = f"Bearer {TMDB_API_TOKEN}"
    return headers


async def tmdb_get(path: str, params: dict | None = None) -> dict:
    if not (TMDB_API_TOKEN or TMDB_API_KEY):
        raise RuntimeError("TMDB_API_TOKEN/TMDB_API_KEY is not configured.")
    import aiohttp
    query = dict(params or {})
    if not TMDB_API_TOKEN and TMDB_API_KEY:
        query["api_key"] = TMDB_API_KEY
    timeout = aiohttp.ClientTimeout(total=20)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(f"{TMDB_BASE}{path}", params=query, headers=tmdb_headers()) as resp:
            if resp.status == 429:
                raise RuntimeError("TMDB rate limit reached. Please try again shortly.")
            if resp.status >= 400:
                body = await resp.text()
                raise RuntimeError(f"TMDB HTTP {resp.status}: {body[:300]}")
            return await resp.json()


async def tmdb_search(query: str) -> list[dict]:
    data = await tmdb_get(
        "/search/multi",
        {
            "query": query,
            "include_adult": "false",
            "language": TMDB_LANGUAGE,
            "page": 1,
        },
    )
    results = []
    for item in data.get("results", []):
        if item.get("media_type") not in {"movie", "tv"}:
            continue
        if not item.get("id"):
            continue
        results.append(item)
    return results[:MOVIE_SEARCH_LIMIT]


async def tmdb_details(media_type: str, tmdb_id: int) -> dict:
    endpoint = f"/{media_type}/{int(tmdb_id)}"
    return await tmdb_get(
        endpoint,
        {
            "language": TMDB_LANGUAGE,
            "append_to_response": "credits,videos,external_ids",
        },
    )


def first_trailer_url(details: dict) -> str | None:
    videos = (details.get("videos") or {}).get("results") or []
    preferred = [v for v in videos if v.get("site") == "YouTube" and v.get("type") in {"Trailer", "Teaser"}]
    preferred.sort(key=lambda x: (x.get("official") is not True, x.get("published_at") or ""))
    if preferred:
        return f"https://www.youtube.com/watch?v={preferred[0].get('key')}"
    return None


def director_name(details: dict) -> str | None:
    for c in ((details.get("credits") or {}).get("crew") or []):
        if c.get("job") == "Director":
            return c.get("name")
    return None


def top_cast(details: dict, limit: int = 5) -> list[str]:
    return [x.get("name") for x in ((details.get("credits") or {}).get("cast") or [])[:limit] if x.get("name")]


def movie_release_date(details: dict, media_type: str) -> str:
    return (details.get("release_date") if media_type == "movie" else details.get("first_air_date")) or ""


def format_movie_caption(details: dict, media_type: str, *, include_source: bool = True) -> str:
    title = details.get("title") if media_type == "movie" else details.get("name")
    original = details.get("original_title") if media_type == "movie" else details.get("original_name")
    title = title or original or "Unknown"
    release = movie_release_date(details, media_type) or "N/A"
    genres = ", ".join(g.get("name") for g in (details.get("genres") or []) if g.get("name")) or "N/A"
    langs = ", ".join(details.get("spoken_languages") and [x.get("english_name") or x.get("iso_639_1") for x in details.get("spoken_languages", []) if x.get("english_name") or x.get("iso_639_1")] or [])
    if not langs:
        langs = details.get("original_language") or "N/A"
    countries = ", ".join(x.get("name") for x in (details.get("production_countries") or []) if x.get("name")) or "N/A"
    rating = details.get("vote_average")
    rating_text = f"{float(rating):.1f}/10" if isinstance(rating, (int, float)) else "N/A"
    overview = re.sub(r"\s+", " ", details.get("overview") or "No description available.").strip()
    cast = top_cast(details)
    director = director_name(details)

    if media_type == "movie":
        runtime = details.get("runtime")
        runtime_text = f"{runtime} min" if runtime else "N/A"
        extra = [
            f"⏱️ <b>Runtime:</b> {runtime_text}",
            f"📅 <b>Release:</b> {html.escape(release)}",
        ]
    else:
        seasons = details.get("number_of_seasons") or "N/A"
        episodes = details.get("number_of_episodes") or "N/A"
        extra = [
            f"📺 <b>Seasons:</b> {seasons}",
            f"⏱️ <b>Episodes:</b> {episodes}",
            f"📅 <b>First Air:</b> {html.escape(release)}",
        ]

    lines = [
        f"🔥 <b>{html.escape(title)}</b>",
        "",
        f"⭐ <b>TMDB Rating:</b> {rating_text}",
        f"🇮🇳 <b>Language:</b> {html.escape(langs)}",
        f"🎭 <b>Genre:</b> {html.escape(genres)}",
        *extra,
        f"🌍 <b>Country:</b> {html.escape(countries)}",
    ]
    if original and original != title:
        lines.append(f"📝 <b>Original:</b> {html.escape(original)}")
    if director:
        lines.append(f"🎬 <b>Director:</b> {html.escape(director)}")
    if cast:
        lines.append(f"👥 <b>Cast:</b> {html.escape(', '.join(cast))}")
    lines += [
        "",
        f"📖 <b>Overview:</b> {html.escape(overview[:1200])}",
        "",
        "━━━━━━━━━━━━━━",
    ]
    if include_source:
        lines.append("ℹ️ <i>Metadata source: The Movie Database (TMDB)</i>")
    return "\n".join(lines)


def movie_buttons(details: dict, media_type: str, movie_doc_id: str | None = None) -> InlineKeyboardMarkup:
    title = details.get("title") if media_type == "movie" else details.get("name")
    tmdb_id = int(details.get("id"))
    rows = []
    if MOVIE_WEBSITE_URL:
        slug = re.sub(r"[^a-zA-Z0-9]+", "-", (title or "movie")).strip("-").lower()
        watch_url = f"{MOVIE_WEBSITE_URL}/watch/{media_type}/{tmdb_id}/{slug}"
        rows.append([InlineKeyboardButton("▶️ WATCH HERE", url=watch_url)])
    trailer = first_trailer_url(details)
    if MOVIE_TRAILER_BUTTON and trailer:
        rows.append([InlineKeyboardButton("🎬 TRAILER", url=trailer)])
    imdb_id = ((details.get("external_ids") or {}).get("imdb_id"))
    if imdb_id:
        rows.append([InlineKeyboardButton("⭐ IMDb", url=f"https://www.imdb.com/title/{imdb_id}/")])
    rows.append([InlineKeyboardButton("📤 SHARE", switch_inline_query=(title or "movie"))])
    return InlineKeyboardMarkup(rows)


async def member_joined(client, user_id: int, channel: str) -> bool:
    if not channel:
        return True
    try:
        member = await client.get_chat_member(channel, user_id)
        return member.status in {"owner", "administrator", "member", "restricted"}
    except Exception:
        return False


async def movie_join_gate(client, user_id: int) -> bool:
    settings = await get_settings()
    if not settings.get("movie_join_gate_enabled", False):
        return True
    channels = [x for x in (REQUIRED_CHANNEL_1, REQUIRED_CHANNEL_2) if x]
    if not channels:
        return True
    return all(await member_joined(client, user_id, ch) for ch in channels)


def movie_join_keyboard() -> InlineKeyboardMarkup:
    rows = []
    if REQUIRED_CHANNEL_1_URL:
        rows.append([InlineKeyboardButton("🔗 JOIN CHANNEL 01", url=REQUIRED_CHANNEL_1_URL)])
    if REQUIRED_CHANNEL_2_URL:
        rows.append([InlineKeyboardButton("🔗 JOIN CHANNEL 02", url=REQUIRED_CHANNEL_2_URL)])
    rows.append([InlineKeyboardButton("✅ I'VE JOINED", callback_data="movie_verify_join")])
    return InlineKeyboardMarkup(rows)


async def send_movie_join_gate(message):
    return await message.reply_text(
        "🔐 <b>Join Required</b>\n\nJoin the required channel(s), then tap <b>I'VE JOINED</b> to continue.",
        reply_markup=movie_join_keyboard(),
    )


async def load_cached_movie(query: str) -> dict | None:
    norm = normalize_query(query)
    if not norm:
        return None
    doc = await movie_col.find_one({"aliases": norm})
    if not doc:
        doc = await movie_col.find_one({"normalized_title": norm})
    if not doc:
        return None
    if now_ts() - int(doc.get("updated_at", 0)) > MOVIE_CACHE_TTL_DAYS * 86400:
        return None
    return doc


async def publish_movie_to_storage(client, details: dict, media_type: str, caption: str) -> tuple[int, int] | tuple[None, None]:
    settings = await get_settings()
    if not settings.get("movie_publish_enabled", True):
        return None, None
    try:
        await ensure_storage_chat(client)
        poster_path = details.get("poster_path")
        title = details.get("title") if media_type == "movie" else details.get("name")
        markup = movie_buttons(details, media_type)
        if poster_path:
            stored = await client.send_photo(
                LOG_CHANNEL,
                photo=f"{TMDB_IMAGE_BASE}{poster_path}",
                caption=caption[:1024],
                reply_markup=markup,
            )
        else:
            stored = await client.send_message(LOG_CHANNEL, caption[:4096], reply_markup=markup)
        return int(LOG_CHANNEL), int(stored.id)
    except Exception as exc:
        log.warning("Movie private-channel publish failed: %s", exc)
        return None, None


async def cache_movie(client, details: dict, media_type: str) -> dict:
    title = details.get("title") if media_type == "movie" else details.get("name")
    original = details.get("original_title") if media_type == "movie" else details.get("original_name")
    aliases = {normalize_query(title or ""), normalize_query(original or "")}
    aliases.discard("")
    caption = format_movie_caption(details, media_type)
    storage_chat, storage_message = await publish_movie_to_storage(client, details, media_type, caption)
    now = now_ts()
    doc = {
        "_id": f"{media_type}:{int(details['id'])}",
        "tmdb_id": int(details["id"]),
        "media_type": media_type,
        "title": title,
        "normalized_title": normalize_query(title or ""),
        "original_title": original,
        "aliases": list(aliases),
        "caption": caption,
        "poster_path": details.get("poster_path"),
        "release_date": movie_release_date(details, media_type),
        "tmdb_rating": details.get("vote_average"),
        "storage_chat_id": storage_chat,
        "storage_message_id": storage_message,
        "updated_at": now,
        "created_at": now,
    }
    await movie_col.update_one({"_id": doc["_id"]}, {"$set": doc}, upsert=True)
    return doc


async def send_movie_result(client, user_id: int, doc: dict) -> None:
    # Prefer the canonical private-channel message to make repeat searches instant.
    if doc.get("storage_chat_id") and doc.get("storage_message_id"):
        try:
            await client.copy_message(
                chat_id=user_id,
                from_chat_id=int(doc["storage_chat_id"]),
                message_id=int(doc["storage_message_id"]),
            )
            await bump_analytics("movie_cache_hits")
            return
        except Exception:
            log.exception("Movie canonical message copy failed; using cached metadata")
    poster_path = doc.get("poster_path")
    markup = None
    try:
        details = await tmdb_details(doc["media_type"], int(doc["tmdb_id"]))
        markup = movie_buttons(details, doc["media_type"])
    except Exception:
        pass
    if poster_path:
        try:
            await client.send_photo(
                user_id,
                photo=f"{TMDB_IMAGE_BASE}{poster_path}",
                caption=doc.get("caption", "")[:1024],
                reply_markup=markup,
            )
            return
        except Exception:
            pass
    await client.send_message(user_id, doc.get("caption", "Movie found."), reply_markup=markup)


async def search_movies_for_user(client, message, query: str, mode: str = "search"):
    settings = await get_settings()
    if mode == "search" and not settings.get("movie_search_enabled", True):
        return await message.reply_text("❌ Movie Search is disabled by admin.")
    if mode == "upcoming" and not settings.get("upcoming_enabled", True):
        return await message.reply_text("❌ Upcoming is disabled by admin.")
    if mode == "released" and not settings.get("released_enabled", True):
        return await message.reply_text("❌ Released search is disabled by admin.")

    user_id = int(message.from_user.id)
    if not await movie_join_gate(client, user_id):
        return await send_movie_join_gate(message)

    query = (query or "").strip()
    if not query:
        return await message.reply_text("Usage: <code>/search MOVIE NAME</code>")

    cached = await load_cached_movie(query)
    if cached and mode == "search":
        return await send_movie_result(client, user_id, cached)

    status = await message.reply_text("🔎 <b>Searching…</b>")
    try:
        if mode == "search":
            results = await tmdb_search(query)
        elif mode == "released":
            results = [r for r in await tmdb_search(query) if (r.get("release_date") or r.get("first_air_date") or "9999") <= datetime.now(timezone.utc).strftime("%Y-%m-%d")]
        else:
            results = [r for r in await tmdb_search(query) if (r.get("release_date") or r.get("first_air_date") or "") > datetime.now(timezone.utc).strftime("%Y-%m-%d")]

        if not results:
            return await status.edit_text("❌ No matching title found.")

        if len(results) == 1:
            item = results[0]
            details = await tmdb_details(item["media_type"], int(item["id"]))
            doc = await cache_movie(client, details, item["media_type"])
            await status.delete()
            return await send_movie_result(client, user_id, doc)

        rows = []
        for item in results:
            title = item.get("title") or item.get("name") or "Unknown"
            date = item.get("release_date") or item.get("first_air_date") or "----"
            typ = "🎬" if item.get("media_type") == "movie" else "📺"
            rows.append([InlineKeyboardButton(f"{typ} {title[:42]} ({date[:4]})", callback_data=f"mselect:{item['media_type']}:{int(item['id'])}")])
        rows.append([InlineKeyboardButton("❌ Close", callback_data="movie_close")])
        await status.edit_text("🎬 <b>Select a title:</b>", reply_markup=InlineKeyboardMarkup(rows))
        await bump_analytics("movie_searches")
    except Exception as exc:
        log.exception("TMDB search failed")
        await status.edit_text(f"❌ Search failed.\n\n<code>{html.escape(str(exc))[:1000]}</code>")


@app.on_message(filters.command(["search", "movie", "movies", "upcoming", "released"]) & filters.private)
async def movie_command(client, message):
    cmd = (message.command[0] or "").lower()
    query = " ".join(message.command[1:]).strip() if len(message.command) > 1 else ""
    mode = "upcoming" if cmd == "upcoming" else "released" if cmd == "released" else "search"
    await search_movies_for_user(client, message, query, mode)


# ============================================================
# 10) TELEGRAM COMMANDS — BASIC
# ============================================================
@app.on_message(filters.command("ping") & filters.private)
async def ping_command(client, message):
    await message.reply_text(
        "🏓 <b>PONG</b>\n\n"
        "✅ Telegram bot is online.\n"
        "✅ Handlers are responding."
    )


@app.on_message(filters.command("start") & filters.private)
async def start_handler(client, message):
    user_id = int(message.from_user.id)
    user = await get_or_create_user(message.from_user)
    if not user:
        return await message.reply_text("❌ Registration is currently disabled.")
    if user.get("banned"):
        return await message.reply_text("🚫 You are banned from using this bot.")

    settings = await get_settings()
    if settings.get("maintenance_mode") and not is_admin(user_id):
        return await message.reply_text(MAINTENANCE_MESSAGE)

    args = message.command[1:] if len(message.command) > 1 else []
    if args:
        payload = args[0]

        if payload.startswith("ref_"):
            try:
                referrer = int(payload.split("_", 1)[1])
            except Exception:
                referrer = None

            if (
                referrer
                and referrer != user_id
                and settings.get("referral_enabled", True)
            ):
                existing = await users_col.find_one({"_id": user_id}, {"referred_by": 1})
                if existing and not existing.get("referred_by"):
                    await users_col.update_one(
                        {"_id": user_id},
                        {"$set": {"referred_by": referrer}},
                    )
                    await users_col.update_one(
                        {"_id": referrer},
                        {"$inc": {"points": 10, "referrals": 1}},
                    )
                    await bump_analytics("referrals")

            return await message.reply_text(
                f"✅ <b>Bot is Active</b>\n\n"
                "Upload a file to create a secure Telegram link.",
                reply_markup=user_dashboard_menu(),
            )

        file_id = payload
        file_doc = await files_col.find_one({"_id": file_id})
        if not file_doc:
            return await message.reply_text("❌ File not found.")
        if not file_doc.get("owner"):
            return await message.reply_text("❌ Invalid file.")

        ok, reason = await file_access_allowed(user_id, file_doc, "link")
        if not ok:
            return await message.reply_text(reason)

        if file_doc.get("password"):
            pwd_wait[user_id] = file_id
            return await message.reply_text("🔒 Password protected. Send the password:")

        return await serve_file(client, user_id, file_doc)

    if user_id == ADMIN_ID:
        text, markup = await render_admin_panel()
        return await message.reply_text(text, reply_markup=markup)

    await message.reply_text(
        f"👋 <b>Welcome, {html.escape(message.from_user.first_name or 'User')}!</b>\n\n"
        "✅ <b>Bot is Active</b>\n\n"
        "📤 Send me a file to create a secure link.",
        reply_markup=user_dashboard_menu(),
    )


@app.on_message(filters.command("admin") & filters.private)
async def admin_command(client, message):
    if not is_admin(message.from_user.id):
        return
    text, markup = await render_admin_panel()
    await message.reply_text(text, reply_markup=markup)


@app.on_message(filters.command("id") & filters.private)
async def id_command(client, message):
    if message.reply_to_message and message.reply_to_message.forward_from_chat:
        chat_id = message.reply_to_message.forward_from_chat.id
    else:
        chat_id = message.chat.id
    await message.reply_text(f"🆔 <code>{chat_id}</code>")


@app.on_message(filters.command("maintenance") & filters.private)
async def maintenance_command(client, message):
    if not is_admin(message.from_user.id):
        return

    if len(message.command) < 2 or message.command[1].lower() not in {"on", "off"}:
        s = await get_settings()
        return await message.reply_text(
            f"🛠 Maintenance: <b>{'ON' if s.get('maintenance_mode') else 'OFF'}</b>\n\n"
            "Usage:\n"
            "<code>/maintenance on</code>\n"
            "<code>/maintenance off</code>"
        )

    active = message.command[1].lower() == "on"
    await set_setting("maintenance_mode", active)
    await message.reply_text(
        "🛠 <b>Maintenance ON</b>\n\nUsers will receive the maintenance message."
        if active
        else
        "✅ <b>Bot is Active</b>\n\nNormal services are enabled again."
    )

    # Announce only after the setting is successfully changed.
    sent, failed = await broadcast_system_status(active=not active)
    await message.reply_text(
        f"📢 Status announcement finished.\n✅ Sent: {sent}\n❌ Failed: {failed}"
    )


# ============================================================
# 11) UPLOAD FLOW
# ============================================================
@app.on_message(filters.media & filters.private)
async def handle_media(client, message):
    user_id = int(message.from_user.id)
    user = await get_or_create_user(message.from_user)
    if not user:
        return await message.reply_text("❌ Registration is disabled.")
    if user.get("banned"):
        return await message.reply_text("🚫 You are banned.")

    if await maintenance_reply(message):
        return

    settings = await get_settings()
    if not settings.get("upload_enabled", True) or not user.get("upload_enabled", True):
        return await message.reply_text("❌ Upload is currently disabled.")

    size = get_media_size(message)
    if size <= 0:
        return await message.reply_text("❌ Could not determine file size.")

    max_bytes = int(settings.get("max_file_bytes", MAX_FILE_BYTES))
    if size > max_bytes:
        return await message.reply_text(
            f"❌ File is too large. Maximum allowed: {humanbytes(max_bytes)}\n"
            f"Your file: {humanbytes(size)}"
        )

    title_for_filter = f"{get_media_name(message)}\n{message.caption or ''}"
    blocked = text_has_blocked_keyword(title_for_filter)
    if blocked and not is_admin(user_id):
        await bump_analytics("blocked_uploads")
        return await message.reply_text("🚫 Upload rejected by the bot's content keyword filter.")

    upload_states[user_id] = {
        "message_id": int(message.id),
        "size": size,
        "filename": get_media_name(message),
        "caption": message.caption or "",
        "password": None,
        "allow_download": True,
        "expiry_mode": 0,
        "step": None,
    }

    await message.reply_text(
        "⚙️ <b>File Settings</b>\n\n"
        "Choose the access rules. Nothing becomes public until you press CREATE LINK.",
        reply_markup=settings_menu(upload_states[user_id], settings),
    )


# ============================================================
# 12) USER CALLBACKS + ADMIN CALLBACKS
# ============================================================
@app.on_callback_query()
async def callbacks(client, query):
    user_id = int(query.from_user.id)
    data = query.data or ""

    if await is_banned(user_id) and user_id != ADMIN_ID:
        return await query.answer("🚫 Banned.", show_alert=True)

    settings = await get_settings()

    if data == "movie_help":
        return await query.message.edit_text(
            "🎬 <b>Movie Search</b>\n\n"
            "Use <code>/search movie name</code>\n"
            "<code>/upcoming movie name</code>\n"
            "<code>/released movie name</code>\n\n"
            "Results are cached so repeat searches can be served instantly.",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Back", callback_data="user_back")]]),
        )

    if data == "movie_verify_join":
        if await movie_join_gate(client, user_id):
            return await query.answer("✅ Join verified.", show_alert=True)
        return await query.answer("❌ Please join all required channels first.", show_alert=True)

    if data == "movie_close":
        return await query.message.delete()

    if data.startswith("mselect:"):
        if not settings.get("movie_search_enabled", True):
            return await query.answer("Movie Search is disabled.", show_alert=True)
        if not await movie_join_gate(client, user_id):
            return await query.answer("Join required channels first.", show_alert=True)
        try:
            _, media_type, raw_id = data.split(":", 2)
            tmdb_id = int(raw_id)
            cache_id = f"{media_type}:{tmdb_id}"
            doc = await movie_col.find_one({"_id": cache_id})
            if not doc:
                await query.answer("Fetching details…")
                details = await tmdb_details(media_type, tmdb_id)
                doc = await cache_movie(client, details, media_type)
            else:
                await query.answer("Opening…")
            await send_movie_result(client, user_id, doc)
            with contextlib.suppress(Exception):
                await query.message.delete()
            return
        except Exception as exc:
            return await query.answer(f"Error: {str(exc)[:150]}", show_alert=True)

    if data == "bot_status":
        if settings.get("maintenance_mode") and user_id != ADMIN_ID:
            return await query.answer("🛠 Bot is under maintenance.", show_alert=True)
        return await query.answer("✅ Bot is active.", show_alert=True)

    if settings.get("maintenance_mode") and user_id != ADMIN_ID:
        return await query.answer("🛠 Bot is under maintenance.", show_alert=True)

    # ---------------- USER ----------------
    if data == "user_upload_help":
        return await query.message.edit_text(
            "📤 <b>Upload</b>\n\n"
            "Send a file directly to this private chat.\n"
            "The bot will save a private Telegram backup first, then create a secure link."
        )

    if data == "refer":
        user = await users_col.find_one({"_id": user_id}) or {}
        me = await client.get_me()
        link = f"https://t.me/{me.username}?start=ref_{user_id}"
        return await query.message.edit_text(
            "💎 <b>Rewards & Referrals</b>\n\n"
            f"👥 Referrals: <b>{int(user.get('referrals', 0))}</b>\n"
            f"💎 Gems: <b>{int(user.get('points', 0))}</b>\n\n"
            f"🔗 <code>{html.escape(link)}</code>",
            reply_markup=InlineKeyboardMarkup(
                [[InlineKeyboardButton("🔙 Back", callback_data="user_back")]]
            ),
        )

    if data == "my_stats":
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        doc = await analytics_col.find_one(day) or {}
        mine = await files_col.count_documents({"owner": user_id})
        return await query.message.edit_text(
            "📊 <b>My Stats</b>\n\n"
            f"📁 My Files: <b>{mine}</b>\n"
            f"📅 Today's bot uploads: <b>{int(doc.get('uploads', 0))}</b>",
            reply_markup=InlineKeyboardMarkup(
                [[InlineKeyboardButton("🔙 Back", callback_data="user_back")]]
            ),
        )

    if data == "my_files":
        docs = (
            await files_col.find({"owner": user_id})
            .sort("created_at", DESCENDING)
            .limit(10)
            .to_list(10)
        )
        if not docs:
            text = "📂 <b>My Files</b>\n\nNo files yet."
        else:
            lines = ["📂 <b>My Files</b>", ""]
            for d in docs:
                status = "✅ Active" if not d.get("disabled") else "❌ Disabled"
                lines.append(
                    f"<code>{html.escape(d['_id'])}</code> — "
                    f"{humanbytes(int(d.get('size', 0)))} — {status}"
                )
            text = "\n".join(lines)
        return await query.message.edit_text(
            text,
            reply_markup=InlineKeyboardMarkup(
                [[InlineKeyboardButton("🔙 Back", callback_data="user_back")]]
            ),
        )

    if data == "user_back":
        return await query.message.edit_text(
            "👤 <b>User Panel</b>",
            reply_markup=user_dashboard_menu(),
        )

    # ---------------- UPLOAD SETTINGS ----------------
    state = upload_states.get(user_id)
    if state and data in {"set_down", "set_expiry", "edit_cap", "edit_pwd", "generate_link", "back_settings", "cancel_upload"}:
        if data == "cancel_upload":
            upload_states.pop(user_id, None)
            return await query.message.edit_text("✅ Upload cancelled.")

        if data == "set_expiry":
            if not settings.get("expiry_enabled", True):
                return await query.answer("Admin has disabled Expiry.", show_alert=True)
            state["expiry_mode"] = (int(state.get("expiry_mode", 0)) + 1) % 4
            if state["expiry_mode"] == 3 and not settings.get("one_time_enabled", True):
                state["expiry_mode"] = 0
            return await query.message.edit_reply_markup(settings_menu(state, settings))

        if data == "edit_cap":
            state["step"] = "wait_caption"
            return await query.message.edit_text(
                "📝 <b>Send the new caption.</b>",
                reply_markup=InlineKeyboardMarkup(
                    [[InlineKeyboardButton("🔙 Back", callback_data="back_settings")]]
                ),
            )

        if data == "edit_pwd":
            if not settings.get("password_enabled", True):
                return await query.answer("Admin has disabled Password.", show_alert=True)
            state["step"] = "wait_pwd"
            return await query.message.edit_text(
                "🔒 <b>Send a password.</b>\nMinimum 4 characters.",
                reply_markup=InlineKeyboardMarkup(
                    [[InlineKeyboardButton("🔙 Back", callback_data="back_settings")]]
                ),
            )

        if data == "back_settings":
            state["step"] = None
            return await query.message.edit_text(
                "⚙️ <b>File Settings</b>\n\nPress CREATE LINK when ready.",
                reply_markup=settings_menu(state, settings),
            )

        if data == "generate_link":
            return await finalize_upload(client, user_id, query.message)

    # ---------------- DOWNLOAD ----------------
    if data.startswith("dl:"):
        file_id = data.split(":", 1)[1]
        file_doc = await files_col.find_one({"_id": file_id})
        if not file_doc:
            return await query.answer("File not found.", show_alert=True)

        ok, reason = await file_access_allowed(user_id, file_doc, "download")
        if not ok:
            return await query.answer(reason.replace("❌ ", "")[:180], show_alert=True)

        await query.answer("Preparing file…")
        try:
            fresh = await files_col.find_one({"_id": file_id})
            if not fresh or fresh.get("disabled"):
                return await query.message.reply_text("❌ This file is no longer available.")

            await ensure_storage_chat(client)
            await client.copy_message(
                chat_id=user_id,
                from_chat_id=int(fresh["storage_chat_id"]),
                message_id=int(fresh["msg_id"]),
                caption=(fresh.get("caption") or "").strip() or None,
                protect_content=True,
            )
            await files_col.update_one(
                {"_id": file_id},
                {"$inc": {"download_count": 1}},
            )
            await bump_analytics("downloads")

            if fresh.get("is_one_time"):
                await files_col.update_one(
                    {"_id": file_id},
                    {
                        "$set": {
                            "disabled": True,
                            "one_time_used_by": user_id,
                            "one_time_used_at": now_ts(),
                        }
                    },
                )
        except Exception as exc:
            await admin_log(f"download failed: {file_id}", exc)
            await query.message.reply_text("❌ Download failed. Please try again.")
        return

    # ---------------- ADMIN ----------------
    if user_id != ADMIN_ID:
        if data.startswith("toggle:") or data.startswith("admin:"):
            return await query.answer("🚫 Admin only.", show_alert=True)
        return

    if data.startswith("toggle:"):
        key = data.split(":", 1)[1]
        if key not in ADMIN_TOGGLE_KEYS:
            return await query.answer("Unknown setting.", show_alert=True)

        new_value = not bool(settings.get(key, False))
        await set_setting(key, new_value)
        await bump_analytics("admin_settings_changed")

        if key == "maintenance_mode":
            text, markup = await render_admin_panel()
            await query.message.edit_text(text, reply_markup=markup)
            sent, failed = await broadcast_system_status(active=not new_value)
            await query.answer(
                f"Maintenance {'ON' if new_value else 'OFF'} | Sent {sent}, failed {failed}"
            )
            return

        text, markup = await render_admin_panel()
        await query.message.edit_text(text, reply_markup=markup)
        await query.answer(f"{ADMIN_LABELS[key]}: {'ON' if new_value else 'OFF'}")
        return

    if data == "admin:back":
        text, markup = await render_admin_panel()
        return await query.message.edit_text(text, reply_markup=markup)

    if data == "admin:analytics":
        days = await analytics_col.find().sort("_id", DESCENDING).limit(7).to_list(7)
        lines = ["📊 <b>Analytics — last 7 days</b>", ""]
        for d in days:
            lines.append(
                f"<b>{html.escape(str(d.get('_id')))}</b> — "
                f"users {d.get('new_users', 0)} | "
                f"uploads {d.get('uploads', 0)} | "
                f"downloads {d.get('downloads', 0)}"
            )
        return await query.message.edit_text(
            "\n".join(lines),
            reply_markup=InlineKeyboardMarkup(
                [[InlineKeyboardButton("🔙 Admin", callback_data="admin:back")]]
            ),
        )

    if data == "admin:users":
        total = await users_col.count_documents({})
        banned = await users_col.count_documents({"banned": True})
        active_uploaders = await files_col.distinct("owner")
        return await query.message.edit_text(
            f"👥 <b>Users</b>\n\n"
            f"Total: <b>{total}</b>\n"
            f"Banned: <b>{banned}</b>\n"
            f"Uploaders: <b>{len(active_uploaders)}</b>\n\n"
            "Use:\n"
            "<code>/ban USER_ID</code>\n"
            "<code>/unban USER_ID</code>\n"
            "<code>/user USER_ID</code>",
            reply_markup=InlineKeyboardMarkup(
                [[InlineKeyboardButton("🔙 Admin", callback_data="admin:back")]]
            ),
        )

    if data == "admin:files":
        docs = await files_col.find().sort("created_at", DESCENDING).limit(15).to_list(15)
        lines = ["📁 <b>Recent Files</b>", ""]
        for d in docs:
            status = "✅ Active" if not d.get("disabled") else "❌ Disabled"
            lines.append(
                f"<code>{html.escape(d['_id'])}</code> | "
                f"user <code>{d.get('owner')}</code> | "
                f"{humanbytes(int(d.get('size', 0)))} | {status}"
            )
        return await query.message.edit_text(
            "\n".join(lines),
            reply_markup=InlineKeyboardMarkup(
                [[InlineKeyboardButton("🔙 Admin", callback_data="admin:back")]]
            ),
        )

    if data == "admin:broadcast":
        admin_broadcast_wait.add(user_id)
        return await query.message.edit_text(
            "📢 <b>Broadcast</b>\n\n"
            "Send the broadcast text now.\n"
            "Use /cancel to abort."
        )


# ============================================================
# 13) TEXT INPUTS — PASSWORD / CAPTION / BROADCAST
# ============================================================
@app.on_message(
    filters.text
    & filters.private
    & ~filters.command([
        "start", "admin", "stats", "id", "ban", "unban", "user",
        "user_set", "file_set", "delete_file", "diagnose", "storage_test",
        "ping", "cancel", "maintenance", "search", "movie", "movies", "upcoming", "released",
    ])
)
async def text_inputs(client, message):
    user_id = int(message.from_user.id)
    text = message.text or ""

    if is_admin(user_id) and user_id in admin_broadcast_wait:
        settings = await get_settings()
        if not settings.get("broadcast_enabled", True):
            admin_broadcast_wait.discard(user_id)
            return await message.reply_text("❌ Broadcast is disabled.")

        admin_broadcast_wait.discard(user_id)
        await run_broadcast(text)
        return

    if await maintenance_reply(message):
        return

    if user_id in pwd_wait:
        file_id = pwd_wait.pop(user_id)
        file_doc = await files_col.find_one({"_id": file_id})
        if not file_doc:
            return await message.reply_text("❌ File not found.")
        try:
            correct = secrets.compare_digest(
                text,
                str(file_doc.get("password", "")),
            )
        except Exception:
            correct = False

        if correct:
            await message.reply_text("✅ Password correct.")
            return await serve_file(client, user_id, file_doc)

        await bump_analytics("wrong_password")
        return await message.reply_text("❌ Wrong password.")

    state = upload_states.get(user_id)
    if not state:
        return

    if state.get("step") == "wait_caption":
        state["caption"] = text[:950]
        state["step"] = None
        settings = await get_settings()
        return await message.reply_text(
            "✅ Caption updated.",
            reply_markup=settings_menu(state, settings),
        )

    if state.get("step") == "wait_pwd":
        if len(text) < 4:
            return await message.reply_text("⚠️ Minimum 4 characters.")
        state["password"] = text[:100]
        state["step"] = None
        settings = await get_settings()
        return await message.reply_text(
            "✅ Password set.",
            reply_markup=settings_menu(state, settings),
        )


# ============================================================
# 14) FINALIZE UPLOAD / STORAGE
# ============================================================
async def ensure_storage_chat(client, required: bool = True):
    if not LOG_CHANNEL:
        error = "LOG_CHANNEL is empty/zero."
        if required:
            raise RuntimeError(error)
        return None

    try:
        chat = await client.get_chat(LOG_CHANNEL)
        log.info(
            "Storage chat ready: id=%s title=%s",
            chat.id,
            getattr(chat, "title", None),
        )
        return chat
    except Exception as exc:
        log.error(
            "Storage chat resolve failed: LOG_CHANNEL=%s type=%s error=%s",
            LOG_CHANNEL,
            type(exc).__name__,
            exc,
        )
        if required:
            raise RuntimeError(
                f"Cannot resolve LOG_CHANNEL={LOG_CHANNEL}. "
                "Make the bot an admin/member of the private storage channel and verify the channel ID."
            ) from exc
        return None


async def finalize_upload(client, user_id: int, status_message):
    state = upload_states.get(user_id)
    if not state:
        return await status_message.edit_text("❌ Upload session expired. Send the file again.")

    settings = await get_settings()
    if not settings.get("link_generation_enabled", True):
        return await status_message.edit_text("❌ Admin has disabled link generation.")
    if not settings.get("upload_enabled", True):
        return await status_message.edit_text("❌ Admin has disabled uploads.")

    try:
        await status_message.edit_text("⏳ Saving private Telegram backup…")

        original = await client.get_messages(user_id, state["message_id"])
        if not original or not original.media:
            raise RuntimeError("Original Telegram message could not be retrieved.")

        await ensure_storage_chat(client)
        stored = await original.copy(LOG_CHANNEL)

        file_id = generate_random_id(12)
        expiry_mode = int(state.get("expiry_mode", 0))
        expires_at = None
        if expiry_mode == 1:
            expires_at = now_ts() + 3600
        elif expiry_mode == 2:
            expires_at = now_ts() + 86400

        user_doc = await users_col.find_one({"_id": user_id}, {"username": 1, "first_name": 1}) or {}

        audit = (
            f"\n\n👤 Uploader ID: <code>{user_id}</code>"
            f"\n📛 Username: <code>{html.escape(user_doc.get('username') or 'N/A')}</code>"
            f"\n🆔 File ID: <code>{file_id}</code>"
            f"\n📅 Uploaded: {utc_iso()}"
        )

        if os.environ.get("AUDIT_IN_CHANNEL_CAPTION", "1").lower() in {"1", "true", "yes"}:
            try:
                current_caption = (stored.caption or "").strip()
                max_len = max(0, 1024 - len(audit))
                new_caption = (current_caption[:max_len] + audit).strip()
                await client.edit_message_caption(
                    LOG_CHANNEL,
                    stored.id,
                    new_caption[:1024],
                )
            except Exception:
                # Mongo remains the authoritative metadata record.
                log.exception("Could not append audit caption to storage message")

        doc = {
            "_id": file_id,
            "owner": user_id,
            "owner_username": user_doc.get("username"),
            "owner_first_name": user_doc.get("first_name"),
            "msg_id": int(stored.id),
            "storage_chat_id": int(LOG_CHANNEL),
            "caption": state.get("caption", ""),
            "filename": state.get("filename"),
            "size": int(state.get("size", 0)),
            "password": state.get("password"),
            "allow_download": bool(state.get("allow_download", True)),
            "is_one_time": expiry_mode == 3,
            "expires_at": expires_at,
            "disabled": False,
            "created_at": now_ts(),
            "updated_at": now_ts(),
            "download_count": 0,
        }

        await files_col.insert_one(doc)
        await bump_analytics("uploads")

        me = await client.get_me()
        link = f"https://t.me/{me.username}?start={file_id}"

        await status_message.edit_text(
            "✅ <b>File secured successfully!</b>\n\n"
            f"🔗 <code>{html.escape(link)}</code>\n"
            f"📦 Size: {humanbytes(doc['size'])}\n"
            f"📥 Download: {'ON ✅' if doc['allow_download'] else 'OFF ❌'}\n"
            f"⏳ Expiry: {expiry_mode_label(expiry_mode)}\n\n"
            "Share this Telegram link with the intended users.",
            reply_markup=InlineKeyboardMarkup(
                [
                    [InlineKeyboardButton("📥 OPEN FILE", url=link)],
                    [InlineKeyboardButton("🔙 Home", callback_data="user_back")],
                ]
            ),
        )

        upload_states.pop(user_id, None)
        await bump_analytics("links_created")

    except Exception as exc:
        await admin_log(f"finalize_upload failed for user {user_id}", exc)
        await status_message.edit_text(
            f"❌ Could not secure file.\n\n<code>{html.escape(str(exc))[:1000]}</code>"
        )


def expiry_mode_label(mode: int) -> str:
    return {0: "Never", 1: "1 Hour", 2: "24 Hours", 3: "1-View"}.get(mode, "Never")


# ============================================================
# 15) FILE DELIVERY
# ============================================================
async def serve_file(client, user_id: int, file_doc: dict):
    ok, reason = await file_access_allowed(user_id, file_doc, "download")
    if not ok:
        return await app.send_message(user_id, reason)

    keyboard = InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("📥 GET FILE", callback_data=f"dl:{file_doc['_id']}")],
            [InlineKeyboardButton("📤 Share Link", switch_inline_query=f"{file_doc.get('filename', 'file')}")],
        ]
    )

    text = (
        "📁 <b>File Ready</b>\n\n"
        f"📄 <b>{html.escape(file_doc.get('filename') or 'File')}</b>\n"
        f"📦 Size: <b>{humanbytes(int(file_doc.get('size', 0)))}</b>\n"
        f"🔢 Downloads: <b>{int(file_doc.get('download_count', 0))}</b>\n\n"
        f"{BRANDING_TEXT}"
    )

    return await app.send_message(user_id, text, reply_markup=keyboard)


# ============================================================
# 16) ADMIN COMMANDS
# ============================================================
USER_FEATURE_MAP = {
    "upload": "upload_enabled",
    "link": "link_enabled",
    "download": "download_enabled",
}


@app.on_message(filters.command("stats") & filters.private)
async def stats_command(client, message):
    if not is_admin(message.from_user.id):
        return
    users = await users_col.count_documents({})
    files = await files_col.count_documents({})
    banned = await users_col.count_documents({"banned": True})
    downloads = await files_col.aggregate([
        {"$group": {"_id": None, "total": {"$sum": "$download_count"}}}
    ]).to_list(1)
    total_downloads = int(downloads[0]["total"]) if downloads else 0
    s = await get_settings()
    await message.reply_text(
        "📊 <b>BOT STATISTICS</b>\n\n"
        f"👥 Users: <b>{users}</b>\n"
        f"🚫 Banned: <b>{banned}</b>\n"
        f"📁 Files: <b>{files}</b>\n"
        f"📥 Downloads: <b>{total_downloads}</b>\n"
        f"🛠 Maintenance: <b>{'ON' if s.get('maintenance_mode') else 'OFF'}</b>"
    )


@app.on_message(filters.command("ban") & filters.private)
async def ban_command(client, message):
    if not is_admin(message.from_user.id):
        return
    if len(message.command) < 2:
        return await message.reply_text("Usage: /ban USER_ID")
    try:
        uid = int(message.command[1])
    except ValueError:
        return await message.reply_text("Invalid USER_ID")
    await users_col.update_one(
        {"_id": uid},
        {"$set": {"banned": True, "updated_at": now_ts()}},
        upsert=True,
    )
    await bump_analytics("bans")
    await message.reply_text(f"🚫 Banned <code>{uid}</code>")


@app.on_message(filters.command("unban") & filters.private)
async def unban_command(client, message):
    if not is_admin(message.from_user.id):
        return
    if len(message.command) < 2:
        return await message.reply_text("Usage: /unban USER_ID")
    try:
        uid = int(message.command[1])
    except ValueError:
        return await message.reply_text("Invalid USER_ID")
    await users_col.update_one(
        {"_id": uid},
        {"$set": {"banned": False, "updated_at": now_ts()}},
        upsert=True,
    )
    await bump_analytics("unbans")
    await message.reply_text(f"✅ Unbanned <code>{uid}</code>")


@app.on_message(filters.command("user") & filters.private)
async def user_command(client, message):
    if not is_admin(message.from_user.id):
        return
    if len(message.command) < 2:
        return await message.reply_text("Usage: /user USER_ID")
    try:
        uid = int(message.command[1])
    except ValueError:
        return await message.reply_text("Invalid USER_ID")

    u = await users_col.find_one({"_id": uid})
    if not u:
        return await message.reply_text("User not found.")
    uploads = await files_col.count_documents({"owner": uid})

    await message.reply_text(
        "👤 <b>User</b>\n\n"
        f"ID: <code>{uid}</code>\n"
        f"Username: @{html.escape(u.get('username') or '')}\n"
        f"Banned: <b>{u.get('banned', False)}</b>\n"
        f"Uploads: <b>{uploads}</b>\n"
        f"Points: <b>{u.get('points', 0)}</b>\n"
        f"Referrals: <b>{u.get('referrals', 0)}</b>\n\n"
        f"Upload: <b>{u.get('upload_enabled', True)}</b>\n"
        f"Link: <b>{u.get('link_enabled', True)}</b>\n"
        f"Download: <b>{u.get('download_enabled', True)}</b>"
    )


@app.on_message(filters.command("user_set") & filters.private)
async def user_set_command(client, message):
    if not is_admin(message.from_user.id):
        return
    if len(message.command) < 4:
        return await message.reply_text("Usage: /user_set USER_ID upload|link|download on|off")
    try:
        uid = int(message.command[1])
    except ValueError:
        return await message.reply_text("Invalid USER_ID")

    feature = message.command[2].lower()
    value = message.command[3].lower() in {"on", "1", "true", "yes"}
    field = USER_FEATURE_MAP.get(feature)
    if not field:
        return await message.reply_text("Feature must be upload, link or download.")

    await users_col.update_one(
        {"_id": uid},
        {"$set": {field: value, "updated_at": now_ts()}},
        upsert=True,
    )
    await message.reply_text(
        f"✅ User <code>{uid}</code>: {feature} = {'ON' if value else 'OFF'}"
    )


@app.on_message(filters.command("file_set") & filters.private)
async def file_set_command(client, message):
    if not is_admin(message.from_user.id):
        return
    if len(message.command) < 4:
        return await message.reply_text("Usage: /file_set FILE_ID download|disabled on|off")

    file_id = message.command[1]
    feature = message.command[2].lower()
    value = message.command[3].lower() in {"on", "1", "true", "yes"}
    field = {"download": "allow_download", "disabled": "disabled"}.get(feature)
    if not field:
        return await message.reply_text("Feature must be download or disabled.")

    result = await files_col.update_one(
        {"_id": file_id},
        {"$set": {field: value, "updated_at": now_ts()}},
    )
    if result.matched_count != 1:
        return await message.reply_text("File not found.")

    await message.reply_text(
        f"✅ File <code>{html.escape(file_id)}</code>: {feature} = {'ON' if value else 'OFF'}"
    )


@app.on_message(filters.command("delete_file") & filters.private)
async def delete_file_command(client, message):
    if not is_admin(message.from_user.id):
        return
    if len(message.command) < 2:
        return await message.reply_text("Usage: /delete_file FILE_ID")

    file_id = message.command[1]
    d = await files_col.find_one({"_id": file_id})
    if not d:
        return await message.reply_text("File not found.")

    await files_col.delete_one({"_id": file_id})
    with contextlib.suppress(Exception):
        await client.delete_messages(int(d["storage_chat_id"]), int(d["msg_id"]))
    await message.reply_text("✅ Mongo record + private Telegram storage copy deleted.")


# ============================================================
# 17) BROADCAST / CANCEL / DIAGNOSTICS
# ============================================================
async def run_broadcast(text: str):
    users = users_col.find({"banned": {"$ne": True}}, {"_id": 1})
    sent = failed = 0

    async for user in users:
        uid = int(user["_id"])
        try:
            await app.send_message(uid, text[:4000])
            sent += 1
        except FloodWait as exc:
            await asyncio.sleep(exc.value)
            try:
                await app.send_message(uid, text[:4000])
                sent += 1
            except Exception:
                failed += 1
        except Exception:
            failed += 1

        if (sent + failed) % 25 == 0:
            await asyncio.sleep(1)

    await admin_log(f"Broadcast finished: sent={sent}, failed={failed}")
    await app.send_message(
        ADMIN_ID,
        f"📢 <b>Broadcast complete</b>\n\n✅ Sent: {sent}\n❌ Failed: {failed}",
    )


@app.on_message(filters.command("cancel") & filters.private)
async def cancel_command(client, message):
    uid = int(message.from_user.id)
    admin_broadcast_wait.discard(uid)
    upload_states.pop(uid, None)
    pwd_wait.pop(uid, None)
    await message.reply_text("✅ Cancelled.")


@app.on_message(filters.command("diagnose") & filters.private)
async def diagnose_command(client, message):
    if not is_admin(message.from_user.id):
        return

    s = await get_settings()
    users = await users_col.count_documents({})
    files = await files_col.count_documents({})
    disabled = await files_col.count_documents({"disabled": True})

    await message.reply_text(
        "🩺 <b>FILE STORE DIAGNOSTICS</b>\n\n"
        f"Bot: <b>{'READY' if BOT_TOKEN else 'MISSING TOKEN'}</b>\n"
        f"Mongo: <b>{'CONFIGURED' if MONGO_URI else 'MISSING'}</b>\n"
        f"Storage Channel: <code>{LOG_CHANNEL}</code>\n"
        f"Max File: <b>{humanbytes(int(s.get('max_file_bytes', MAX_FILE_BYTES)))}</b>\n\n"
        f"Users: <b>{users}</b>\n"
        f"Files: <b>{files}</b>\n"
        f"Disabled Files: <b>{disabled}</b>\n\n"
        f"Upload: {'ON' if s.get('upload_enabled') else 'OFF'}\n"
        f"Link Generation: {'ON' if s.get('link_generation_enabled') else 'OFF'}\n"
        f"Download: {'ON' if s.get('download_enabled') else 'OFF'}\n"
        f"Maintenance: {'ON' if s.get('maintenance_mode') else 'OFF'}\n\n"
        "🎞 StreamHG: <b>OFF / NOT LOADED</b>\n"
        "🌐 Watch Online: <b>OFF / NOT LOADED</b>\n"
        "☁️ Oracle worker: <b>WAITING</b>"
    )


@app.on_message(filters.command("storage_test") & filters.private)
async def storage_test_command(client, message):
    if not is_admin(message.from_user.id):
        return
    try:
        chat = await ensure_storage_chat(client)
        await message.reply_text(
            "✅ <b>Storage Channel OK</b>\n\n"
            f"ID: <code>{chat.id}</code>\n"
            f"Title: <b>{html.escape(getattr(chat, 'title', '') or '')}</b>"
        )
    except Exception as exc:
        await message.reply_text(
            f"❌ <b>Storage Channel Failed</b>\n\n"
            f"<code>{html.escape(str(exc))[:1800]}</code>"
        )


# ============================================================
# 18) HEALTH SERVER FOR RENDER
# ============================================================
async def health(request: web.Request):
    try:
        s = await get_settings()
        return web.json_response(
            {
                "ok": True,
                "service": "telegram-file-store-bot",
                "time": now_ts(),
                "maintenance": bool(s.get("maintenance_mode", False)),
                "streamhg": False,
                "watch_online": False,
                "max_file_bytes": int(s.get("max_file_bytes", MAX_FILE_BYTES)),
            }
        )
    except Exception as exc:
        return web.json_response(
            {"ok": False, "error": str(exc)[:300]},
            status=503,
        )


async def robots(request: web.Request):
    return web.Response(
        text="User-agent: *\nDisallow: /\n",
        content_type="text/plain",
    )


# ============================================================
# 19) STARTUP / SHUTDOWN
# ============================================================
async def main():
    missing = []
    if not API_ID:
        missing.append("API_ID")
    if not API_HASH:
        missing.append("API_HASH")
    if not BOT_TOKEN:
        missing.append("BOT_TOKEN")
    if not MONGO_URI:
        missing.append("MONGO_URI")
    if not LOG_CHANNEL:
        missing.append("LOG_CHANNEL")
    if not ADMIN_ID:
        missing.append("ADMIN_ID")
    if missing:
        raise RuntimeError("Missing environment variables: " + ", ".join(missing))

    # Database indexes.
    await users_col.create_index([("banned", ASCENDING)])
    await users_col.create_index([("username", ASCENDING)])
    await files_col.create_index([("owner", ASCENDING), ("created_at", DESCENDING)])
    await files_col.create_index([("disabled", ASCENDING)])
    await files_col.create_index([("expires_at", ASCENDING)])
    await movie_col.create_index([("aliases", ASCENDING)])
    await movie_col.create_index([("normalized_title", ASCENDING)])
    await movie_col.create_index([("release_date", ASCENDING)])
    await movie_col.create_index([("updated_at", DESCENDING)])
    await settings_col.update_one(
        {"_id": "global"},
        {"$setOnInsert": DEFAULT_SETTINGS},
        upsert=True,
    )

    web_app = web.Application(client_max_size=1024 * 1024)
    web_app.router.add_get("/", health)
    web_app.router.add_get("/health", health)
    web_app.router.add_get("/robots.txt", robots)

    runner = web.AppRunner(web_app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()

    stop_event = asyncio.Event()

    def request_shutdown(*_):
        if not stop_event.is_set():
            log.warning("Shutdown signal received; stopping cleanly...")
            stop_event.set()

    with contextlib.suppress(Exception):
        signal.signal(signal.SIGTERM, request_shutdown)
        signal.signal(signal.SIGINT, request_shutdown)

    try:
        await app.start()
        me = await app.get_me()
        log.info("Bot started as @%s", me.username)
        log.info("Web server listening on %s", PORT)

        try:
            await ensure_storage_chat(app, required=False)
        except Exception:
            pass

        settings = await get_settings()
        log.info(
            "Service status: %s",
            "MAINTENANCE" if settings.get("maintenance_mode") else "ACTIVE",
        )

        await stop_event.wait()

    except FloodWait as exc:
        # Render restarts can occasionally hit Telegram auth/rate limits.
        log.error("Telegram FloodWait during startup: %s seconds", exc.value)
        await admin_log("Telegram FloodWait during bot startup", exc)
        await asyncio.sleep(exc.value)

    except asyncio.CancelledError:
        log.warning("Main task cancelled.")

    except Exception as exc:
        log.exception("Fatal main error")
        await admin_log("FATAL MAIN ERROR - bot stopped", exc)

    finally:
        with contextlib.suppress(Exception):
            await runner.cleanup()

        try:
            if app.is_connected:
                await app.stop()
        except Exception as exc:
            log.warning("Pyrogram shutdown warning: %s", exc)

        with contextlib.suppress(Exception):
            db_client.close()


# ============================================================
# 20) ENTRY POINT
# ============================================================
if __name__ == "__main__":
    try:
        app.run(main())
    except KeyboardInterrupt:
        pass
