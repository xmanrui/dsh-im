# Third-party notices

The Weixin iLink request format, QR-login states, and message fields are adapted from Tencent's [`openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) project at commit `cef0bfc390393f716903e16d50408118047f87e0` (package version 2.4.6), licensed under the MIT License and copyright Tencent.

The DingTalk device-authorization request sequence and AI Card streaming protocol are adapted from DingTalk Real Team's [`dingtalk-openclaw-connector`](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector) project at commit `b2fd6e5ea2ff99bd213faac637d3da541b2bfaf4`, licensed under the MIT License and copyright 2026 DingTalk Real Team.

The WeCom QR-authorization request sequence is adapted from the official [`@wecom/wecom-openclaw-cli`](https://www.npmjs.com/package/@wecom/wecom-openclaw-cli) 1.1.0 package, whose npm metadata declares the ISC License. No CLI source or OpenClaw runtime is bundled in this package.

The Host bundle includes [`@larksuiteoapi/node-sdk`](https://github.com/larksuite/node-sdk) 1.73.0, [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) 7.0.0-rc14, [`https-proxy-agent`](https://github.com/TooTallNate/proxy-agents) 5.0.1, and their [`protobufjs`](https://github.com/protobufjs/protobuf.js) 7.6.5 runtime. The Lark SDK, Baileys, and https-proxy-agent are licensed under the MIT License. protobufjs is licensed under the BSD 3-Clause License; both license texts are reproduced below.

This package depends at runtime on [`dingtalk-stream`](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs) 2.1.4, [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk) 1.0.7, [`@tencent-connect/qqbot-nodejs`](https://github.com/tencent-connect/qqbot) 1.0.4, [`qrcode`](https://github.com/soldair/node-qrcode) 1.5.4, and [`undici`](https://github.com/nodejs/undici) 7.29.0. These packages are licensed under the MIT License; `dingtalk-stream` is copyright 2023 钉钉开放平台团队, and Undici is copyright Matteo Collina and Undici contributors.

The experimental Matrix channel loads [`@matrix-org/olm`](https://www.npmjs.com/package/@matrix-org/olm) 3.2.15 as an external runtime dependency, including its WebAssembly binary. Its package manifest declares the Apache-2.0 License. The dependency is installed separately; no libolm source or WebAssembly binary is copied into the Host bundle.

QQ QR binding uses Tencent Connect's official [`@tencent-connect/qqbot-connector`](https://www.npmjs.com/package/@tencent-connect/qqbot-connector) 1.2.0 package as an external runtime dependency. Its npm metadata declares `UNLICENSED`; no connector source is copied into this project.

The WhatsApp channel uses Baileys to implement WhatsApp Web linked-device QR login and messaging. This is an unofficial WhatsApp Web integration; users should use a dedicated bot number and understand that WhatsApp protocol changes can require connector updates.

This project is an independent DeepSeek Harness integration. It does not bundle OpenClaw and is not endorsed by Tencent, WeCom, Feishu, DingTalk, QQ, Telegram, Discord, Meta, or WhatsApp.

The WeChat, QQ, Telegram, Discord, and WhatsApp marks use path data published by Simple Icons under the CC0 1.0 Universal license. The Feishu, DingTalk, and WeCom marks are inline vectors used for channel identification. Product names and logos remain trademarks of their respective owners.

The Host bundle also includes [semver](https://www.npmjs.com/package/semver) 7.8.5 for npm release comparison, licensed under the ISC License reproduced below.

## semver license

The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## Undici license

MIT License

Copyright (c) Matteo Collina and Undici contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Lark Node SDK license

MIT License

Copyright (c) 2022 Lark Technologies Pte. Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice, shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## protobufjs license

This license applies to all parts of protobuf.js except those files either explicitly including or referencing a different license or located in a directory containing a different LICENSE file.

Copyright (c) 2016, Daniel Wirtz  All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

- Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
- Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
- Neither the name of its author, nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE, ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Code generated by the command line utilities is owned by the owner of the input file used when generating it. This code is not standalone and requires a support library to be linked with it. This support library is itself covered by the above license.
