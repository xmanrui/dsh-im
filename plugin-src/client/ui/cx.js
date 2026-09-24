/** 拼接 class 名，跳过 falsy 项。与 dsh-tauri/client 的 `compact` 同义，本插件自带一份。 */
export function cx(...values) {
  const out = [];
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) out.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item.length > 0) out.push(item);
    }
  }
  return out.join(' ');
}
