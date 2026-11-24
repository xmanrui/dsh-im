#!/usr/bin/env python3
"""DSH XiaoAI transport. stdout is versioned JSONL; no model or shell execution."""
import argparse
import asyncio
from contextlib import asynccontextmanager, suppress
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
from urllib.parse import urlsplit, parse_qs, urljoin
import uuid

from speaker_adapter import SpeakerAdapter, SpeakerCloudError, capabilities_for

VERSION = 1
BUILD = '0.3.0'
MAX_LINE = 256 * 1024
MAX_RECORD_AGE_MS = 5 * 60_000
PASS_TOKEN_REFRESH_MS = 12 * 60 * 60_000


def phone_confirmation_target(page):
    """Follow Xiaomi's extra confirmUrl regardless of the interstitial pathname."""
    source = urlsplit(str(page))
    if (source.scheme, source.hostname, source.port or 443) != ('https', 'account.xiaomi.com', 443):
        return None
    target = parse_qs(source.query).get('confirmUrl', [None])[0]
    if not target:
        return None
    target = urljoin(str(page), target)
    parsed = urlsplit(target)
    if parsed.username or parsed.password or (parsed.scheme, parsed.hostname, parsed.port or 443) != ('https', 'account.xiaomi.com', 443):
        raise ValueError('Unexpected Xiaomi phone confirmation origin')
    return target


def now():
    return int(time.time() * 1000)


def fresh_records(records, at=None):
    """Drop utterances spoken before the Host could plausibly have been up."""
    cutoff = (at if at is not None else now()) - MAX_RECORD_AGE_MS
    return [record for record in records if int(record.get('timestamp') or 0) >= cutoff]


def event_id(account_id, device_id, record):
    identity = record.get('requestId') or f"{record['timestamp']}:{record['text'].strip()}"
    return hashlib.sha256(f'{account_id}\0{device_id}\0{identity}'.encode()).hexdigest()


