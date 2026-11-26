"""Model-specific speaker commands. No speculative TTS retries or runtime downloads."""
import json
from pathlib import Path
import time


REGISTRY = json.loads(Path(__file__).with_name('device_profiles.json').read_text(encoding='utf-8'))


class SpeakerCloudError(Exception):
    """Only numeric, non-secret cloud diagnostics cross the provider boundary."""
    def __init__(self, status, code=None, retry_after=None):
        super().__init__('Speaker cloud request rejected')
        self.status = status
        self.provider_code = numeric_code(code)
        try:
            self.retry_after = min(300, max(1, float(retry_after)))
        except (TypeError, ValueError):
            self.retry_after = 30


def profile_for(device):
    hardware = str(device.get('hardware') or 'UNKNOWN').strip().upper()
    return hardware, REGISTRY['models'].get(hardware)


def miot_did(device):
    value = device.get('miotDID')
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    value = str(value).strip()
    return value if value and value.lower() not in ('none', 'null', '0') else None


def route_for(device):
    hardware, profile = profile_for(device)
    return 'miot' if profile and profile['preferredTransport'] == 'miot' and miot_did(device) else 'mina'


def capabilities_for(device):
    hardware, profile = profile_for(device)
    route = route_for(device)
    configured = bool(profile and (route == 'miot' or profile['preferredTransport'] == 'mina'))
    return {'tts': 'configured' if configured else 'unverified', 'ttsTransport': route,
        'modelProfile': hardware if profile else 'generic',
        'profileReason': 'known-model' if configured else 'missing-miot-did' if profile else 'unknown-model',
        'ttsAction': profile['ttsAction'] if route == 'miot' else None,
        'playbackStop': 'configured' if route == 'miot' and profile.get('pauseAction') else 'unverified',
        'playbackCompletion': 'unverified', 'continuousListening': False,
        'multipleDevices': True, 'cancelWholeTurn': True, 'nativeSuppression': 'best-effort'}


def numeric_code(value):
    return value if type(value) is int else None


def ubus_result(response):
    """Return only safe numeric status fields; never expose raw cloud responses."""
    if not isinstance(response, dict):
        return {'status': 'unknown'}
    outer = numeric_code(response.get('code'))
    result = {'status': 'unknown', 'providerCode': outer}
    if outer is None:
        return result
    if outer != 0:
        return {**result, 'status': 'failed'}
    data = response.get('data')
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except (ValueError, TypeError):
            return result
    if not isinstance(data, dict):
        return result
    inner = numeric_code(data.get('code', 0))
    return {**result, 'innerCode': inner,
            'status': 'unknown' if inner is None else 'accepted' if inner == 0 else 'failed'}


class SpeakerAdapter:
    def __init__(self, mina, miot):
        self.mina, self.miot = mina, miot
        self.miot_authorization_failed = False
        self.miot_throttle = None
        self.miot_retry_at = 0

    async def _miot_call(self, method, *args):
        if self.miot_authorization_failed:
            raise PermissionError('Interactive Xiaomi authorization required')
        if self.miot_throttle and time.monotonic() < self.miot_retry_at:
            raise self.miot_throttle
        try:
            return await getattr(self.miot, method)(*args)
        except PermissionError:
            self.miot_authorization_failed = True
            raise
        except SpeakerCloudError as error:
            if error.status == 429:
                self.miot_throttle = error
                self.miot_retry_at = time.monotonic() + error.retry_after
            raise

    async def speak_chunk(self, device, text):
        hardware, profile = profile_for(device)
        route = route_for(device)
        details = {'transport': route, 'modelProfile': hardware if profile else 'generic'}
        try:
            if route == 'miot':
                code = numeric_code(await self._miot_call('miot_action', miot_did(device), profile['ttsAction'], [text]))
                result = {'status': 'unknown' if code is None else 'accepted' if code == 0 else 'failed',
                          'providerCode': code}
            else:
                result = ubus_result(await self.mina._ubus_request(device['deviceId'],
                    'text_to_speech', 'mibrain', {'text': text}))
        except PermissionError:
            return {**details, 'status': 'failed', 'code': 'tts-authorization-required'}
        except SpeakerCloudError as error:
            return {**details, 'status': 'failed' if 400 <= error.status < 500 else 'unknown',
                'code': 'tts-rate-limited' if error.status == 429 else 'tts-cloud-error',
                'httpStatus': error.status, 'providerCode': error.provider_code}
        except Exception as error:
            # A timeout may have happened after the speaker accepted the text.
            # Sending it via another interface here could speak it twice.
            return {**details, 'status': 'unknown', 'code': 'tts-result-unknown', 'errorType': type(error).__name__}
        if result['status'] != 'accepted':
            result['code'] = 'tts-rejected' if result['status'] == 'failed' else 'tts-result-unknown'
        return {**details, **result}

    async def playback_state(self, device):
        _, profile = profile_for(device)
        if route_for(device) == 'miot' and profile.get('playing'):
            if self.miot_authorization_failed:
                return None
            config = profile['playing']
            value = await self._miot_call('miot_get_prop', miot_did(device), config['property'])
            if type(value) is not int:
                return None
            if value in config['active']:
                return {'status': 1}
            if value in config['idle']:
                return {'status': 0}
            if value in config['paused']:
                return {'status': 2}
            return None
        return await self.mina.player_get_status(device['deviceId'])

    async def stop(self, device, *, native=False):
        _, profile = profile_for(device)
        if route_for(device) == 'miot' and profile.get('pauseAction'):
            code = await self._miot_call('miot_action', miot_did(device), profile['pauseAction'], [])
            return type(code) is int and code == 0
        result = ubus_result(await self.mina._ubus_request(device['deviceId'],
            'player_play_operation', 'mediaplayer', {'action': 'pause' if native else 'stop', 'media': 'app_ios'}))
        return result['status'] == 'accepted'
