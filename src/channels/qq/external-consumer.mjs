import { createHash } from 'node:crypto';
import { ApiError, getNextMsgSeq, messagePath } from '@tencent-connect/qqbot-nodejs/protocol';
import { QqNativeReplyObservations, qqNativeIdentifier as identifier } from './native-reply-observations.mjs';
import { qqSourceImages, readQqSourceImage, checkedQqImageFile, uploadQqCheckedImage } from './external-images.mjs';

export function qqRefusal(code) { return Object.assign(new Error(code), { code }); }

function nativeReplyFailure(error) {
  if (!(error instanceof ApiError)) return qqRefusal('reply-result-unknown');
  const code = Number(error.bizCode);
  if ([304103, 40034005].includes(code)) return qqRefusal('reply-window-expired');
  if (code === 40034128) return qqRefusal('reply-limit-exceeded');
  if (error.httpStatus === 429 || code === 40034100) return qqRefusal('reply-rate-limited');
  if ([40034101, 40034105, 40054002, 40054003, 40054016].includes(code))
    return qqRefusal('reply-permission-denied');
  if ([22006, 304061, 40034006, 40054007, 40054010].includes(code)) return qqRefusal('bad-request');
  if (code === 40034024) return qqRefusal('stale-route');
  return qqRefusal('reply-result-unknown');
}

export function verifiedQqAccount(appId, user) {
  // Authenticated GET /users/@me identifies the current robot. Live group apps
  // can omit the example's bot flag; an explicit contradictory flag still fails.
  const robot = user && (user.bot === true || !Object.hasOwn(user, 'bot'));
  if (!identifier(appId) || !identifier(user?.id) || !robot) {
    const error = qqRefusal('account-unverified');
    error.verificationFailure = !identifier(appId) ? 'application-id'
      : !identifier(user?.id) ? 'native-user-id' : 'native-bot-flag';
    throw error;
  }
  const identity = { provider: 'qq', appId, userId: user.id };
  return Object.freeze({ appId, userId: user.id,
    fingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    ...(typeof user.username === 'string' && user.username.trim()
      ? { name: user.username.slice(0, 512) } : {}),
  });
}

/** QQ group and member OpenIDs belong to this authenticated application. */
export function normalizeQqExternalText(message, { botId, account }) {
  if (message?.kind !== 'group' || message.rawEventType !== 'GROUP_AT_MESSAGE_CREATE'
    || message.senderIsBot || message.senderId === account.userId
    || message.attachments?.length || message.msgElements?.length
    || (message.msgType !== undefined && message.msgType !== 0)) return null;
  if (!identifier(message.messageId) || !identifier(message.senderId)
    || !identifier(message.groupOpenid) || typeof message.content !== 'string'
    || !message.content.trim() || message.content.length > 16000
    || message.replyTarget?.scope !== 'group'
    || message.replyTarget.targetId !== message.groupOpenid
    || message.replyTarget.msgId !== message.messageId)
    throw qqRefusal('invalid-inbound');
  const at = new Date(message.timestamp);
  if (!Number.isFinite(at.getTime())) throw qqRefusal('invalid-inbound');
  return Object.freeze({ version: 1, channel: 'qq', botId, fingerprint: account.fingerprint,
    eventId: message.messageId, messageId: message.messageId,
    actor: { kind: 'user', id: message.senderId,
      ...(typeof message.senderName === 'string' && message.senderName.trim()
        ? { name: message.senderName.slice(0, 512) } : {}) },
    conversation: { kind: 'group', id: message.groupOpenid },
    mentions: [], mentionedAccount: true, at: at.toISOString(), text: message.content,
    reply: { messageId: message.messageId, conversationId: message.groupOpenid, actorId: message.senderId },
    replay: { kind: 'provider-redelivery', resumeCursor: false, gapPossible: true },
  });
}

