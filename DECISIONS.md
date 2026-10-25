# Implementation decisions

- The repository was empty except for the specification, so the app is scaffolded as two npm workspaces: React/Vite/TypeScript and Express/TypeScript/Mongoose.
- Gemini generation is server-side and accepts a configured model. Image generation is not part of this MVP; image/video media is never represented as generated when it is unavailable. CCTV evidence uses explicitly simulated event logs.
- Cases are stored with a seven-day configurable TTL, and the public DTO is constructed explicitly so the hidden solution is not returned before accusation.
- MongoDB is loaded dynamically only after the optional `DNS_SERVERS` setting is applied to Node's c-ares resolver. This works around Windows setups where OS DNS tools resolve Atlas SRV records but Node's default resolver does not.
- Authentication and unrelated product features are omitted as specified.
