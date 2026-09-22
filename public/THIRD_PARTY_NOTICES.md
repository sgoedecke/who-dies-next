# Third-party notices

Who dies next? is an unofficial, noncommercial Dota 2 fan application.
It is not affiliated with or endorsed by Valve Corporation or the projects below.
No blanket license is granted over this repository's third-party material.

## Valve game content

Dota, Dota 2 and associated trademarks, artwork and game content belong to
Valve Corporation and/or their respective owners. The limited image bundle,
replay-derived encounters and qualified map reference are incorporated into
this fan experience; they are not offered as a reusable asset pack.

The [Steam Subscriber Agreement, section 2.D](https://store.steampowered.com/subscriber_agreement/?l=english)
permits incorporating Valve game content into fan art and publishing and
distributing that fan art solely on a noncommercial basis. Other rights remain
reserved under sections 2.F and 2.G. Valve's
[Video Policy](https://store.steampowered.com/video_policy?l=english) expressly
objects to distributing game assets separately. This repository does not grant
permission for standalone asset redistribution, commercial reuse, or uses
outside Valve's applicable terms. Public CDN access and possession of client
files do not independently grant redistribution rights.

The fan-art provision does not expressly name interactive apps or map datasets;
this project uses it for a noncommercial fan experience incorporating only
the required supporting material, not as unconditional clearance of every
possible downstream use. Do not mirror or relicense the content independently.
Attribution alone is not permission.

Image sources, hashes, missing entries and aliases are in
`public/assets/manifest.json`; map build/hash and compatibility provenance are
in `public/maps/dota-6934.json`. Raw client archives and raw replays are not
distributed.

## OpenDota dotaconstants

Metadata derives from [odota/dotaconstants](https://github.com/odota/dotaconstants),
pinned revision `c55d9a75389650fdebc07e34e6f748868adf9405`. Its software and
project metadata are MIT-licensed as below. This notice does not relicense
Valve-authored artwork or game/localization text embedded in upstream data.

MIT License

Copyright (c) 2017 The OpenDota Project

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

## Processing tools

- [Clarity 4.0.1](https://github.com/skadistats/clarity/tree/v4.0.1),
  copyright 2015 Martin Schrodt,
  [BSD three-clause license](https://github.com/skadistats/clarity/blob/v4.0.1/LICENSE).
- [ValveResourceFormat / Source 2 Viewer 20.0](https://github.com/ValveResourceFormat/ValveResourceFormat/tree/20.0),
  copyright 2015 ValveResourceFormat Contributors,
  [MIT license](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/20.0/LICENSE).

These separately obtained tools are not bundled here or on Pages. Their software
licenses do not license Valve input content or grant rights in parsed outputs.
The original worker integrates Clarity through its Maven dependency.
Application dependencies and versions are declared in `package.json` and
`package-lock.json`; upstream dependency licenses continue to apply.

## Browser runtime libraries

React, React DOM and Scheduler: Copyright (c) Meta Platforms, Inc. and affiliates.

Zod: Copyright (c) 2025 Colin McDonnell.

Vite's generated browser preload helper: Copyright (c) 2019-present,
VoidZero Inc. and Vite contributors.

Each of these components is distributed under the following MIT license:

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
