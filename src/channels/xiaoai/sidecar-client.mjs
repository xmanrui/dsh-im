import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Provider logs are suppressed, and the sidecar never needs the Host's model
// keys, proxy credentials or other integration secrets. Pass only the
// variables a CPython process needs to start and reach the private runtime
// directory; HOME/XDG are redirected under the per-bot state directory.
const PASSTHROUGH_ENV = Object.freeze([
  'PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'SYSTEMROOT', 'WINDIR',
]);

export function sidecarEnvironment({ stateDir, dependencyDir, mock = false } = {}) {
  const env = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (typeof value === 'string' && value) env[key] = value;
  }
  const tmp = join(stateDir, 'tmp');
  env.HOME = stateDir;
  env.XDG_CACHE_HOME = join(stateDir, 'cache');
  env.TMPDIR = tmp; env.TMP = tmp; env.TEMP = tmp;
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONIOENCODING = 'utf-8';
  if (dependencyDir) env.PYTHONPATH = dependencyDir;
  if (mock) env.XIAOAI_TEST_MODE = '1';
  return env;
}

export class SidecarClient extends EventEmitter {
  #options; #child; #pending = new Map(); #buffer = ''; #decoder = new StringDecoder('utf8');
  #ready; #resolveReady; #rejectReady; #closing = false; #hello = false; #closeTask;
  constructor(options) {
    super();
    this.#options = options;
    this.#ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    this.#ready.catch(() => {});
  }
  get ready() { return this.#ready; }
  get pid() { return this.#child?.pid; }
  async start(credential, mode = 'listen') {
    const { python, script, stateDir, mock = false } = this.#options;
    if (!python || !script || !stateDir || !resolve(python).startsWith('/') && process.platform !== 'win32') {
      throw new TypeError('Explicit Python, sidecar and state paths are required');
    }
    await mkdir(join(stateDir, 'tmp'), { recursive: true, mode: 0o700 });
    this.#child = spawn(python, ['-B', '-u', script, '--state-dir', stateDir, ...(mock ? ['--mock'] : [])], {
      cwd: stateDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: sidecarEnvironment({ stateDir, dependencyDir: this.#options.dependencyDir, mock }),
    });
    this.#child.stdout.on('data', (chunk) => {
      this.#buffer += this.#decoder.write(chunk);
      if (this.#buffer.length > 256 * 1024 && !this.#buffer.includes('\n')) return this.#fail('sidecar-line-too-long');
      let end;
      while ((end = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
        if (line.length > 256 * 1024) return this.#fail('sidecar-line-too-long');
        let message;
        try { message = JSON.parse(line); } catch { return this.#fail('sidecar-invalid-json'); }
        if (message?.v !== 1 || typeof message.type !== 'string') return this.#fail('sidecar-protocol-mismatch');
        if (message.type === 'hello') {
          if (this.#hello) return this.#fail('sidecar-duplicate-hello');
          this.#hello = true;
          this.send({ type: 'configure', credential, mode }).catch(() => this.#fail('sidecar-write-failed'));
        } else if (!this.#hello) return this.#fail('sidecar-missing-hello');
        else if (message.type === 'ready') this.#resolveReady(message);
        else if (message.type === 'error' && /^configure-/.test(message.code ?? '')) {
          this.#rejectReady(Object.assign(new Error('Xiaomi transport configuration unavailable'), { code: message.code, retryable: message.retryable }));
        }
        else if (message.type === 'command_result') {
          const pending = this.#pending.get(message.requestId);
          if (pending) { clearTimeout(pending.timer); this.#pending.delete(message.requestId); pending.resolve(message); }
        }
        this.emit('message', message);
      }
    });
    // Do not forward provider logs that may contain credentials or cloud responses.
    this.#child.stderr.on('data', () => this.emit('diagnostic', { code: 'sidecar-stderr' }));
    this.#child.stdin.on('error', () => { if (!this.#closing) this.#fail('sidecar-write-failed'); });
    this.#child.stdout.on('error', () => { if (!this.#closing) this.#fail('sidecar-read-failed'); });
    this.#child.stderr.on('error', () => {});
    this.#child.once('error', () => this.#fail('sidecar-spawn-failed'));
    this.#child.once('exit', (code, signal) => {
      this.#rejectReady(Object.assign(new Error('XiaoAI Sidecar exited'), { code: 'sidecar-exited' }));
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ status: 'unknown', code: 'sidecar-exited', completionConfirmed: false });
      }
      this.#pending.clear();
      this.emit('exit', { code, signal, expected: this.#closing });
    });
    return this;
  }
  #fail(code) {
    this.#rejectReady(Object.assign(new Error(code), { code }));
    this.emit('fault', { code });
    this.#child?.kill('SIGTERM');
  }
  send(message) {
    return new Promise((resolve, reject) => {
      if (!this.#child?.stdin?.writable || this.#closing && message.type !== 'shutdown') return reject(new Error('Sidecar is offline'));
      this.#child.stdin.write(JSON.stringify({ v: 1, ...message }) + '\n', (error) => error ? reject(error) : resolve());
    });
  }
  request(type, fields, { requestId = randomUUID(), timeoutMs = 600_000 } = {}) {
    if (this.#pending.has(requestId)) return Promise.reject(new Error('Duplicate outstanding request ID'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve({ status: 'unknown', code: 'command-timeout', completionConfirmed: false });
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, timer });
      this.send({ type, requestId, ...fields }).catch(() => {
        clearTimeout(timer); this.#pending.delete(requestId);
        resolve({ status: 'unknown', code: 'sidecar-write-failed', completionConfirmed: false });
      });
    });
  }
  close() { return this.#closeTask ??= this.#close(); }
  async #close() {
    this.#closing = true;
    const child = this.#child;
    if (!child?.pid || child.exitCode !== null || child.signalCode) return;
    const exited = new Promise((resolve) => child.once('close', resolve));
    const timer = setTimeout(() => child.kill('SIGTERM'), 3_000);
    const force = setTimeout(() => child.kill('SIGKILL'), 6_000);
    await this.send({ type: 'shutdown' }).catch(() => {});
    child.stdin.end();
    await exited; clearTimeout(timer); clearTimeout(force);
  }
}

export async function waitReady(client, timeoutMs = 25_000) {
  let timer;
  try {
    return await Promise.race([client.ready, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('XiaoAI login is not ready'), { code: 'xiaoai-not-ready' })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
