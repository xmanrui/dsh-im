import { HarnessClient } from '../shared/harness-client.mjs';
export class AirumoHarnessClient extends HarnessClient {
  constructor(options) {
    super({ ...options, rpcIdPrefix: 'airumo', logPrefix: 'dsh-airumo' });
  }
}
