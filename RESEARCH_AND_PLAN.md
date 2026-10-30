# Public-product research and original rebuild plan

## Scope and method

I inspected the publicly reachable SyncWithLove pages and browser-visible client metadata. The supplied `/works` URL returned a 404 page, so the research used the public game catalogue and its This-or-That page instead. This review intentionally excludes proprietary source code, private APIs, account data, hidden endpoints, copying assets, or bypassing access controls.

## Observable product pattern

SyncWithLove positions itself as a free, browser-based, no-sign-up relationship play space. Its catalogue includes conversational either/or games, Would You Rather, Truth or Dare, Most Likely To, Never Have I Ever, a wheel, charades, quizzes and non-game tools. The game catalogue makes a clear distinction between one-device and two-device use.

The inspected This-or-That flow exposes: topic/deck selection, a display name and avatar, a shared-screen choice, and a private two-device room created through a link. Its copy says that room answers are private until reveal and rooms expire automatically. The public page describes a short round of twenty choices and emphasizes discussion over competition. It does not present a score as a core rule; compatibility is framed as conversation and comparison.

The visual design is warm, editorial and mobile-first: very light pink/near-white canvas, lavender accents, rounded cards, heart/emoji imagery, compact metadata chips, a prominent headline, and large tap targets. It uses a large catalogue/SEO landing-page pattern around a smaller interactive game surface.

## Publicly observable technology clues

The inspected page includes CSRF markup, fingerprinted bundled JavaScript at `/build/assets/`, Pusher and SockJS DNS-prefetches, analytics and ad scripts, and alternate language URLs. Those clues are consistent with a server-rendered application plus client bundles and managed real-time messaging. They are not proof of the server language, framework, database, deployment platform, or private architecture.

## Rebuild decisions

HeartSync is original in naming, writing, decks, interface, styling and implementation. It keeps the useful interaction model rather than duplicating any protected expression.

1. Use a small Express + Socket.IO server because a two-person game needs authoritative room state and low-latency events, while the scope does not need accounts or a database.
2. Use browser-native HTML/CSS/JavaScript for a fast, low-dependency responsive client.
3. Keep answers on the server until both players submit. The server sends one reveal event to both clients, preventing early client-side exposure in normal play.
4. Define the score as `matching rounds / completed rounds`. Differences are intentionally shown as worthwhile conversation prompts, not failures.
5. Keep rooms short-lived in memory for privacy and demo simplicity. A production version should use Redis TTL plus rate limiting and an allowlisted CORS origin.

## Acceptance checks completed

- Valid room code, safe name cleanup, public room projection and unique code tests pass.
- End-to-end Socket.IO create, join, hidden first submission, shared reveal, and synchronized next-round test passes.
- Server and client JavaScript syntax checks pass.
