"""No network: exercise the actual embedded Python bridge against fake X responses."""
import asyncio
import json
import os
import subprocess
import sys
import types
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
            urls=[{"expanded_url": "https://example.org/tool"}], media=[], created_at="Sun Nov 01 12:00:00 +0000 2026")])
        self.next_cursor = None
        self._Result__overflow = []


class Client:
    operation = "HomeTimeline"
    status = 200
    account = "1234567890"
    overflow = False
    def __init__(self, *args, **kwargs): self.http = HTTP()
    async def request(self, method, url, **kwargs): return await self._send(method, url, **kwargs)
    async def _send(self, method, url, **kwargs):
        EVENTS.append((method, url, None))
        return types.SimpleNamespace(status_code=self.status)
    async def user_id(self):
        await self._send("GET", "https://abs.twimg.com/bootstrap.js")
        await self._send("GET", "https://api.x.com/1.1/account/settings.json")
        return self.account
    async def get_timeline(self, **kwargs):
        await self._send("POST", "https://x.com/i/api/graphql/fixed/" + self.operation)
        result = Result()
        if self.overflow: result._Result__overflow = ["extra"]
        return result


class BridgeTests(unittest.TestCase):
    def setUp(self):
        EVENTS.clear();Client.operation="HomeTimeline";Client.status=200;Client.account="1234567890";Client.overflow=False
        self.environment=patch.dict(os.environ, {"SOURCE_SCRAPER_X_ACCOUNT_SESSION":"fixture-session", "SOURCE_SCRAPER_X_CSRF":"fixture-csrf"})
        self.modules=patch.dict(sys.modules, {"httpx":types.SimpleNamespace(AsyncClient=HTTP),"twikit":types.SimpleNamespace(Client=Client,__version__="2.4.0")})
        self.environment.start();self.modules.start()
    def tearDown(self): self.modules.stop();self.environment.stop()
    def collect(self): return asyncio.run(SPACE["collect"]({"accountId":"1234567890"}))
    def test_for_you_read_and_allowlisted_output(self):
        result=self.collect();self.assertEqual(result["observations"][0]["id"],"101")
        self.assertEqual(result["observations"][0]["occurredAt"],"2026-11-01T12:00:00+00:00")
        self.assertFalse(result["hasMore"]);self.assertNotIn("nextCursor",result)
        self.assertTrue(any(url.endswith("/HomeTimeline") for _,url,_ in EVENTS))
    def test_bootstrap_gets_no_account_cookies(self):
        self.collect();self.assertEqual(EVENTS[0],("public","https://abs.twimg.com/bootstrap.js",[]))
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