class Store:
    def __init__(self, root):
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(root / 'transport.sqlite3')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS cursor(device TEXT PRIMARY KEY, timestamp INTEGER);
          CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, payload TEXT, acked INTEGER DEFAULT 0);
          CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, status TEXT, result TEXT);
          CREATE TABLE IF NOT EXISTS cancelled_turns(device TEXT, turn TEXT, at INTEGER, PRIMARY KEY(device,turn));
        ''')
        self.db.execute("UPDATE commands SET status='unknown',result=? WHERE status='inflight'",
                        (json.dumps({'status': 'unknown', 'code': 'process-interrupted'}),))
        self.db.commit()

    def ingest(self, account_id, device_id, records):
        row = self.db.execute('SELECT timestamp FROM cursor WHERE device=?', (device_id,)).fetchone()
        floor = row[0] if row else now()
        # The first connection starts at the present instead of answering old voice history.
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO cursor VALUES (?,?)', (device_id, floor))
            for record in sorted(records, key=lambda r: r['timestamp']):
                if record['timestamp'] < floor or not record.get('text', '').strip():
                    continue
                eid = event_id(account_id, device_id, record)
                payload = {'v': VERSION, 'type': 'utterance', 'eventId': eid, 'deviceId': device_id,
                           'timestamp': record['timestamp'], 'providerRequestId': record.get('requestId'),
                           'text': record['text']}
                self.db.execute('INSERT OR IGNORE INTO events(id,payload) VALUES (?,?)',
                                (eid, json.dumps(payload, ensure_ascii=False)))
                self.db.execute('UPDATE cursor SET timestamp=MAX(timestamp,?) WHERE device=?',
                                (record['timestamp'], device_id))

    def pending(self):
        return [json.loads(r[0]) for r in self.db.execute('SELECT payload FROM events WHERE acked=0 ORDER BY rowid')]

    def ack(self, eid):
        with self.db:
            self.db.execute('UPDATE events SET acked=1 WHERE id=?', (eid,))

    def begin_command(self, rid):
        row = self.db.execute('SELECT result,status FROM commands WHERE id=?', (rid,)).fetchone()
        if row:
            return json.loads(row[0]) if row[0] else {'status': row[1]}
        with self.db:
            self.db.execute("INSERT INTO commands VALUES (?,'inflight',NULL)", (rid,))
        return None

    def finish_command(self, rid, result):
        with self.db:
            self.db.execute('UPDATE commands SET status=?,result=? WHERE id=?',
                            (result['status'], json.dumps(result), rid))

    def cancel_turns(self, device, turns):
        with self.db:
            self.db.executemany('INSERT OR IGNORE INTO cancelled_turns VALUES (?,?,?)',
                                [(device, turn, now()) for turn in turns])
            self.db.execute('DELETE FROM cancelled_turns WHERE at < ?', (now() - 7 * 24 * 60 * 60_000,))

    def turn_cancelled(self, device, turn):
        return bool(turn and self.db.execute('SELECT 1 FROM cancelled_turns WHERE device=? AND turn=?', (device, turn)).fetchone())

    def close(self):
        self.db.close()


class AtomicTokenStore:
    """Credentials remain in a private, atomic file, never in protocol diagnostics."""
    def __init__(self, path):
        self.path = path

    async def load_token(self):
        try:
            return json.loads(self.path.read_text())
        except FileNotFoundError:
            return None

    async def save_token(self, token=None):
        if not token:
            # Preserve passToken for a service-token renewal (XiaoGPT's recovery approach).
            return
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.path.with_name(self.path.name + '.' + uuid.uuid4().hex + '.tmp')
        with temporary.open('x', encoding='utf-8') as stream:
            os.chmod(temporary, 0o600)
            json.dump(token, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.path)
        try:
            directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(directory)
            finally: os.close(directory)
        except (OSError, AttributeError):
            pass


class XiaomiProvider:
    def __init__(self, credential, state_dir, emit, otp, interactive=False):
        self.credential, self.state_dir, self.emit, self.otp = credential, state_dir, emit, otp
        self.session = self.account = self.mina = self.miot = self.adapter = None
        self.device = None
        self.interactive = interactive
        self.auth_trace = []
        self.otp_submitted = False
        self.confirmed_urls = set()
        self.api_lock = asyncio.Lock()
        self.api_owner = None
        self.login_lock = asyncio.Lock()

    def trace_auth(self, event, **fields):
        if not self.interactive:
            return
        self.auth_trace.append({'at': now(), 'event': event, **fields})
        self.auth_trace = self.auth_trace[-80:]
        path = self.state_dir / 'auth-diagnostics.json'
        temporary = path.with_suffix('.tmp')
        try:
            temporary.write_text(json.dumps({'build': BUILD, 'entries': self.auth_trace}, ensure_ascii=False), encoding='utf-8')
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        except Exception:
            # Diagnostics must never turn a valid login into a failure.
            pass

    def request_step(self, url, method):
        path = urlsplit(str(url)).path
        if path == '/pass/serviceLogin':
            return 'resume_login' if self.otp_submitted else 'login_challenge'
        if path == '/pass/serviceLoginAuth2':
            return 'password_login'
        if path == '/identity/list':
            return 'verification_methods'
        if path.endswith('/sendPhoneTicket') or path.endswith('/sendEmailTicket'):
            return 'send_code'
        if path in ('/identity/auth/verifyPhone', '/identity/auth/verifyEmail'):
            if method == 'POST':
                self.otp_submitted = True
                return 'verify_code'
            return 'prepare_code'
        if path == '/pass/serviceLoginAuth2/end':
            return 'complete_confirmation'
        if path == '/admin/v2/device_list':
            return 'device_discovery'
        return 'follow_auth_redirect' if self.otp_submitted else 'authentication_request'

    async def open(self):
        from aiohttp import ClientSession, ClientTimeout
        from miservice import MiAccount, MiNAService, MiIOService
        from miservice.miaccount import ACCOUNT_BASE, UA_LOGIN
        from yarl import URL

        # Keep MiService's current auth implementation, including the documented
        # Xiaomi phone-confirmation redirect handled by XiaoGPT pending upstream.
        interactive = self.interactive
        provider = self
        class Account(MiAccount):
            async def _verify_otp(self, sid, ntf):
                if not interactive:
                    raise PermissionError('Interactive Xiaomi authorization required')
                return await super()._verify_otp(sid, ntf)
            @asynccontextmanager
            async def request_override(self, url, method, kwargs):
                step = provider.request_step(url, method)
                provider.trace_auth('request', step=step, method=method)
                parsed = urlsplit(str(url))
                miot_request = parsed.hostname == 'api.io.mi.com' and parsed.path.startswith('/app/')
                if miot_request:
                    # MiService's legacy MiHome 6.0.103 UA is rejected with 429/-127.
                    # Keep the current library login UA scoped to MIoT requests.
                    kwargs = {**kwargs, 'headers': {**(kwargs.get('headers') or {}), 'User-Agent': UA_LOGIN}}
                try:
                    async with super().request(url, method, **kwargs) as response:
                        raw = await response.read()
                        try:
                            payload = json.loads(raw.removeprefix(b'&&&START&&&'))
                        except (ValueError, UnicodeError):
                            payload = {}
                        code = payload.get('code') if isinstance(payload, dict) else None
                        if miot_request and response.status not in (200, 401):
                            raise SpeakerCloudError(response.status, code, response.headers.get('Retry-After'))
                        fields = {key: key in payload for key in ('passToken', 'userId', 'location', 'nonce', 'ssecurity')} if isinstance(payload, dict) else {}
                        page = response.url
                        target = phone_confirmation_target(page) if method == 'GET' else None
                        cookies = provider.session.cookie_jar.filter_cookies(URL(ACCOUNT_BASE))
                        provider.trace_auth('response', step=step, httpStatus=response.status,
                            providerCode=code if isinstance(code, int) else None,
                            fieldsPresent=fields, passTokenCookie=bool(cookies.get('passToken')),
                            phoneConfirmationPending=bool(target))
                        yield response
                except Exception as error:
                    provider.trace_auth('exception', step=step, errorType=type(error).__name__)
                    raise
                if target:
                    fingerprint = hashlib.sha256(target.encode()).hexdigest()
                    if fingerprint in provider.confirmed_urls:
                        provider.trace_auth('exception', step='confirm_phone', errorType='ConfirmationCycle')
                        raise ValueError('Repeated Xiaomi phone confirmation')
                    provider.confirmed_urls.add(fingerprint)
                    provider.trace_auth('follow_confirmation', step='confirm_phone')
                    async with self.request(target, 'GET', **kwargs) as response:
                        response.raise_for_status()
                        await response.read()

            def request(self, url, method='GET', **kwargs):
                if not interactive and method == 'POST' and urlsplit(str(url)).path == '/pass/serviceLoginAuth2':
                    raise PermissionError('Interactive Xiaomi authorization required')
                return self.request_override(url, method, kwargs)

            async def login(self, sid):
                async with provider.login_lock:
                    if not self.token:
                        previous = await self.token_store.load_token()
                        if previous and all(k in previous for k in ('deviceId', 'userId', 'passToken')):
                            self.token = {k: previous[k] for k in ('deviceId', 'userId', 'passToken')}
                    result = await super().login(sid)
                    if not result and not interactive:
                        raise PermissionError('Xiaomi authorization rejected')
                    return result

            async def mi_request(self, *args, **kwargs):
                # Only serialize individual HTTP requests, never an entire spoken answer.
                # MiAccount's 401 renewal recursively invokes self.mi_request.
                task = asyncio.current_task()
                if provider.api_owner is task:
                    return await super().mi_request(*args, **kwargs)
                async with provider.api_lock:
                    provider.api_owner = task
                    try:
                        return await super().mi_request(*args, **kwargs)
                    finally:
                        provider.api_owner = None

        self.session = ClientSession(timeout=ClientTimeout(total=25), trust_env=False)
        # The per-device credential intentionally contains no password. MiAccount
        # resumes from the passToken in mi-token.json; if it has expired, login
        # fails and Node asks for an interactive re-login instead of replaying a
        # stored account password.
        self.account = Account(self.session, self.credential['account'], self.credential.get('password') or '',
                               token_store=AtomicTokenStore(self.state_dir / 'mi-token.json'),
                               otp_callback=self.otp)
        self.mina = MiNAService(self.account)
        self.miot = MiIOService(self.account)
        self.adapter = SpeakerAdapter(self.mina, self.miot)
        devices = await self.mina.device_list()
        if devices is None:
            raise ConnectionError('Xiaomi device discovery unavailable')
        self.devices = [{'deviceId': str(d['deviceID']), 'name': d.get('name') or d.get('alias') or 'XiaoAI',
                         'hardware': str(d.get('hardware') or 'UNKNOWN').strip().upper(), 'miotDID': d.get('miotDID')}
                        for d in devices or [] if d.get('deviceID')]
        self.account_id = hashlib.sha256(str(self.account.token['userId']).encode()).hexdigest()[:24]
        if self.credential.get('accountId') and self.credential['accountId'] != self.account_id:
            raise PermissionError('Xiaomi account identity changed')
        if self.credential.get('deviceId'):
            self.device = next((d for d in self.devices if d['deviceId'] == self.credential['deviceId']), None)
            if not self.device:
                raise ValueError('Configured speaker not in this account')
            # A fresh child should rotate the long-lived passToken immediately,
            # not wait for a 401 after the service token has been alive for a
            # long time. Best-effort: a failed refresh restores the old token.
        if not self.interactive:
            await self.refresh_login()
        return {'accountId': self.account_id, 'devices': self.devices,
                'capabilities': capabilities_for(self.device) if self.device else {
                    'tts': 'unverified', 'playbackStop': 'unverified',
                    'playbackCompletion': 'unverified', 'continuousListening': False}}

    def device_capabilities(self, device):
        return capabilities_for(device)

    async def records(self, device=None):
        device = device or self.device
        async with self.api_lock:
            token = self.account.token
            cookies = {'deviceId': device['deviceId'], 'serviceToken': token['micoapi'][1],
                       'userId': str(token['userId'])}
        url = 'https://userprofile.mina.mi.com/device_profile/v2/conversation'
        async with self.session.get(url, params={'source': 'dialogu', 'hardware': device['hardware'],
                                                'timestamp': str(now()), 'limit': '10'}, cookies=cookies) as response:
            if response.status in (401, 403):
                async with self.api_lock:
                    if not await self.account.login('micoapi'):
                        raise PermissionError('Xiaomi authorization required')
                raise ConnectionError('Service token renewed; retrying history')
            response.raise_for_status()
            data = await response.json(content_type=None)
        if data.get('code', 0) != 0:
            raise ConnectionError('Xiaomi conversation API rejected request')
        value = data.get('data') or {}
        value = json.loads(value) if isinstance(value, str) else value
        records = []
        for r in value.get('records') or []:
            if r.get('query') and r.get('time'):
                records.append({'text': r['query'], 'timestamp': int(r['time']),
                                'requestId': r.get('requestId') or r.get('request_id')})
        return records

    def token_refresh_at(self):
        """Wall-clock mtime of the last login/token rotation on disk."""
        try:
            return int((self.state_dir / 'mi-token.json').stat().st_mtime * 1000)
        except OSError:
            return now()

    async def refresh_login(self):
        """Rotate the long-lived passToken without a stored password.

        MiAccount.login() updates self.token['passToken'] and saves the token
        store on success. A failed login (expired passToken, risk control or a
        transient network error) clears self.token inside MiAccount; restore the
        previous in-memory token so the still-valid serviceToken can keep the
        conversation history alive until the normal 401 handling decides.
        """
        if not hasattr(self, 'api_lock'): self.api_lock = asyncio.Lock()
        async with self.api_lock:
            previous = dict(self.account.token) if self.account.token else None
            try:
                ok = await self.account.login('micoapi')
                self.refresh_retryable = False if not ok else True
            except Exception as error:
                ok = False
                self.refresh_retryable = not isinstance(error, PermissionError)
            if not ok:
                self.account.token = previous
            return bool(ok)

    async def speak(self, text, stop, device=None):
        device = device or self.device
        # Serial chunks avoid the next TTS call replacing the previous chunk.
        chunks = speech_chunks(text)
        confirmed = True
        result = {}
        for chunk in chunks:
            if stop.is_set():
                return {'status': 'cancelled', 'completionConfirmed': False}
            result = await self.adapter.speak_chunk(device, chunk)
            if result['status'] != 'accepted':
                return {**result, 'completionConfirmed': False}
            observed_playing = False
            end = time.monotonic() + min(30, max(3, len(chunk) / 5 + 2))
            completed = False
            while time.monotonic() < end and not stop.is_set():
                try:
                    status = await self.adapter.playback_state(device)
                    state = status.get('status') if isinstance(status, dict) else None
                    observed_playing |= state == 1
                    if observed_playing and state == 0:
                        completed = True
                        break
                except Exception:
                    pass
                with suppress(TimeoutError):
                    await asyncio.wait_for(stop.wait(), timeout=1)
            if stop.is_set():
                return {'status': 'cancelled', 'completionConfirmed': False}
            confirmed &= completed
        # Media status is not yet proven to identify LX01 TTS specifically.
        return {**result, 'status': 'accepted', 'completionConfirmed': False,
                'observedPlaybackTransition': confirmed, 'chunks': len(chunks)}

    async def stop_playback(self, device=None):
        return await self.adapter.stop(device or self.device)

    async def pause_native(self, device=None):
        return await self.adapter.stop(device or self.device, native=True)

    async def close(self):
        if self.session:
            await self.session.close()


def speech_chunks(text, size=120):
    text = re.sub(r'```[\s\S]*?```', ' 代码请在 DSH 会话中查看。 ', text)
    text = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'https?://\S+', ' 链接见 DSH 会话 ', text)
    text = re.sub(r'[*#`|>]', '', text).strip()
    result = []
    while text:
        end = min(size, len(text))
        if end < len(text):
            boundary = max(text.rfind(c, 0, end) for c in '。！？；\n.!?;')
            if boundary > size // 3:
                end = boundary + 1
        result.append(text[:end])
        text = text[end:].strip()
    return result


class MockProvider:
    def __init__(self, credential, state_dir, emit, otp, interactive=False):
        self.credential, self.emit = credential, emit
        self.device = {'deviceId': credential.get('deviceId', 'mock-device'), 'hardware': 'LX01'}
        self.account_id = credential.get('accountId', 'mock-account')
        self.queue = []
        self.devices = credential.get('devices') or [dict(self.device, name='Mock speaker')]

    async def open(self):
        return {'accountId': self.account_id, 'devices': self.devices,
                'capabilities': {'tts': 'mock', 'continuousListening': False}}

    async def records(self, device=None):
        selected = (device or self.device)['deviceId']
        return [r for r in self.queue if r.get('deviceId', self.device['deviceId']) == selected]

    def token_refresh_at(self):
        return now()

    async def refresh_login(self):
        return True

    async def speak(self, text, stop, device=None):
        await asyncio.sleep(.01)
        if stop.is_set(): return {'status': 'cancelled', 'completionConfirmed': False}
        return {'status': 'accepted', 'completionConfirmed': False, 'chunks': len(speech_chunks(text))}

    async def stop_playback(self, device=None):
        return True

    async def pause_native(self, device=None):
        return True

    async def close(self):
        pass


class Sidecar:
    def __init__(self, state_dir, mock=False):
        self.root, self.mock = state_dir, mock
        self.store = Store(state_dir)
        self.provider = None
        self.tasks = set()
        self.poll = None
        self.otp_future = None
        self.stopped = asyncio.Event()
        self.stop_speech = asyncio.Event()
        self.speech_lock = asyncio.Lock()
        self.configured = False
        self.poll_interval = 2
        self.last_success = None
        self.speech_epoch = 0
        self.account_mode = False
        self.devices = {}
        self.controls = {}
        self.device_polls = {}
        self.native_mute = {}
        self.history_slots = asyncio.Semaphore(3)

    def emit(self, kind, **data):
        print(json.dumps({'v': VERSION, 'type': kind, **data}, ensure_ascii=False), flush=True)

    async def otp(self, method):
        self.otp_future = asyncio.get_running_loop().create_future()
        self.emit('auth_required', reason='verification-code', method=method)
        try:
            return await asyncio.wait_for(self.otp_future, timeout=300)
        finally:
            self.otp_future = None

    async def configure(self, message):
        try:
            credential = dict(message['credential'])
            interactive = message.get('mode') == 'discover'
            if not interactive:
                credential.pop('password', None)
            self.account_mode = message.get('mode') == 'account'
            Provider = MockProvider if self.mock else XiaomiProvider
            self.provider = Provider(credential, self.root, self.emit, self.otp, interactive=interactive)
            result = await self.provider.open()
            result['capabilities'].update({'multipleDevices': self.account_mode,
                                           'cancelWholeTurn': True, 'nativeSuppression': 'best-effort'})
            self.last_success = now()
            self.emit('ready', **result)
            if self.account_mode:
                self.poll = asyncio.create_task(self.account_refresh_loop())
            elif not interactive:
                self.store.ingest(self.provider.account_id, self.provider.device['deviceId'], [])
                self.poll = asyncio.create_task(self.poll_loop())
        except Exception as error:
            if isinstance(self.provider, XiaomiProvider):
                self.provider.trace_auth('failed', errorType=type(error).__name__)
            if isinstance(error, PermissionError):
                self.emit('auth_required', reason='expired')
                self.emit('error', code='configure-auth-failed', retryable=False,
                          message='小米授权需要更新，请在频道页面重新登录。')
            else:
                # DNS, timeouts, HTTP 5xx and local IO are recoverable. Never
                # turn a temporary boot-time outage into an account lockout.
                self.emit('error', code='configure-unavailable', retryable=True,
                          message='暂时无法连接小米或读取设备状态，将自动重试。')

    def control_for(self, device_id):
        if device_id not in self.controls:
            self.controls[device_id] = {'epoch': 0, 'stop': asyncio.Event(), 'lock': asyncio.Lock()}
        return self.controls[device_id]

    def device_for(self, device_id):
        if self.account_mode:
            return self.devices.get(device_id)
        device = self.provider.device if self.provider else None
        return device if device and device['deviceId'] == device_id else None

    def interrupt(self, device_id, turn_ids=()):
        control = self.control_for(device_id)
        control['epoch'] += 1
        control['stop'].set()
        self.store.cancel_turns(device_id, turn_ids)
        muted = self.native_mute.get(device_id)
        if muted:
            muted[0].cancel()
        return control

    async def end_native_mute(self, device_id):
        muted = self.native_mute.pop(device_id, None)
        if muted:
            muted[0].cancel()
            await asyncio.gather(muted[0], return_exceptions=True)

    async def mute_native_loop(self, device, turn_id):
        device_id = device['deviceId']
        end = time.monotonic() + 6
        reported = False
        try:
            while time.monotonic() < end and not self.stopped.is_set():
                if self.store.turn_cancelled(device_id, turn_id): return
                try:
                    ok = await asyncio.wait_for(self.provider.pause_native(device=device), timeout=2)
                    if not reported:
                        self.emit('native_suppression', deviceId=device_id,
                                  status='pause-accepted' if ok else 'unverified')
                        reported = True
                except Exception:
                    if not reported:
                        self.emit('native_suppression', deviceId=device_id, status='unverified')
                        reported = True
                await asyncio.sleep(.6)
        finally:
            current = self.native_mute.get(device_id)
            if current and current[0] is asyncio.current_task(): self.native_mute.pop(device_id, None)

    async def account_refresh_loop(self):
        deadline = self.provider.token_refresh_at() + PASS_TOKEN_REFRESH_MS
        while not self.stopped.is_set():
            if now() >= deadline:
                # One renewal schedule for the entire account. API calls are
                # serialized only around individual HTTP operations.
                ok = await self.provider.refresh_login()
                deadline = now() + (PASS_TOKEN_REFRESH_MS if ok or not getattr(self.provider, 'refresh_retryable', True) else 5 * 60_000)
            with suppress(TimeoutError):
                await asyncio.wait_for(self.stopped.wait(), timeout=30)

    async def poll_device_loop(self, device):
        device_id = device['deviceId']
        failures = 0
        while not self.stopped.is_set() and device_id in self.devices:
            delay = self.poll_interval
            try:
                async with self.history_slots:
                    records = fresh_records(await self.provider.records(device=device))
                self.store.ingest(self.provider.account_id, device_id, records)
                for event in self.store.pending():
                    if event['deviceId'] == device_id:
                        self.emit(**{'kind': 'utterance', **{k: v for k, v in event.items() if k not in ('type', 'v')}})
                self.last_success = now()
                failures = 0
                if self.control_for(device_id)['lock'].locked() or device_id in self.native_mute:
                    delay = .75  # bounded faster interrupt detection while speaking
            except PermissionError:
                self.emit('auth_required', reason='expired')
                self.stopped.set()
                break
            except Exception as error:
                failures += 1
                delay = min(60, self.poll_interval * 2 ** min(failures, 5))
                try:
                    retry_after = float(getattr(error, 'headers', {}).get('Retry-After', 0))
                    if retry_after > 0: delay = min(300, max(delay, retry_after))
                except (ValueError, TypeError, AttributeError): pass
            self.emit('health', deviceId=device_id, connected=failures == 0,
                      consecutiveFailures=failures, lastSuccessAt=self.last_success,
                      retryInMs=int(delay * 1000))
            with suppress(TimeoutError):
                await asyncio.wait_for(self.stopped.wait(), timeout=delay)

    async def poll_loop(self):
        failures = 0
        try:
            next_auth_refresh = self.provider.token_refresh_at() + PASS_TOKEN_REFRESH_MS
        except Exception:
            next_auth_refresh = now() + PASS_TOKEN_REFRESH_MS
        while not self.stopped.is_set():
            try:
                if now() >= next_auth_refresh and not self.speech_lock.locked():
                    # Keep the long-lived passToken alive without a stored
                    # password. The speech lock prevents a concurrent TTS token
                    # read/rotation; if speech is active, retry on the next poll.
                    next_auth_refresh = now() + PASS_TOKEN_REFRESH_MS
                    async with self.speech_lock:
                        await self.provider.refresh_login()
                records = fresh_records(await self.provider.records())
                self.store.ingest(self.provider.account_id, self.provider.device['deviceId'], records)
                for event in self.store.pending():
                    self.emit(**{'kind': 'utterance', **{k: v for k, v in event.items() if k not in ('type', 'v')}})
                self.last_success = now()
                failures = 0
            except PermissionError:
                failures += 1
                self.emit('auth_required', reason='expired')
                # Never keep calling MiAccount.login with the same rejected
                # credential. Node closes this child on auth_required; stopping
                # here also prevents a login loop if the old Host is still up.
                break
            except Exception:
                failures += 1
            self.emit('health', connected=failures == 0, consecutiveFailures=failures,
                      lastSuccessAt=self.last_success, retryInMs=int(min(60, self.poll_interval * 2 ** min(failures, 5)) * 1000))
            with suppress(TimeoutError):
                await asyncio.wait_for(self.stopped.wait(), timeout=min(60, self.poll_interval * 2 ** min(failures, 5)))

    async def command(self, message):
        rid = message.get('requestId')
        if not isinstance(rid, str) or not rid or len(rid) > 256:
            self.emit('error', code='invalid-request-id'); return
        previous = self.store.begin_command(rid)
        if previous is not None:
            self.emit('command_result', requestId=rid, **previous); return
        device_id = message.get('deviceId')
        kind = message['type']
        try:
            if kind == 'device_add' and self.account_mode:
                device = next((d for d in self.provider.devices if d['deviceId'] == device_id), None)
                if not device: raise ValueError('Unknown device')
                if device_id not in self.devices:
                    self.devices[device_id] = device
                    self.store.ingest(self.provider.account_id, device_id, [])
                    self.device_polls[device_id] = asyncio.create_task(self.poll_device_loop(device))
                result = {'status': 'accepted'}
                if hasattr(self.provider, 'device_capabilities'):
                    result['capabilities'] = self.provider.device_capabilities(device)
            else:
                device = self.device_for(device_id)
                if not device: raise ValueError('Device mismatch')
                control = self.control_for(device_id)
                if kind == 'device_remove' and self.account_mode:
                    self.interrupt(device_id)
                    self.devices.pop(device_id, None)
                    worker = self.device_polls.pop(device_id, None)
                    if worker:
                        worker.cancel(); await asyncio.gather(worker, return_exceptions=True)
                    await self.end_native_mute(device_id)
                    if control['lock'].locked():
                        with suppress(Exception):
                            await asyncio.wait_for(self.provider.stop_playback(device=device), timeout=4)
                    result = {'status': 'accepted'}
                elif kind in ('stop_playback', 'cancel_speech'):
                    stopped = None
                    if message.get('stopDevice', True):
                        try:
                            stopped = bool(await asyncio.wait_for(self.provider.stop_playback(device=device), timeout=4))
                        except Exception: stopped = False
                    result = {'status': 'accepted', 'playbackStopped': stopped, 'completionConfirmed': False}
                elif kind == 'mute_native':
                    await self.end_native_mute(device_id)
                    task = asyncio.create_task(self.mute_native_loop(device, message.get('turnId')))
                    self.native_mute[device_id] = (task, message.get('turnId'))
                    result = {'status': 'accepted', 'completionConfirmed': False}
                else:
                    text = message.get('text'); turn_id = message.get('turnId')
                    if not isinstance(text, str) or not text.strip(): raise ValueError('Empty speech')
                    async with control['lock']:
                        if message.get('_speechEpoch') != control['epoch'] or self.store.turn_cancelled(device_id, turn_id):
                            result = {'status': 'cancelled', 'completionConfirmed': False}
                        else:
                            await self.end_native_mute(device_id)
                            control['stop'] = asyncio.Event()
                            if self.account_mode:
                                result = await self.provider.speak(text, control['stop'], device=device)
                            else:
                                result = await self.provider.speak(text, control['stop'])
            if kind == 'speak' and self.store.turn_cancelled(device_id, message.get('turnId')):
                result = {'status': 'cancelled', 'completionConfirmed': False}
        except Exception:
            result = {'status': 'unknown', 'code': 'provider-result-unknown', 'completionConfirmed': False}
        self.store.finish_command(rid, result)
        self.emit('command_result', requestId=rid, **result)

    async def handle(self, message):
        if not isinstance(message, dict) or message.get('v') != VERSION:
            self.emit('error', code='protocol-version'); return
        kind = message.get('type')
        if kind == 'configure' and not self.configured:
            self.configured = True
            task = asyncio.create_task(self.configure(message))
        elif kind == 'auth_submit' and self.otp_future and not self.otp_future.done():
            code = message.get('code', '')
            if isinstance(code, str) and re.fullmatch(r'[A-Za-z0-9]{4,12}', code): self.otp_future.set_result(code)
            return
        elif kind == 'accepted':
            self.store.ack(message.get('eventId')); return
        elif kind in ('speak', 'stop_playback', 'cancel_speech', 'mute_native', 'device_add', 'device_remove'):
            device_id = message.get('deviceId')
            if not isinstance(device_id, str) or not device_id or len(device_id) > 256:
                self.emit('error', code='invalid-device'); return
            turn_ids = message.get('turnIds', [])
            if not isinstance(turn_ids, list) or len(turn_ids) > 2048 or any(not isinstance(t, str) or len(t) > 160 for t in turn_ids):
                self.emit('error', code='invalid-turn'); return
            if kind in ('stop_playback', 'cancel_speech'):
                self.interrupt(device_id, turn_ids)
            message['_speechEpoch'] = self.control_for(device_id)['epoch']
            task = asyncio.create_task(self.command(message))
        elif kind == 'health':
            self.emit('health', connected=self.last_success is not None, lastSuccessAt=self.last_success); return
        elif kind == 'shutdown':
            self.stopped.set(); return
        elif kind == 'mock_utterance' and self.mock and self.provider:
            self.provider.queue.append({'text': message['text'], 'timestamp': message.get('timestamp', now()),
                                       'deviceId': message.get('deviceId', self.provider.device['deviceId']),
                                       'requestId': message.get('providerRequestId')})
            return
        else:
            self.emit('error', code='unexpected-message'); return
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _readline(self):
        """Read one JSONL line from stdin.

        POSIX uses asyncio's pipe transport. On Windows the Host spawns the
        child with a pipe that is not opened for overlapped I/O, so the
        Proactor loop cannot give it an IOCP handle and every read raises
        `WinError 6 句柄无效`. A worker thread on sys.stdin.buffer keeps the
        same line framing on both platforms.
        """
        if sys.platform == 'win32':
            line = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_LINE + 1)
            # Match StreamReader's payload limit (the newline is not counted).
            # Never parse the remainder of an oversized frame as a new command.
            if len(line) > MAX_LINE and not line.endswith(b'\n'):
                raise ValueError('JSONL line too long')
            return line
        return await self.reader.readline()

    async def run(self):
        self.emit('hello', instanceId=str(uuid.uuid4()), protocolVersion=VERSION, build=BUILD)
        self.reader = reader = asyncio.StreamReader(limit=MAX_LINE)
        if sys.platform != 'win32':
            protocol = asyncio.StreamReaderProtocol(reader)
            await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin.buffer)
        try:
            while not self.stopped.is_set():
                line = await self._readline()
                if not line:
                    break
                try:
                    message = json.loads(line)
                except (ValueError, UnicodeError):
                    self.emit('error', code='invalid-json')
                    continue
                await self.handle(message)
        except (ValueError, asyncio.LimitOverrunError):
            self.emit('error', code='line-too-long')
        finally:
            self.stopped.set()
            self.stop_speech.set()
            tasks = list(self.tasks) + list(self.device_polls.values()) + [v[0] for v in self.native_mute.values()] + ([self.poll] if self.poll else [])
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if self.provider:
                await self.provider.close()
            self.store.close()
            self.emit('stopped')


if __name__ == '__main__':
    os.umask(0o077)
    # Upstream errors can include account responses. Never forward raw upstream logs.
    logging.disable(logging.CRITICAL)
    parser = argparse.ArgumentParser()
    parser.add_argument('--state-dir', required=True, type=Path)
    parser.add_argument('--mock', action='store_true')
    args = parser.parse_args()
    if args.mock and os.environ.get('XIAOAI_TEST_MODE') != '1':
        parser.error('Mock transport requires explicit test environment')
    asyncio.run(Sidecar(args.state_dir.resolve(), args.mock).run())