/** Bounded, process-local source proof, never a second durable Inbox or history. */
export class QqExternalConsumer {
  #bot;
  #account;
  #botId;
  #accept;
  #observations;
  #sourceImages;
  #sources = new Map();
  constructor({ bot, account, botId, accept, sourceImages = () => false, reportNativeObservation = () => {} }) {
    this.#bot = bot; this.#account = account; this.#botId = botId; this.#accept = accept;
    this.#observations = new QqNativeReplyObservations({ account, report: reportNativeObservation });
    this.#sourceImages = sourceImages;
  }
  async accept(message, signal) {
    this.#observations.receive(message, signal);
    const images = this.#sourceImages() === true && message?.attachments?.length;
    const base = normalizeQqExternalText(images ? { ...message, attachments: undefined,
      content: typeof message.content === 'string' && !message.content.trim() ? '[Image]' : message.content } : message,
    { botId: this.#botId, account: this.#account });
    const media = base && images ? qqSourceImages(message, base) : undefined;
    const event = media?.event ?? base;
    if (!event) return;
    signal.throwIfAborted();
    const prior = this.#sources.get(event.messageId);
    if (prior && JSON.stringify(prior.event) !== JSON.stringify(event)) throw qqRefusal('stale-route');
    // Consumer-owned objects never become the Provider's source authority.
    if (!prior) this.#sources.set(event.messageId, { event: structuredClone(event),
      ...(media ? { files: structuredClone(media.files) } : {}), attempts: 0 });
    while (this.#sources.size > 2000) this.#sources.delete(this.#sources.keys().next().value);
    // The external consumer acknowledges only after canonical ingestion commits.
    return this.#accept(event, signal);
  }
  #source(route, signal) {
    if (signal?.aborted) throw qqRefusal('cancelled');
    const source = this.#sources.get(route?.messageId);
    if (!source) throw qqRefusal('source-not-found');
    if (Object.keys(route).some(key => !['messageId', 'conversationId', 'actorId'].includes(key))
      || ['messageId', 'conversationId', 'actorId'].some(key => source.event.reply[key] !== route[key]))
      throw qqRefusal('stale-route');
    return source;
  }
  qualify(route, signal) {
    const source = this.#source(route, signal);
    if (Date.now() - Date.parse(source.event.at) >= 5 * 60_000) throw qqRefusal('reply-window-expired');
    if (source.attempts >= 5) throw qqRefusal('reply-limit-exceeded');
    return structuredClone(source.event.reply);
  }
  async readImage(route, attachment, options = {}) {
    const source = this.#source(route, options.signal);
    return readQqSourceImage(source, attachment, { ...options,
      assertCurrent: () => {
        if (this.#source(route, options.signal) !== source || this.#sourceImages() !== true)
          throw qqRefusal('source-unavailable');
      } });
  }
  async replyImage(route, file, { signal, beforeSend, verifyAccount } = {}) {
    const qualified = this.qualify(route, signal);
    if (typeof beforeSend !== 'function' || typeof verifyAccount !== 'function') throw qqRefusal('bad-request');
    const bytes = checkedQqImageFile(file);
    if (beforeSend() !== true) throw qqRefusal('stale-route');
    if (signal?.aborted) throw qqRefusal('cancelled');
    const target = { scope: 'group', targetId: qualified.conversationId, msgId: qualified.messageId };
    const fileInfo = await uploadQqCheckedImage(this.#bot, target, file, bytes, signal);
    await verifyAccount();
    this.qualify(qualified, signal);
    let token;
    try { token = await this.#bot.api.getToken(); }
    catch { throw qqRefusal('source-unavailable'); }
    this.qualify(qualified, signal);
    if (beforeSend() !== true) throw qqRefusal('stale-route');
    if (signal?.aborted) throw qqRefusal('cancelled');
    this.#sources.get(qualified.messageId).attempts++;
    let response;
    try {
      response = await this.#bot.apiClient.request(token, 'POST', messagePath('group', qualified.conversationId),
        { msg_type: 7, media: { file_info: fileInfo }, msg_id: qualified.messageId,
          msg_seq: getNextMsgSeq(qualified.messageId) });
    } catch (error) { throw nativeReplyFailure(error); }
    if (signal?.aborted || !identifier(response?.id)) throw qqRefusal('reply-result-unknown');
    this.#observations.sent(qualified.conversationId, response.id, signal);
    return { sent: true, receipt: { version: 1, messageId: response.id, conversationId: qualified.conversationId } };
  }
  async reply(route, text, { signal, receipt = false, beforeSend, mentionUserIds } = {}) {
    const qualified = this.qualify(route, signal);
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || mentionUserIds?.length)
      throw qqRefusal('bad-request');
    // sendText awaits token acquisition internally. Prepare the token first so
    // revocation and expiry are checked immediately before the message POST.
    let token;
    try { token = await this.#bot.api.getToken(); }
    catch { throw qqRefusal('source-unavailable'); }
    if (signal?.aborted) throw qqRefusal('cancelled');
    this.qualify(qualified, signal);
    if (beforeSend !== undefined && beforeSend() !== true) throw qqRefusal('stale-route');
    if (signal?.aborted) throw qqRefusal('cancelled');
    this.#sources.get(qualified.messageId).attempts++;
    let response;
    try {
      response = await this.#bot.apiClient.request(token, 'POST', messagePath('group', qualified.conversationId),
        { msg_type: 0, content: text, msg_id: qualified.messageId, msg_seq: getNextMsgSeq(qualified.messageId) });
    } catch (error) { throw nativeReplyFailure(error); }
    // Once dispatch begins, cancellation or a missing response cannot prove non-delivery.
    if (signal?.aborted || !identifier(response?.id)) throw qqRefusal('reply-result-unknown');
    this.#observations.sent(qualified.conversationId, response.id, signal);
    return { sent: true, ...(receipt ? { receipt: { version: 1, messageId: response.id,
      conversationId: qualified.conversationId } } : { messageId: response.id }) };
  }
}
