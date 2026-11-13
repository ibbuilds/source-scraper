"""No network: exercise the actual embedded Python bridge against fake X responses."""
import asyncio
import hashlib
import json
import os
import subprocess
import sys
import types
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
WORKER = json.loads(subprocess.check_output(["node", "--experimental-strip-types", "--input-type=module", "-e",
    "import {X_LOCAL_WORKER} from './packages/adapters/x-local-worker.ts';console.log(JSON.stringify(X_LOCAL_WORKER));"], cwd=ROOT, text=True, timeout=15))
SPACE = {"__name__": "bridge_test"}
exec(compile(WORKER, "x-local-worker", "exec"), SPACE)
EVENTS = []


class Cookies:
    def __init__(self): self.values = []
    def set(self, *args, **kwargs): self.values.append((args, kwargs))


class HTTP:
    def __init__(self, **kwargs): self.cookies = Cookies()
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def aclose(self): pass
    async def get(self, url):
        EVENTS.append(("public", url, self.cookies.values))
        return types.SimpleNamespace(status_code=200)


class Result(list):
    def __init__(self):
        super().__init__([types.SimpleNamespace(id="101", full_text="React motion", text="React", user=types.SimpleNamespace(screen_name="example"),
            favorite_count=120, retweet_count=20, reply_count=5, quote_count=2, view_count="9000", urls=[{"expanded_url": "https://example.org/tool"}], media=[], created_at="Sun Nov 01 12:00:00 +0000 2026")])
        self.next_cursor = None
        self._Result__overflow = []


class Client:
    operation = "HomeTimeline"
    status = 200
    account = "1234567890"
    overflow = False
    next_cursor = None
    timeline_calls = []
    favorited = False
    send_id = None
    def __init__(self, *args, **kwargs): self.http = HTTP()
    async def request(self, method, url, **kwargs): return await self._send(method, url, **kwargs)
    async def _send(self, method, url, **kwargs):
        EVENTS.append((method, url, None))
        return types.SimpleNamespace(status_code=self.status)
    async def user_id(self):
        # Twifork starts its real transaction handshake with the bare origin.
        await self._send("GET", "https://x.com")
        await self._send("GET", "https://abs.twimg.com/bootstrap.js")
        await self._send("GET", "https://api.x.com/1.1/account/settings.json")
        return self.account
    async def get_tweet_by_id(self, post_id):
        await self._send("GET", "https://x.com/i/api/graphql/fixed/TweetDetail", params={"variables":json.dumps({"focalTweetId":post_id})})
        callback=getattr(type(self),"on_inspect",None)
        if callback: callback()
        tweet=Result()[0];tweet.favorited=self.favorited
        return tweet
    async def favorite_tweet(self, post_id):
        await self._send("POST", "https://x.com/i/api/graphql/fixed/FavoriteTweet", json={"variables":{"tweet_id":self.send_id or post_id}})
        return types.SimpleNamespace(json=lambda:{"data":{"favorite_tweet":"Done"}})
    async def get_timeline(self, **kwargs):
        self.timeline_calls.append(kwargs)
        await self._send("POST", "https://x.com/i/api/graphql/fixed/" + self.operation)
        result = Result()
        result.next_cursor = self.next_cursor
        if self.overflow: result._Result__overflow = ["extra"]
        return result


