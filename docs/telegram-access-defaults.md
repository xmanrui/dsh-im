# Telegram access defaults

Newly connected Telegram bots start with allowlists for both private chats and groups. The configured `allowedUsers` seed both lists and retain command permission. An empty list denies inbound traffic until the owner configures access in the IM settings UI. Opening group access must be an explicit operator choice.

Existing saved access policies are not overwritten by this default. The backwards-compatible startup migration is unchanged. Operators upgrading existing bots should review both private and group access settings; a previously saved open group policy remains open until changed explicitly.

This is a sender admission default, not an OS sandbox. Permitted users still have the capabilities of the selected host/session permission preset.
