export function isQqVoiceAttachment(native) {
  return native?.content_type === 'voice' || /^audio\/[a-z0-9!#$&^_.+-]+$/i.test(native?.content_type ?? '');
}
