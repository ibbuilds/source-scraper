export const X_LOCAL_WORKER=String.raw`"""Fixed read-only Twifork bridge. No login automation, paid services or cookie extraction."""
import asyncio
import hashlib
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
    if not isinstance(cursor, str) or len(cursor) > 2048 or any(ord(c) < 32 for c in cursor):
        raise ValueError("X_LOCAL_INPUT_LIMIT")
    # A bounded recent window belongs to the checkpoint, not credentials or
    # process memory. X receives it even when each page uses a fresh worker.
    ids = list(reversed(list(dict.fromkeys(reversed(seen + [item["id"] for item in observations])))[:128]))
    while ids:
        value = "ssx1:" + json.dumps({"c": cursor, "s": ids}, separators=(",", ":"))
        if len(value) <= 2048:  # The stdio transport is stricter than the X adapter.
            return value
        ids.pop(0)
    return cursor  # Never lose a valid long continuation to make room for IDs.


async def collect(arguments):
    token = os.environ.get("SOURCE_SCRAPER_X_ACCOUNT_SESSION", "")
    csrf = os.environ.get("SOURCE_SCRAPER_X_CSRF", "")
    if not token or not csrf:
        raise ValueError("X_LOCAL_SESSION_REQUIRED")
    operation = arguments.get("operation", "read_x_for_you")
    feedback = operation in ("inspect_x_like", "like_x_post")
    if feedback:
        if os.environ.get("SOURCE_SCRAPER_X_LIKES_APPROVED") != "local-likes-only":
            raise ValueError("X_LOCAL_LIKES_APPROVAL_REQUIRED")
        post_id = arguments.get("postId", "")
        if not isinstance(post_id, str) or not post_id.isascii() or not post_id.isdecimal() or len(post_id) > 30:
            raise ValueError("X_LOCAL_POST_INVALID")
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
            if feedback and parsed.hostname == "x.com" and parsed.path.startswith("/i/api/graphql/"):
                name = parsed.path.rsplit("/", 1)[-1]
                if name == "TweetDetail" and method.upper() == "GET":
                    variables = (kwargs.get("params") or {}).get("variables", "{}")
                    if isinstance(variables, str):
                        variables = json.loads(variables)
                    allowed = variables.get("focalTweetId") == post_id and "cursor" not in variables
                elif name == "FavoriteTweet" and method.upper() == "POST" and operation == "like_x_post":
                    allowed = (kwargs.get("json") or {}).get("variables", {}).get("tweet_id") == post_id
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
        if feedback:
            tweet = await client.get_tweet_by_id(post_id)
            if str(tweet.id) != post_id:
                raise ValueError("X_LOCAL_POST_INVALID")
            liked = tweet.favorited
            if type(liked) is not bool:
                raise ValueError("X_LOCAL_LIKE_UNCERTAIN")
            if operation == "like_x_post":
                text_hash = hashlib.sha256((tweet.full_text or tweet.text or "").encode("utf-8")).hexdigest()
                links = [item.get("expanded_url", "") for item in (tweet.urls or [])]
                if text_hash != arguments.get("postTextHash") or arguments.get("directUrl") not in links:
                    raise ValueError("X_LOCAL_POST_CHANGED")
            if operation == "like_x_post" and not liked:
                memory_path = arguments.get("resourceMemory", "")
                if not os.path.isabs(memory_path) or os.path.basename(memory_path) != "resources.json":
                    raise ValueError("X_LOCAL_REJECTION_STATE_REQUIRED")
                with open(memory_path, "r", encoding="utf-8") as memory_file:
                    raw = memory_file.read(32000001)
                if len(raw) > 32000000:
                    raise ValueError("X_LOCAL_REJECTION_STATE_REQUIRED")
                memory = json.loads(raw)
                if memory.get("version") != 1 or memory.get("feedbackEnabled") is not True:
                    raise ValueError("X_LOCAL_LIKE_DISABLED")
                aliases = memory.get("aliases", {})
                def identity(resource):
                    seen = set()
                    while "user|" + resource in aliases:
                        if resource in seen:
                            raise ValueError("X_LOCAL_REJECTION_STATE_REQUIRED")
                        seen.add(resource)
                        resource = aliases["user|" + resource]
                    return resource
                resource = identity(arguments.get("resourceUrl", ""))
                if not resource or any(r.get("scope") == "user" and r.get("active") is True and identity(r.get("resource", "")) == resource for r in memory.get("rejections", [])):
                    raise ValueError("X_LOCAL_RESOURCE_REJECTED")
                response = await client.favorite_tweet(post_id)
                if response.json().get("errors"):
                    raise ValueError("X_LOCAL_LIKE_UNCERTAIN")
                # A successful mutation response is not proof of final state.
                return {"accountId": arguments["accountId"], "postId": post_id, "requested": True}
            return {"accountId": arguments["accountId"], "postId": post_id, "favorited": liked, "requested": False,
                    "postUrl": "https://x.com/" + tweet.user.screen_name + "/status/" + post_id,
                    "postTextHash": hashlib.sha256((tweet.full_text or tweet.text or "").encode("utf-8")).hexdigest(),
                    "urls": [item.get("expanded_url", "") for item in (tweet.urls or [])
                             if item.get("expanded_url") and token not in item["expanded_url"] and csrf not in item["expanded_url"]]}
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
                    metrics[name] = max(0, value - (1 if name == "likes" and getattr(tweet, "favorited", False) is True else 0))
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
            elif method == "tools/call" and request.get("params", {}).get("name") in ("read_x_for_you", "inspect_x_like", "like_x_post"):
                args = dict(request["params"]["arguments"])
                args["operation"] = request["params"]["name"]
                result = {"structuredContent": asyncio.run(collect(args))}
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
