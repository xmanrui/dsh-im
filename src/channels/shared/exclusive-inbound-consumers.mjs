function refusal(code) { return Object.assign(new Error(code), { code }); }

/** Process-local exclusive ownership; the application owns durable admission. */
export class ExclusiveInboundConsumers {
  #entries = new Map();

  acceptsImages(botId) { return this.#entries.get(botId)?.sourceImages === true; }
  acceptsFiles(botId) { return this.#entries.get(botId)?.sourceFiles === true; }

  register(botId, { fingerprint, onEvent, signal, sourceImages = false, sourceFiles = false }) {
    if (this.#entries.has(botId)) throw refusal('consumer-conflict');
    if (!/^[a-f0-9]{64}$/.test(fingerprint ?? '') || typeof onEvent !== 'function' || typeof sourceImages !== 'boolean' || typeof sourceFiles !== 'boolean')
      throw refusal('bad-request');
    signal?.throwIfAborted();
    const controller = new AbortController();
    const entry = { fingerprint, onEvent, sourceImages, sourceFiles, controller, dispose: undefined };
    const dispose = () => {
      if (this.#entries.get(botId) === entry) this.#entries.delete(botId);
      controller.abort(refusal('consumer-unavailable'));
      signal?.removeEventListener('abort', dispose);
    };
    entry.dispose = dispose;
    this.#entries.set(botId, entry);
    signal?.addEventListener('abort', dispose, { once: true });
    return dispose;
  }

  async accept(botId, evidence, signal) {
    const entry = this.#entries.get(botId);
    if (!entry) throw refusal('consumer-unavailable');
    if (entry.fingerprint !== evidence.fingerprint) throw refusal('account-changed');
    const current = signal ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal;
    current.throwIfAborted();
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(current.reason);
      current.addEventListener('abort', abort, { once: true });
      if (current.aborted) abort();
    });
    let result;
    try { result = await Promise.race([entry.onEvent(evidence, { signal: current }), interrupted]); }
    finally { current.removeEventListener('abort', abort); }
    current.throwIfAborted();
    if (this.#entries.get(botId) !== entry) throw refusal('consumer-unavailable');
    if (result?.accepted !== true) throw refusal('ingress-not-accepted');
    return { accepted: true };
  }

  signalFor(botId, fingerprint) {
    const entry = this.#entries.get(botId);
    if (!entry) throw refusal('consumer-unavailable');
    if (entry.fingerprint !== fingerprint) throw refusal('account-changed');
    return entry.controller.signal;
  }
  remove(botId) { this.#entries.get(botId)?.dispose(); }
  close() { for (const botId of this.#entries.keys()) this.remove(botId); }
}
