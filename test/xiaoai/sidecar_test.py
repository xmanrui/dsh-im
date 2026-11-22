import importlib.util
import json
import os
from pathlib import Path
import tempfile
import sys
import time
import unittest
from urllib.parse import urlencode
from unittest.mock import patch
from types import SimpleNamespace

path = Path(__file__).resolve().parents[2] / 'sidecar/xiaoai_sidecar.py'
sys.path.insert(0, str(path.parent))
spec = importlib.util.spec_from_file_location('xiaoai_sidecar', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PersistenceTests(unittest.TestCase):
    def test_phone_confirmation_is_not_tied_to_one_interstitial_path(self):
        target = 'https://account.xiaomi.com/pass/serviceLoginAuth2/end?context=mock-only'
        for path in ['/fe/service/verifyPhone', '/fe/service/verifyPhone/', '/fe/service/identity/authEnd']:
            self.assertEqual(module.phone_confirmation_target('https://account.xiaomi.com' + path + '?' + urlencode({'confirmUrl': target})), target)
        self.assertIsNone(module.phone_confirmation_target('https://account.xiaomi.com/pass/serviceLogin'))
        with self.assertRaises(ValueError):
            module.phone_confirmation_target('https://account.xiaomi.com/fe/service/verifyPhone?' + urlencode({'confirmUrl': 'https://example.com/private'}))

    def test_cursor_duplicate_ack_and_restart(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            root = Path(tmp)
            store = module.Store(root)
            store.ingest('a', 'd', [])
            stamp = module.now() + 1
            one = {'text': '同一句话', 'timestamp': stamp, 'requestId': 'provider-one'}
            two = {'text': '同一句话', 'timestamp': stamp, 'requestId': 'provider-two'}
            store.ingest('a', 'd', [one, one, two])
            pending = store.pending()
            self.assertEqual(len(pending), 2)
            store.ack(pending[0]['eventId'])
            store.close()
            store = module.Store(root)
            self.assertEqual(len(store.pending()), 1)
            store.ingest('a', 'd', [one, two])
            self.assertEqual(len(store.pending()), 1)
            store.close()

    def test_interrupted_command_is_unknown_not_reexecuted(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            store = module.Store(Path(tmp))
            self.assertIsNone(store.begin_command('tts-one'))
            store.close()
            store = module.Store(Path(tmp))
            self.assertEqual(store.begin_command('tts-one')['status'], 'unknown')
            store.close()

    def test_fresh_records_drops_utterances_older_than_the_restart_window(self):
        at = module.now()
        records = [{'timestamp': at - 1_000, 'text': '最近'},
                   {'timestamp': at - module.MAX_RECORD_AGE_MS - 1, 'text': '太旧'}]
        self.assertEqual([r['text'] for r in module.fresh_records(records, at=at)], ['最近'])

    def test_identity_scope_and_spoken_chunks(self):
        record = {'timestamp': 1, 'text': '你好'}
        self.assertNotEqual(module.event_id('a', 'd', record), module.event_id('b', 'd', record))
        self.assertNotEqual(module.event_id('a', 'd', record), module.event_id('a', 'e', record))
        text = '这是回答。' * 100 + '\n```print("x")``` [文档](https://example.com)'
        chunks = module.speech_chunks(text)
        self.assertTrue(all(len(c) <= 160 for c in chunks))
        self.assertNotIn('https://', ''.join(chunks))
        self.assertNotIn('print(', ''.join(chunks))


class PassTokenTests(unittest.IsolatedAsyncioTestCase):
    async def test_refresh_login_rotates_the_token_on_success(self):
        provider = object.__new__(module.XiaomiProvider)
        class Account:
            def __init__(self): self.token = {'passToken': 'old', 'micoapi': ('s', 't')}
            async def login(self, sid):
                self.token = {'passToken': 'new', 'micoapi': ('s2', 't2')}
                return True
        provider.account = Account()
        self.assertTrue(await provider.refresh_login())
        self.assertEqual(provider.account.token['passToken'], 'new')

    async def test_refresh_login_restores_the_previous_token_on_failure(self):
        provider = object.__new__(module.XiaomiProvider)
        class Account:
            def __init__(self): self.token = {'passToken': 'old', 'micoapi': ('s', 't')}
            async def login(self, sid):
                self.token = None
                return False
        provider.account = Account()
        self.assertFalse(await provider.refresh_login())
        self.assertEqual(provider.account.token['passToken'], 'old')


class AuthFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_poll_loop_refreshes_an_old_pass_token_before_polling(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            side = module.Sidecar(Path(tmp))
            refreshed = []
            async def refresh_login():
                refreshed.append(True); return True
            async def records():
                side.stopped.set(); return []
            side.provider = SimpleNamespace(account_id='a', device={'deviceId': 'd'},
                token_refresh_at=lambda: 0, refresh_login=refresh_login, records=records)
            try:
                await side.poll_loop()
            finally:
                side.store.close()
            self.assertEqual(refreshed, [True])

    async def test_poll_loop_stops_immediately_after_auth_required(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            side = module.Sidecar(Path(tmp))
            events = []
            side.emit = lambda kind, **data: events.append((kind, data))
            async def records():
                raise PermissionError('expired')
            side.provider = SimpleNamespace(account_id='a', device={'deviceId': 'd'}, records=records)
            try:
                await side.poll_loop()
            finally:
                side.store.close()
            self.assertEqual(events, [('auth_required', {'reason': 'expired'})])


@unittest.skipUnless(importlib.util.find_spec('miservice') and importlib.util.find_spec('aiohttp'), 'Pinned transport dependencies are required')
class OTPReplayTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_miservice_otp_resumes_after_an_alternate_confirm_phone_path(self):
        from yarl import URL

        class Response:
            status = 200
            def __init__(self, url, payload=None, cookies=None):
                self.url = URL(url)
                self.payload = payload
                self.cookies = cookies or {}
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def read(self): return json.dumps(self.payload).encode() if self.payload is not None else b'<html>mock confirmation</html>'
            async def json(self, **kwargs): return self.payload
            def raise_for_status(self): pass

        class Session:
            def __init__(self):
                self.confirmed = False
                self.cookie_jar = SimpleNamespace(filter_cookies=lambda url: {'passToken': True} if self.confirmed else {})
            def request(self, method, url, **kwargs):
                path = module.urlsplit(url).path
                if path == '/pass/serviceLogin':
                    value = {'code': 0, 'userId': 'mock-user', 'passToken': 'mock-pass-token',
                        'location': 'https://sts.mina.mi.com/sts?mock=1', 'nonce': 1, 'ssecurity': 'mock-security'} if self.confirmed else {
                        'code': 70016, 'qs': 'mock', 'sid': 'micoapi', '_sign': 'mock', 'callback': 'mock'}
                elif path == '/pass/serviceLoginAuth2': value = {'code': 0, 'notificationUrl': 'https://account.xiaomi.com/fe/service/identity/authStart?context=mock&sid=micoapi'}
                elif path == '/identity/list': value = {'code': 0, 'flag': 4}
                elif path == '/identity/auth/verifyPhone' and method == 'POST': value = {'code': 0, 'location': 'https://account.xiaomi.com/identity/result/check?mock=1'}
                elif path in ('/identity/auth/verifyPhone', '/identity/auth/sendPhoneTicket'): value = {'code': 0}
                elif path == '/identity/result/check':
                    target = 'https://account.xiaomi.com/pass/serviceLoginAuth2/end?mock=1'
                    return Response('https://account.xiaomi.com/fe/service/identity/authEnd?' + urlencode({'confirmUrl': target}))
                elif path == '/pass/serviceLoginAuth2/end': self.confirmed = True; return Response(url)
                elif path == '/sts': return Response(url, cookies={'serviceToken': SimpleNamespace(value='mock-service-token')})
                elif path == '/admin/v2/device_list': value = {'code': 0, 'data': [{'deviceID': 'mock-device', 'name': 'Mock LX01', 'hardware': 'LX01'}]}
                elif path == '/fe/service/identity/authStart': return Response(url)
                else: raise AssertionError('Unexpected mocked authentication path')
                return Response(url, value)
            async def close(self): pass

        async def otp(method): self.assertEqual(method, 'Phone'); return '123456'
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            session = Session()
            provider = module.XiaomiProvider({'account': 'mock-account', 'password': 'mock-password'}, Path(tmp), lambda *a, **k: None, otp, interactive=True)
            with patch('aiohttp.ClientSession', return_value=session):
                result = await provider.open()
            self.assertEqual(result['devices'][0]['hardware'], 'LX01')
            self.assertTrue(session.confirmed)
            trace = (Path(tmp) / 'auth-diagnostics.json').read_text()
            self.assertIn('follow_confirmation', trace)
            for value in ['mock-password', 'mock-pass-token', 'mock-service-token', 'mock-security', '123456', 'mock-account']:
                self.assertNotIn(value, trace)
            await provider.close()


    async def test_miot_uses_current_client_ua_and_allows_recursive_401_renewal(self):
        import asyncio
        from miservice import MiAccount
        from miservice.miaccount import UA_LOGIN
        from yarl import URL
        headers_seen=[]
        class Response:
            status=200
            headers={}
            url=URL('https://api.io.mi.com/app/miotspec/action')
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
            async def read(self):return b'{"code":0,"result":{"code":0}}'
        class Session:
            cookie_jar=SimpleNamespace(filter_cookies=lambda url:{})
            def request(self,method,url,**kwargs):
                headers_seen.append(kwargs.get('headers'));return Response()
            async def close(self):pass
        async def fake_request(account,sid,url,data,headers,relogin=True):
            if sid=='micoapi':
                account.token={'userId':'mock-user','passToken':'mock-secret'}
                return {'code':0,'data':[{'deviceID':'uuid','hardware':'OH2','miotDID':'123'}]}
            if relogin:
                return await account.mi_request(sid,url,data,headers,False)
            return {'code':0,'result':{'code':0}}
        async def refreshed(provider):return True
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            provider=module.XiaomiProvider({'account':'mock'},Path(tmp),lambda *a,**k:None,None)
            with patch('aiohttp.ClientSession',return_value=Session()), patch.object(MiAccount,'mi_request',fake_request), patch.object(module.XiaomiProvider,'refresh_login',refreshed):
                await provider.open()
                self.assertEqual(await asyncio.wait_for(provider.miot.miot_action('123',[5,3],['test']),1),0)
                async with provider.account.request('https://api.io.mi.com/app/miotspec/action','POST',headers={'User-Agent':'old-client'}):pass
                async with provider.account.request('https://api2.mina.mi.com/remote/ubus','POST',headers={'User-Agent':'existing-mina'}):pass
                self.assertEqual(headers_seen[0]['User-Agent'],UA_LOGIN)
                self.assertEqual(headers_seen[1]['User-Agent'],'existing-mina')
            await provider.close()


class NewFeatureTests(unittest.IsolatedAsyncioTestCase):
    async def test_configure_timeout_is_retryable_and_never_an_auth_lockout(self):
        class Unavailable:
            def __init__(self, *args, **kwargs): pass
            async def open(self): raise TimeoutError('mock network timeout')
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            side=module.Sidecar(Path(tmp),mock=True); events=[]
            side.emit=lambda kind, **data: events.append((kind,data))
            try:
                with patch.object(module,'MockProvider',Unavailable):
                    await side.configure({'credential':{'account':'mock'},'mode':'listen'})
                self.assertFalse(any(kind=='auth_required' for kind,data in events))
                self.assertEqual(events[-1][1]['code'],'configure-unavailable')
                self.assertTrue(events[-1][1]['retryable'])
            finally: side.store.close()

    async def test_configure_rejected_authorization_still_requires_human_login(self):
        class Rejected:
            def __init__(self, *args, **kwargs): pass
            async def open(self): raise PermissionError('mock token rejected')
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            side=module.Sidecar(Path(tmp),mock=True);events=[];side.emit=lambda kind,**data:events.append((kind,data))
            try:
                with patch.object(module,'MockProvider',Rejected):
                    await side.configure({'credential':{'account':'mock'},'mode':'listen'})
                self.assertIn(('auth_required',{'reason':'expired'}),events)
            finally:side.store.close()

    async def test_cancel_is_not_queued_behind_speech_and_never_resumes_an_old_turn(self):
        import asyncio
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            side=module.Sidecar(Path(tmp),mock=True);side.account_mode=True
            devices=[{'deviceId':'one','hardware':'LX01'},{'deviceId':'two','hardware':'LX01'}]
            side.devices={d['deviceId']:d for d in devices};calls=[];events=[];entered=asyncio.Event()
            async def speak(text,stop,device=None):
                calls.append((device['deviceId'],text))
                if device['deviceId']=='one':
                    entered.set();await stop.wait();return {'status':'cancelled','completionConfirmed':False}
                return {'status':'accepted','completionConfirmed':False}
            async def stop_playback(device=None):return True
            side.provider=SimpleNamespace(speak=speak,stop_playback=stop_playback)
            side.emit=lambda kind,**data:events.append((kind,data))
            async def send(kind,rid,device,**fields):await side.handle({'v':1,'type':kind,'requestId':rid,'deviceId':device,**fields})
            try:
                await send('speak','s1','one',text='current',turnId='old-turn')
                await asyncio.wait_for(entered.wait(),timeout=1)
                await send('speak','s2','one',text='queued',turnId='old-turn')
                await send('speak','s3','two',text='other-device',turnId='other-turn')
                await send('cancel_speech','stop','one',turnIds=['old-turn'])
                await asyncio.wait_for(asyncio.gather(*list(side.tasks)),timeout=1)
                await send('speak','late','one',text='late old answer',turnId='old-turn')
                await asyncio.wait_for(asyncio.gather(*list(side.tasks)),timeout=1)
                self.assertEqual(calls,[('one','current'),('two','other-device')])
                results={data['requestId']:data['status'] for kind,data in events if kind=='command_result'}
                self.assertEqual(results['s1'],'cancelled');self.assertEqual(results['s2'],'cancelled')
                self.assertEqual(results['s3'],'accepted');self.assertEqual(results['late'],'cancelled')
            finally:
                for task in side.tasks:task.cancel()
                await asyncio.gather(*list(side.tasks),return_exceptions=True);side.store.close()

    async def test_native_pause_window_ends_before_dsh_speech_starts(self):
        import asyncio
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            side=module.Sidecar(Path(tmp),mock=True);side.account_mode=True
            device={'deviceId':'one','hardware':'LX01'};side.devices={'one':device};calls=[];paused=asyncio.Event()
            async def pause_native(device=None):calls.append('pause');paused.set();return True
            async def speak(text,stop,device=None):calls.append('speak');return {'status':'accepted','completionConfirmed':False}
            side.provider=SimpleNamespace(pause_native=pause_native,speak=speak);side.emit=lambda *a,**k:None
            try:
                await side.handle({'v':1,'type':'mute_native','deviceId':'one','turnId':'turn','requestId':'mute'})
                await asyncio.wait_for(paused.wait(),timeout=1)
                await side.handle({'v':1,'type':'speak','deviceId':'one','turnId':'turn','text':'answer','requestId':'speak'})
                await asyncio.wait_for(asyncio.gather(*list(side.tasks)),timeout=1)
                await asyncio.sleep(.05)
                self.assertEqual(calls[-1],'speak');self.assertNotIn('one',side.native_mute)
            finally:
                for task in side.tasks:task.cancel()
                for task,_ in side.native_mute.values():task.cancel()
                await asyncio.gather(*list(side.tasks),return_exceptions=True);side.store.close()

    async def test_real_chunk_loop_stops_before_sending_the_next_chunk(self):
        import asyncio
        provider=object.__new__(module.XiaomiProvider);provider.device={'deviceId':'one'};stop=asyncio.Event();calls=[]
        async def ubus(*args):calls.append(args);return {'code':0,'data':{'code':0}}
        async def status(*args):stop.set();return {'status':1}
        provider.mina=SimpleNamespace(_ubus_request=ubus,player_get_status=status)
        provider.adapter=module.SpeakerAdapter(provider.mina,None)
        result=await provider.speak('这是很长的回答。'*80,stop)
        self.assertEqual(result['status'],'cancelled');self.assertEqual(len(calls),1)

class ModelAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        from speaker_adapter import SpeakerAdapter
        self.calls = []
        async def action(did, command, args):
            self.calls.append(('miot', did, command, args)); return 0
        async def ubus(did, method, path, payload):
            self.calls.append(('mina', did, method, payload)); return {'code': 0, 'data': {'code': 0}}
        async def props(did, command):
            self.calls.append(('state', did, command)); return 1
        self.miot = SimpleNamespace(miot_action=action, miot_get_prop=props)
        self.mina = SimpleNamespace(_ubus_request=ubus)
        self.adapter = SpeakerAdapter(self.mina, self.miot)

    async def test_models_use_their_own_tts_action_and_real_miot_did(self):
        import asyncio
        for model, command in [('OH2', [5, 3]), ('OH2P', [7, 3]), ('L09A', [3, 1]), ('LX06', [5, 1])]:
            with self.subTest(model=model):
                result = await self.adapter.speak_chunk({'deviceId': 'mina-uuid', 'hardware': model, 'miotDID': '12345'}, 'test')
                self.assertEqual(result['status'], 'accepted')
                self.assertEqual(self.calls[-1], ('miot', '12345', command, ['test']))
        await asyncio.gather(*[self.adapter.speak_chunk({'deviceId': 'uuid-' + did,
            'hardware': model, 'miotDID': did}, did) for model, did in [('OH2','100'),('OH2P','200')]])
        self.assertEqual({call[1] for call in self.calls[-2:]}, {'100','200'})

    async def test_lx01_keeps_its_existing_mina_route(self):
        result = await self.adapter.speak_chunk({'deviceId': 'mini-uuid', 'hardware': 'LX01', 'miotDID': '123'}, 'test')
        self.assertEqual(result['status'], 'accepted')
        self.assertEqual(self.calls, [('mina','mini-uuid','text_to_speech',{'text':'test'})])

    async def test_unknown_or_missing_did_is_explicitly_unverified(self):
        from speaker_adapter import capabilities_for
        for device in [{'deviceId':'one','hardware':'FUTURE'}, {'deviceId':'two','hardware':'OH2','miotDID':None},
                       {'deviceId':'three','hardware':'OH2','miotDID':'None'}, {'deviceId':'four'}]:
            with self.subTest(device=device):
                caps = capabilities_for(device)
                self.assertEqual(caps['tts'], 'unverified')
                await self.adapter.speak_chunk(device, 'test')
                self.assertEqual(self.calls[-1][0], 'mina')
        self.assertEqual(capabilities_for({'hardware':'FUTURE'})['modelProfile'], 'generic')

    async def test_rejection_and_timeout_never_send_a_second_tts_request(self):
        device = {'deviceId':'uuid','hardware':'OH2','miotDID':'123'}
        for code in [-704042011, None]:
            async def rejected(*args): self.calls.append(('rejected',)); return code
            self.miot.miot_action = rejected
            before = len(self.calls)
            result = await self.adapter.speak_chunk(device,'test')
            self.assertEqual(result['status'], 'failed' if code else 'unknown')
            self.assertEqual(len(self.calls), before+1)
        async def timeout(*args): self.calls.append(('timeout',)); raise TimeoutError('private upstream details')
        self.miot.miot_action = timeout
        before = len(self.calls)
        result = await self.adapter.speak_chunk(device,'test')
        self.assertEqual(result['status'],'unknown'); self.assertEqual(len(self.calls),before+1)
        self.assertNotIn('private',json.dumps(result))

    async def test_nested_mina_rejections_and_malformed_payloads_are_not_success(self):
        from speaker_adapter import ubus_result
        self.assertEqual(ubus_result({'code':0,'data':{'code':-3,'raw':'secret'}}),
            {'status':'failed','providerCode':0,'innerCode':-3})
        for response in [None, {}, {'code':0,'data':'not json'}, {'code':0,'data':[]}, {'code':0,'data':{'code':None}}]:
            self.assertEqual(ubus_result(response)['status'],'unknown')

    async def test_miot_authorization_rejection_does_not_replay_login_or_break_lx01(self):
        async def rejected(*args):
            self.calls.append(('auth-rejected',)); raise PermissionError('private authorization response')
        self.miot.miot_action = rejected
        device={'deviceId':'uuid','hardware':'OH2','miotDID':'123'}
        with self.assertRaises(PermissionError):
            await self.adapter.stop(device,native=True)
        result=await self.adapter.speak_chunk(device,'test')
        self.assertEqual(result['code'],'tts-authorization-required')
        self.assertEqual(self.calls,[('auth-rejected',)])
        self.assertEqual((await self.adapter.speak_chunk({'deviceId':'mini','hardware':'LX01'},'test'))['status'],'accepted')

    async def test_throttling_preserves_numeric_evidence_without_retrying_or_disabling_mina(self):
        from speaker_adapter import SpeakerCloudError
        async def throttled(*args):
            self.calls.append(('throttle',)); raise SpeakerCloudError(429,-127,'60')
        self.miot.miot_action=throttled
        device={'deviceId':'uuid','hardware':'OH2','miotDID':'123'}
        first=await self.adapter.speak_chunk(device,'test')
        second=await self.adapter.speak_chunk(device,'another independent request')
        self.assertEqual(first['code'],'tts-rate-limited')
        self.assertEqual(first['httpStatus'],429);self.assertEqual(first['providerCode'],-127)
        self.assertEqual(second['status'],'failed');self.assertEqual(self.calls,[('throttle',)])
        self.assertEqual((await self.adapter.speak_chunk({'deviceId':'mini','hardware':'LX01'},'test'))['status'],'accepted')

    async def test_model_specific_stop_and_state_use_the_selected_speaker(self):
        device = {'deviceId':'uuid','hardware':'OH2','miotDID':'456'}
        self.assertTrue(await self.adapter.stop(device))
        self.assertEqual(self.calls[-1],('miot','456',[3,3],[]))
        self.assertTrue(await self.adapter.stop(device,native=True))
        self.assertEqual(await self.adapter.playback_state(device),{'status':1})
        self.assertEqual(self.calls[-1],('state','456',[3,1]))
        async def bad(*args): return {'code':0,'data':{'code':-1}}
        self.mina._ubus_request = bad
        self.assertFalse(await self.adapter.stop({'deviceId':'mini','hardware':'LX01'}))

    async def test_all_registered_actions_have_checked_specs_and_do_not_claim_completion(self):
        from speaker_adapter import REGISTRY, capabilities_for
        self.assertEqual(len(REGISTRY['models']),20)
        for hardware, profile in REGISTRY['models'].items():
            with self.subTest(hardware=hardware):
                self.assertTrue(profile['specSource'].startswith('https://miot-spec.org/'))
                caps=capabilities_for({'hardware':hardware,'miotDID':'123'})
                self.assertEqual(caps['tts'],'configured')
                self.assertEqual(caps['playbackCompletion'],'unverified')


if __name__ == '__main__':
    unittest.main()
