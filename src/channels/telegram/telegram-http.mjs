import { FormData as UndiciFormData } from 'undici';
import { createChannelHttp } from '../shared/proxy.mjs';

const TELEGRAM_CONNECTIONS = 4;

/**
 * The HTTP transport the Telegram channel runs on.
 *
 * Without `spec` the channel keeps its old behaviour: undici's environment-aware
 * agent, so HTTPS_PROXY/NO_PROXY still decide. With a spec (the IM proxy from the
 * plugin config) every API call, file download and upload of this channel — and
 * only this channel — goes through that proxy.
 */
export function createTelegramHttpTransport({ spec = null, useEnv = true } = {}) {
  const transport = createChannelHttp({
    spec,
    useEnv,
    connections: TELEGRAM_CONNECTIONS,
    FormDataImpl: UndiciFormData,
  });
  return {
    fetchImpl: transport.fetchImpl,
    FormDataImpl: UndiciFormData,
    proxy: transport.proxy,
    destroy: transport.destroy,
  };
}