class BridgeTests(unittest.TestCase):
    def setUp(self):
        EVENTS.clear();Client.operation="HomeTimeline";Client.status=200;Client.account="1234567890";Client.overflow=False
        Client.next_cursor=None;Client.timeline_calls=[];Client.favorited=False;Client.send_id=None;Client.on_inspect=None
        self.memory_temp=tempfile.TemporaryDirectory();self.memory_path=Path(self.memory_temp.name)/"resources.json"
        self.memory_path.write_text(json.dumps({"version":1,"feedbackEnabled":True,"aliases":{},"rejections":[]}),encoding="utf-8")
        os.environ.pop("SOURCE_SCRAPER_X_LIKES_APPROVED",None)
        self.environment=patch.dict(os.environ, {"SOURCE_SCRAPER_X_ACCOUNT_SESSION":"fixture-session", "SOURCE_SCRAPER_X_CSRF":"fixture-csrf"})
        self.modules=patch.dict(sys.modules, {"httpx":types.SimpleNamespace(AsyncClient=HTTP),"twikit":types.SimpleNamespace(Client=Client,__version__="2.4.0")})
        self.environment.start();self.modules.start()
    def tearDown(self): self.modules.stop();self.environment.stop();self.memory_temp.cleanup()
    def collect(self, **kwargs): return asyncio.run(SPACE["collect"]({"accountId":"1234567890", "resourceMemory":str(self.memory_path),"resourceUrl":"https://example.org/tool", **kwargs}))
    def test_feedback_needs_separate_grant_before_network(self):
        with self.assertRaisesRegex(ValueError,"LIKES_APPROVAL_REQUIRED"):
            self.collect(operation="like_x_post",postId="101")
        self.assertEqual(EVENTS,[])
    def test_feedback_inspection_verifies_account_and_exact_post(self):
        os.environ["SOURCE_SCRAPER_X_LIKES_APPROVED"]="local-likes-only"
        result=self.collect(operation="inspect_x_like",postId="101")
        self.assertEqual(result["postId"],"101");self.assertFalse(result["favorited"])
        self.assertEqual(result["postTextHash"],hashlib.sha256(b"React motion").hexdigest())
        self.assertFalse(any("FavoriteTweet" in e[1] for e in EVENTS))
    def test_like_requires_unchanged_text_and_exposed_link(self):
        os.environ["SOURCE_SCRAPER_X_LIKES_APPROVED"]="local-likes-only"
        args={"operation":"like_x_post","postId":"101","postTextHash":hashlib.sha256(b"React motion").hexdigest(),"directUrl":"https://example.org/tool"}
        result=self.collect(**args);self.assertTrue(result["requested"])
        self.assertEqual(sum("FavoriteTweet" in e[1] for e in EVENTS),1)
        EVENTS.clear()
        for patching in [{"postTextHash":"0"*64},{"directUrl":"https://other.example/tool"}]:
            with self.assertRaisesRegex(ValueError,"POST_CHANGED"):
                self.collect(**{**args,**patching})
        self.assertFalse(any("FavoriteTweet" in e[1] for e in EVENTS))
    def test_like_allowlist_refuses_a_different_target_post(self):
        os.environ["SOURCE_SCRAPER_X_LIKES_APPROVED"]="local-likes-only";Client.send_id="999"
        with self.assertRaisesRegex(ValueError,"OPERATION_DENIED"):
            self.collect(operation="like_x_post",postId="101",postTextHash=hashlib.sha256(b"React motion").hexdigest(),directUrl="https://example.org/tool")
    def test_rejection_arriving_during_post_inspection_prevents_send(self):
        os.environ["SOURCE_SCRAPER_X_LIKES_APPROVED"]="local-likes-only"
        Client.on_inspect=lambda:self.memory_path.write_text(json.dumps({"version":1,"feedbackEnabled":True,"aliases":{},"rejections":[{"scope":"user","active":True,"resource":"https://example.org/tool"}]}),encoding="utf-8")
        with self.assertRaisesRegex(ValueError,"RESOURCE_REJECTED"):
            self.collect(operation="like_x_post",postId="101",postTextHash=hashlib.sha256(b"React motion").hexdigest(),directUrl="https://example.org/tool")
        self.assertFalse(any("FavoriteTweet" in e[1] for e in EVENTS))
    def test_feedback_stopped_during_post_inspection_prevents_send(self):
        os.environ["SOURCE_SCRAPER_X_LIKES_APPROVED"]="local-likes-only"
        Client.on_inspect=lambda:self.memory_path.write_text(json.dumps({"version":1,"feedbackEnabled":False,"aliases":{},"rejections":[]}),encoding="utf-8")
        with self.assertRaisesRegex(ValueError,"LIKE_DISABLED"):
            self.collect(operation="like_x_post",postId="101",postTextHash=hashlib.sha256(b"React motion").hexdigest(),directUrl="https://example.org/tool")
        self.assertFalse(any("FavoriteTweet" in e[1] for e in EVENTS))
    def post_review_memory(self, **changes):
        from datetime import datetime, timezone, timedelta
        review={"id":"topic-decision", "profileHash":"a"*64,"state":"pertinent","wholePostReviewed":True,"uncertainties":[],
                "postTextHash":hashlib.sha256(b"React motion").hexdigest(),"postUrl":"https://x.com/example/status/101",
                "urls":[],"media":["https://pbs.twimg.com/media/ui.jpg"],"minimumLikes":10,
                "expiresAt":(datetime.now(timezone.utc)+timedelta(hours=1)).isoformat(),**changes}
        return {"version":1,"feedbackEnabled":True,"aliases":{},"rejections":[],"postReviews":{"1234567890|101":review},
                "actions":[{"target":"post","decisionId":"topic-decision","accountId":"1234567890","postId":"101","state":"in-progress"}]}
    def test_unlinked_visual_post_like_requires_current_complete_decision_and_journal(self):
        os.environ["SOURCE_SCRAPER_X_LIKES_APPROVED"]="local-likes-only"
        original=Result.__init__
        def unlinked(result):
            original(result);result[0].urls=[];result[0].media=[types.SimpleNamespace(type="photo",source_url="https://pbs.twimg.com/media/ui.jpg")]
        args={"operation":"like_x_post","postId":"101","target":"post","decisionId":"topic-decision","profileHash":"a"*64,"postTextHash":hashlib.sha256(b"React motion").hexdigest()}
        with patch.object(Result,"__init__",unlinked):
            self.memory_path.write_text(json.dumps(self.post_review_memory()),encoding="utf-8")
            self.assertTrue(self.collect(**args)["requested"])
            self.assertEqual(sum("FavoriteTweet" in e[1] for e in EVENTS),1)
            for changes in [{"state":"uncertain"},{"wholePostReviewed":False},{"uncertainties":["video not reviewed"]},
                            {"media":[]},{"urls":["https://different.example"]},{"profileHash":"b"*64},
                            {"expiresAt":"2020-01-01T00:00:00Z"},{"minimumLikes":121}]:
                EVENTS.clear();self.memory_path.write_text(json.dumps(self.post_review_memory(**changes)),encoding="utf-8")
                with self.subTest(changes=changes):
                    with self.assertRaisesRegex(ValueError,"POST_REVIEW_REQUIRED"):self.collect(**args)
                    self.assertFalse(any("FavoriteTweet" in e[1] for e in EVENTS))
            for field,value in [("actions",[]),("feedbackEnabled",False),("rejections",[{"scope":"user","active":True,"resource":"https://x.com/example/status/101"}])]:
                EVENTS.clear();memory=self.post_review_memory();memory[field]=value
                Client.on_inspect=lambda:self.memory_path.write_text(json.dumps(memory),encoding="utf-8")
                with self.subTest(field=field):
                    with self.assertRaises(ValueError):self.collect(**args)
                    self.assertFalse(any("FavoriteTweet" in e[1] for e in EVENTS))
    def test_confirmed_remote_like_does_not_send_again(self):
        os.environ["SOURCE_SCRAPER_X_LIKES_APPROVED"]="local-likes-only";Client.favorited=True
        result=self.collect(operation="like_x_post",postId="101",postTextHash=hashlib.sha256(b"React motion").hexdigest(),directUrl="https://example.org/tool")
        self.assertTrue(result["favorited"]);self.assertFalse(result["requested"])
        self.assertFalse(any("FavoriteTweet" in e[1] for e in EVENTS))
    def test_continuation_remembers_seen_posts_across_worker_processes(self):
        Client.next_cursor="after-page"
        first=self.collect(cursor="legacy-page")
        self.collect(cursor=first["nextCursor"])
        self.assertEqual(Client.timeline_calls[0]["cursor"],"legacy-page")
        self.assertEqual(Client.timeline_calls[1]["cursor"],"after-page")
        self.assertEqual(Client.timeline_calls[1].get("seen_tweet_ids"),["101"])
    def test_video_requires_a_playable_stream_and_never_certifies_its_poster(self):
        media=types.SimpleNamespace(type="video",source_url="https://pbs.twimg.com/media/poster.jpg",video_info={"variants":[
            {"content_type":"application/x-mpegURL","url":"https://video.twimg.com/clip.m3u8"},
            {"content_type":"video/mp4","bitrate":100,"url":"https://video.twimg.com/low.mp4"},
            {"content_type":"video/mp4","bitrate":500,"url":"https://video.twimg.com/high.mp4"}]})
        tweet=types.SimpleNamespace(media=[media]);self.assertEqual(SPACE["media_evidence"](tweet),(["https://video.twimg.com/high.mp4"],True))
        media.video_info={"variants":[]};self.assertEqual(SPACE["media_evidence"](tweet),([],False))
    def test_incomplete_quote_retweet_or_article_never_certifies_whole_post(self):
        for patching in [{"is_quote_status":True},{"retweeted_tweet":object()},{"article":object()}]:
            self.assertFalse(SPACE["media_evidence"](types.SimpleNamespace(media=[],**patching))[1])
    def test_checkpoint_deduplicates_and_bounds_recent_ids(self):
        old=[str(i) for i in range(200)]
        saved=SPACE["write_checkpoint"]("after-page",old,[{"id":"101"},{"id":"999"}])
        cursor,seen=SPACE["read_checkpoint"](saved)
        self.assertEqual(cursor,"after-page")
        self.assertEqual(len(seen),128)
        self.assertEqual(len(set(seen)),128)
        self.assertEqual(seen[-2:],["101","999"])
    def test_long_checkpoint_preserves_cursor_within_adapter_limit(self):
        raw="c"*2000
        saved=SPACE["write_checkpoint"](raw,[str(i) for i in range(128)],[{"id":"101"}])
        self.assertLessEqual(len(saved),2048)
        self.assertEqual(SPACE["read_checkpoint"](saved)[0],raw)
        raw="c"*2048
        self.assertEqual(SPACE["write_checkpoint"](raw,[],[{"id":"101"}]),raw)
        with self.assertRaisesRegex(ValueError,"INPUT_LIMIT"):
            SPACE["write_checkpoint"]("c"*2049,[],[{"id":"101"}])
    def test_repeated_real_sized_pages_fit_stdio_cursor_limit(self):
        cursor=None
        for page in range(20):
            raw,seen=SPACE["read_checkpoint"](cursor)
            observations=[{"id":str(2117950000000000000+page*28+i)} for i in range(28)]
            cursor=SPACE["write_checkpoint"]("x"*46,seen,observations)
            self.assertLessEqual(len(cursor),2048)
            self.assertEqual(SPACE["read_checkpoint"](cursor)[0],"x"*46)
    def test_bad_checkpoint_stops_before_any_network(self):
        for value in ["ssx1:broken", 'ssx1:{"c":"after","s":["not-an-id"]}',
            'ssx1:{"c":"after","s":[true]}', "ssx1:"+json.dumps({"c":"after","s":["1"]*129}),
            "ssx1:"+json.dumps({"c":"after","s":[],"unexpected":True}),"x"*4001]:
            with self.subTest(value=value[:45]):
                with self.assertRaisesRegex(ValueError,"INPUT_LIMIT"): self.collect(cursor=value)
                self.assertEqual(EVENTS,[])
    def test_for_you_read_and_allowlisted_output(self):
        result=self.collect();self.assertEqual(result["observations"][0]["id"],"101")
        self.assertEqual(result["observations"][0]["occurredAt"],"2026-11-01T12:00:00+00:00")
        self.assertFalse(result["hasMore"]);self.assertNotIn("nextCursor",result)
        self.assertEqual(result["observations"][0]["attributes"]["metrics"], {"likes":120,"reposts":20,"replies":5,"quotes":2,"views":9000})
        self.assertTrue(any(url.endswith("/HomeTimeline") for _,url,_ in EVENTS))
    def test_missing_and_invalid_counters_stay_missing(self):
        original = Result.__init__
        def invalid(result):
            original(result)
            result[0].favorite_count = None
            result[0].retweet_count = True
            result[0].reply_count = -1
            result[0].quote_count = "bad"
            result[0].view_count = "9007199254740992"
        with patch.object(Result, "__init__", invalid):
            self.assertEqual(self.collect()["observations"][0]["attributes"]["metrics"], {})
    def test_bootstrap_gets_no_account_cookies(self):
        self.collect();self.assertIn(("public","https://abs.twimg.com/bootstrap.js",[]),EVENTS)
    def test_account_mismatch_stops_before_timeline(self):
        Client.account="999"
        with self.assertRaisesRegex(ValueError,"ACCOUNT_MISMATCH"): self.collect()
        self.assertFalse(any(url.endswith("/HomeTimeline") for _,url,_ in EVENTS))
    def test_write_operation_is_denied(self):
        Client.operation="FavoriteTweet"
        with self.assertRaisesRegex(ValueError,"OPERATION_DENIED"): self.collect()
        self.assertFalse(any(url.endswith("/FavoriteTweet") for _,url,_ in EVENTS))
    def test_rate_limit_stops_without_retry(self):
        Client.status=429
        with self.assertRaisesRegex(ValueError,"HTTP_429"): self.collect()
        self.assertEqual(sum(kind=="GET" for kind,_,_ in EVENTS),1)
    def test_missing_session_does_not_call_network(self):
        os.environ.pop("SOURCE_SCRAPER_X_CSRF")
        with self.assertRaisesRegex(ValueError,"SESSION_REQUIRED"): self.collect()
        self.assertEqual(EVENTS,[])
    def test_overflow_is_not_silently_dropped(self):
        Client.overflow=True
        with self.assertRaisesRegex(ValueError,"PAGE_OVERFLOW"): self.collect()
    def test_actual_stdio_protocol_without_credentials(self):
        env={k:v for k,v in os.environ.items() if k not in ("SOURCE_SCRAPER_X_ACCOUNT_SESSION","SOURCE_SCRAPER_X_CSRF")}
        requests=[{"jsonrpc":"2.0","id":1,"method":"initialize"},{"jsonrpc":"2.0","id":2,"method":"tools/list"},
            {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_x_for_you","arguments":{}}}]
        result=subprocess.run([sys.executable,"-I","-c",WORKER],input="\n".join(json.dumps(r) for r in requests)+"\n",text=True,capture_output=True,env=env,timeout=10)
        self.assertEqual(result.returncode,0);responses=[json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(responses[1]["result"]["tools"][0]["name"],"read_x_for_you")
        self.assertEqual(responses[2]["error"]["message"],"X_LOCAL_SESSION_REQUIRED")


if __name__ == "__main__": unittest.main()
