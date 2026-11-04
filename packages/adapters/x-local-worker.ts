export const X_LOCAL_WORKER=String.raw`"""Fixed read-only Twifork bridge. No login automation, paid services or cookie extraction."""
import asyncio
import json
import os
import sys
from datetime import timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse


def read_checkpoint(value):
    if value is None:
        return None, []
    if not isinstance(value, str) or not value or len(value) > 4000 or any(ord(c) < 32 for c in value):
        raise ValueError("X_LOCAL_INPUT_LIMIT")
    if not value.startswith("ssx1:"):
        return value, []  # Existing raw X cursors remain resumable.
    try:
        state = json.loads(value[5:])
        if not isinstance(state, dict) or set(state) != {"c", "s"}:
            raise ValueError()
        cursor, seen = state["c"], state["s"]
        if not isinstance(cursor, str) or not cursor or len(cursor) > 4000 or any(ord(c) < 32 for c in cursor):
            raise ValueError()
        if not isinstance(seen, list) or len(seen) > 128 or any(
            not isinstance(item, str) or not item.isascii() or not item.isdecimal() or len(item) > 30 for item in seen
        ):
            raise ValueError()
        return cursor, list(dict.fromkeys(seen))
    except (ValueError, TypeError, KeyError):
        raise ValueError("X_LOCAL_INPUT_LIMIT") from None


def write_checkpoint(cursor, seen, observations):
    if not cursor:
        return None
    if not isinstance(cursor, str) or len(cursor) > 4000 or any(ord(c) < 32 for c in cursor):
        raise ValueError("X_LOCAL_INPUT_LIMIT")
    # A bounded recent window belongs to the checkpoint, not credentials or
    # process memory. X receives it even when each page uses a fresh worker.
    ids = list(reversed(list(dict.fromkeys(reversed(seen + [item["id"] for item in observations])))[:128]))
    while ids:
        value = "ssx1:" + json.dumps({"c": cursor, "s": ids}, separators=(",", ":"))
        if len(value) <= 4000:
            return value
        ids.pop(0)
    return cursor  # Never lose a valid long continuation to make room for IDs.


async def collect(arguments):
    token = os.environ.get("SOURCE_SCRAPER_X_ACCOUNT_SESSION", "")
    csrf = os.environ.get("SOURCE_SCRAPER_X_CSRF", "")
    if not token or not csrf:
        raise ValueError("X_LOCAL_SESSION_REQUIRED")
    cursor, seen = read_checkpoint(arguments.get("cursor"))
    import httpx
    from twikit import Client, __version__
    if __version__ != "2.4.0":
        raise ValueError("X_LOCAL_LIBRARY_VERSION")

    class ReadOnlyClient(Client):
        async def request(self, method, url, **kwargs):
            kwargs["auto_unlock"] = False
            return await super().request(method, url, **kwargs)

        async def _send(self, method, url, **kwargs):
            parsed = urlparse(str(url))
            if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
                raise ValueError("X_LOCAL_DESTINATION_DENIED")
            if parsed.hostname == "abs.twimg.com" and method.upper() == "GET" and parsed.path.endswith(".js"):
                # Bootstrap assets never receive account cookies or authorization headers.
                async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=12) as public:
                    return await public.get(str(url))
            allowed = (parsed.hostname == "api.x.com" and method.upper() == "GET" and parsed.path == "/1.1/account/settings.json") or (parsed.hostname == "x.com" and (
                (method.upper() == "GET" and (parsed.path or "/") in ("/", "/home", "/i/api/1.1/account/settings.json"))
                or (method.upper() in ("GET", "POST") and parsed.path.startswith("/i/api/graphql/")
                    and parsed.path.rsplit("/", 1)[-1] in ("HomeTimeline", "UserByScreenName"))))
            if not allowed:
                raise ValueError("X_LOCAL_OPERATION_DENIED")
            response = await super()._send(method, url, **kwargs)
            if response.status_code in (401, 403, 429) or response.status_code >= 300:
                raise ValueError("X_LOCAL_HTTP_" + str(response.status_code))
            return response

    client = ReadOnlyClient("en-US", trust_env=False, follow_redirects=False, timeout=12)
    client.http.cookies.set("auth_token", token, domain=".x.com", path="/")
    client.http.cookies.set("ct0", csrf, domain=".x.com", path="/")
    try:
        if await client.user_id() != arguments["accountId"]:
            raise ValueError("X_LOCAL_ACCOUNT_MISMATCH")
        page = await client.get_timeline(count=100, cursor=cursor, seen_tweet_ids=seen)
        if getattr(page, "_Result__overflow", None):
            raise ValueError("X_LOCAL_PAGE_OVERFLOW")
        observations = []
        for tweet in page:
            item = {"id": str(tweet.id), "type": "x-post",
                "title": (tweet.full_text or tweet.text or "X post")[:180],
                "text": tweet.full_text or tweet.text or "",
                "url": "https://x.com/" + tweet.user.screen_name + "/status/" + str(tweet.id),
                "urls": [item.get("expanded_url", "") for item in (tweet.urls or []) if item.get("expanded_url")],
                "media": [media.source_url for media in (tweet.media or []) if getattr(media, "source_url", None)],
                "attributes": {"author": tweet.user.screen_name, "collector": "twifork", "feed": "for-you"}}
            # Fixed public counters, without copying the library's raw object.
            metrics = {}
            for name, attribute in (("likes", "favorite_count"), ("reposts", "retweet_count"), ("replies", "reply_count"), ("quotes", "quote_count"), ("views", "view_count")):
                try:
                    value = getattr(tweet, attribute, None)
                except (KeyError, AttributeError, TypeError):
                    value = None
                if isinstance(value, str) and value.isascii() and value.isdecimal() and len(value) <= 16:
                    value = int(value)
                if type(value) is int and 0 <= value <= 9007199254740991:
                    metrics[name] = value
            item["attributes"]["metrics"] = metrics
            if tweet.created_at:
                item["occurredAt"] = parsedate_to_datetime(tweet.created_at).astimezone(timezone.utc).isoformat()
            observations.append(item)
        checkpoint = write_checkpoint(page.next_cursor, seen, observations)
        return {"observations": observations, "hasMore": bool(checkpoint), **({"nextCursor": checkpoint} if checkpoint else {})}
    finally:
        await client.http.aclose()


def serve():
    for line in sys.stdin:
        request = None
        try:
            if len(line) > 65536:
                raise ValueError("X_LOCAL_INPUT_LIMIT")
            request = json.loads(line)
            if "id" not in request:
                continue
            method = request.get("method")
            if method == "initialize":
                result = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}},
                    "serverInfo": {"name": "source-scraper-x-local", "version": "1"}}
            elif method == "tools/list":
                result = {"tools": [{"name": "read_x_for_you", "description": "Read local X For You",
                    "inputSchema": {"type": "object"}}]}
            elif method == "tools/call" and request.get("params", {}).get("name") == "read_x_for_you":
                result = {"structuredContent": asyncio.run(collect(request["params"]["arguments"]))}
            else:
                raise ValueError("X_LOCAL_METHOD_DENIED")
            reply = {"jsonrpc": "2.0", "id": request["id"], "result": result}
        except Exception as error:
            message = str(error)
            safe = message if message.startswith("X_LOCAL_") and all(c.isupper() or c.isdigit() or c == "_" for c in message) else "X_LOCAL_READ_FAILED"
            reply = {"jsonrpc": "2.0", "id": request.get("id") if isinstance(request, dict) else None,
                "error": {"code": -32000, "message": safe}}
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    serve()
`;
