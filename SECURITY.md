# Security Policy

## Reporting a vulnerability

If you discover a security issue in the Skin Picker Rooms server, please report it privately by emailing **valentin3135@gmail.com** instead of opening a public GitHub issue.

Please include:
- A description of the issue and potential impact
- Steps to reproduce (ideally against a local `npm run dev` instance)
- The affected version or commit hash

I aim to acknowledge valid reports within 72 hours and will coordinate disclosure with you before publishing a fix.

## Scope

**In scope:**

- The Rooms server (this repository)
- The [Skin Picker desktop app](https://github.com/Nano315/lol-skin-picker) that consumes it
- Socket.IO event handlers and payload validation, HTTP route handlers, room state isolation, rate limiting, and the invitation delivery path

**Out of scope:**

- Vulnerabilities in third-party dependencies — please report those directly to the respective upstream projects
- Denial-of-service via sheer traffic volume without a structural flaw in the server's design
- Issues requiring a compromised League of Legends client or host machine

## Supported versions

Only the latest deployed version receives security updates.
