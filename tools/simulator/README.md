# SkinPicker socket simulator

Interactive CLI that spawns one or more fake players talking the real
Socket.IO + REST API of `SkinPicker-Back`. Useful for testing the rooms
flow (synergy computation, group reroll, skin-line application, match-lock,
invitations, kicks…) without needing several running League clients.

```bash
# from SkinPicker-Back/
npm run dev          # start the server (port 4000)
npm run simulator    # in another terminal
```

## Design notes

### 1. Fake players join in lobby — not in champion select

A freshly-spawned client joins the room in **lobby** state — `championId = 0`,
no skin, no `owned-options` uploaded. It counts as 0 toward synergy and
auto-apply, exactly like a real player who is in the LoL pre-game lobby.

| Lifecycle  | championId | options uploaded | Counts toward synergy |
|------------|:----------:|:----------------:|:---------------------:|
| `lobby`    |     0      |        no        |          no           |
| `in-draft` |    > 0     |       yes        |          yes          |

This avoids the previous footgun where every fake player auto-appeared as
ready/in-draft, and the operator could trigger a group reroll while their
own real client was still in lobby.

### 2. Three ways to drive fakes into champion select

A real custom-game champ-select gives you ~30s to pick. Manually piloting 3-4
fakes in that window doesn't fit. The simulator gives you three ways to
drive them, in increasing order of automation:

| | What it does | When to use |
|---|---|---|
| **`[5]` Piloter** | manual, one client at a time, with `[c]` champion picker | precise control, low-traffic testing |
| **`[7]` Auto-draft** | one-shot batch: pick optimal champions for every lobby client | "I know who I'm going to play, draft my fakes around it" |
| **Quick-spawn + auto-follow** (`[3]` + `[8]`) | each fake watches `room-state` and auto-picks the moment another member appears with a champion | "set and forget — I'll pick in my real client and the fakes catch up" |

### 3. The auto-draft algorithm

Goal: pick `N` champions that maximize the room's skin-line synergy potential
(and, by correlation, chroma-color overlap — champions in the same Project
line have the same metallic chromas, etc).

Algorithm: **greedy with anchor expansion**.

1. Anchor set = the target champion's skin lines (or empty if no target).
2. For each remaining slot:
   - Score each candidate by `|lines(c) ∩ anchor| × 1000 + |lines(c)| + ε`
     (jitter for variety; total-lines breaks ties).
   - Pick the highest-scorer, exclude it from the pool.
   - Expand `anchor ← anchor ∪ lines(picked)` so subsequent picks converge
     on the same skin-line cluster.

The data is built from CDragon's `skins.json` (one HTTP call, cached),
mapping each champion to the set of themed skin lines it has at least one
skin in. The "Base" line (id=1) is filtered out because every champion
is in it.

Example with target = Yasuo (157), 4 picks:

```
Vayne   shared=5 total=17
Akali   shared=8 total=16
Varus   shared=9 total=15
Caitlyn shared=8 total=16
```

(`shared` grows as the anchor expands — see "anchor expansion" above.)

### 4. Centralized auto-follow sequencing

Auto-follow runs through a single `DraftOrchestrator` in `cli.ts` —
**not** independent per-fake timers. When a fake's room-state listener
detects another member with a champion, it doesn't pick directly; it
calls the orchestrator's `requestPick(self)`. The orchestrator:

1. Queues the request (skipping duplicates if the fake is already in queue).
2. Processes the queue **strictly sequentially**: pick fake A, await
   completion, sleep **1 s**, pick fake B, etc.
3. Re-validates each fake right before firing — if the trigger has gone
   away in the meantime (e.g. a `[9]` reset cleared everyone), it skips
   silently rather than picking from thin air.

The 1 s gap between picks is the important part: it lets the previous
fake's `update-selection` propagate as a fresh `room-state` to all
members. The next fake's cached `latestRoomState` then includes the
previous pick, its exclude-set is up-to-date, and the auto-draft
algorithm picks a **different** champion — instead of every fake
reading the same snapshot and converging on the same Vayne.

This also fixes the `[8]` immediate-toggle case: if you turn auto-follow
ON when someone has *already* picked, the orchestrator queues all
freshly-toggled fakes and sequences them with the same 1 s gap. They
don't fire in parallel and don't pick the same champion.

### 5. No raw IDs to remember

Every choice goes through an interactive picker that lists what is
currently available, with previews where possible:

| Action                            | Picker reads from          | Preview                              |
|-----------------------------------|----------------------------|--------------------------------------|
| Pick / change champion `[c]`      | CDragon fuzzy search       | name + alias + ID                    |
| Auto-draft cible (main menu `[7]`)| CDragon fuzzy search       | name + alias + ID, optional          |
| Reroll color (owner) `[r]`        | `room.synergy.colors`      | true-color terminal swatch + hex     |
| Apply skin line (owner) `[a]`     | `room.synergy.skinLines`   | name + member count + coverage       |
| Suggest color/chroma (guest) `[g]`| client's `owned-options`   | per-skin chroma list with swatches   |
| Kick a member (owner) `[K]`       | `room.members`             | name + champion                      |
| Add a guest                       | known owner room codes     | code + owner name (or type a code)   |

### 6. Versioned events

The simulator declares `clientVersion=3` on its Socket.IO handshake, so
`room-state` payloads include the per-member `lockedSkin` field used by the
match-lock UI. The local lock state is re-synced from each `room-state` to
catch out-of-band changes.

## Top-level menu

```
[1] Ajouter un owner       create a fresh room — new client in lobby
[2] Ajouter un guest       join an existing room by code — in lobby
[3] Quick-spawn N          one-shot: 1 owner + N-1 guests, optional auto-follow
[4] Lister les clients     one-line status per active client (lock 🔒, follow 👁)
[5] Piloter un client      drive a chosen client through the actions below
[7] Auto-draft             pick optimal champions for every lobby client now
[8] Toggle auto-follow     turn auto-follow ON/OFF on every lobby client
[9] Reset draft            send every in-draft client back to lobby (iterate fast)
[6] Quitter
```

### Reset for iterative testing

Once a fake has locked a champion via `[7]` or auto-follow, it stays in draft.
`[9] Reset draft` sends every in-draft client back to lobby — internally an
`update-selection` with `championId=0` per client, which makes the server
clear their options and recompute synergy. The clients themselves stay
connected, no respawning needed.

If at least one other member is still in champion select (typically your
real LCU client, when testing against the live app), every fake with
auto-follow ON will re-fire its watcher as soon as its lifecycle flips back
to lobby — so the cycle **reset → re-pick optimal champions** is fully
automatic. Otherwise just press `[7]` again to launch a fresh batch.

## Pilot menu (per client)

```
Common:
  [s]  Show room state (members, synergies, active synergy)
  [c]  Pick / change champion manually (fuzzy search)
  [A]  Auto-pick maintenant (single-client, synergy-optimized)
  [F]  Toggle auto-follow (react when another member picks)
  [u]  Leave champion select (in-draft → lobby)
  [k]  Toggle match-lock 🔒

Owner only:
  [a]  Apply a skin-line synergy (interactive picker)
  [r]  Reroll a color (interactive picker)
  [i]  Invite a player by PUUID
  [K]  Kick a member (interactive picker)

Guest only:
  [g]  Suggest a color/chroma from your owned options (in-draft only)

Exit:
  [L]  Leave the room (graceful — server-side leave-room then disconnect)
  [x]  Brutal disconnect (no leave-room emit)
  [q]  Back to main menu
```

## Typical sessions

### Set-and-forget (recommended for live custom games)

```
[3]   Quick-spawn 4 players, auto-follow ON       → 1 owner + 3 guests, all watching
                                                    "👁" appears next to each
[ go play your custom game; pick Yasuo in your real LCU client ]

The 3 fakes detect the pick within 1.5s, each picks a different champion
sharing skin lines with Yasuo (Vayne, Akali, Varus...), each fake's
owned-options upload finishes, the server's auto-apply fires with the best
common skin line. You see the synergy display populate in your app.
```

### One-shot batch (when you've already started the draft)

```
[3]   Quick-spawn 4 players, auto-follow OFF     → 4 fakes in lobby
[7]   Auto-draft → Yasuo (157)                   → confirms "Bot1 → Vayne (5 lignées)..."
                                                    → "Y" confirms, all 3 fakes enter draft in parallel
```

### Manual / debugging

```
[1]   Ajouter un owner SimUser                   → owner in lobby
[2]   Ajouter un guest, code AB12CD34            → guest in lobby (manual code entry)
[5]   Pilot SimUser → [c] Yasuo                  → owner in draft
[5]   Pilot the guest → [A] Auto-pick            → "Cible (Enter pour inférer)" → Enter
                                                    → guest picks an optimal champion
[5]   Pilot SimUser → [r] Reroll                 → picks from real synergies w/ color preview
[5]   Pilot SimUser → [a] Apply skin line        → picks from real skin-line synergies
[5]   Pilot SimUser → [k] Toggle match-lock      → next reroll keeps your skin frozen
[5]   Pilot SimUser → [K] Kick the guest         → confirm, target gets room-closed=kicked
```

## Files

```
src/
├── cli.ts             entry point — menus, prompt handling, DraftOrchestrator
├── pickers.ts         interactive pickers (champion, synergy, skin/chroma, member, room code)
├── fake-client.ts     FakeClient class — sockets, lifecycle, room-state, autoPickRequester hook
├── auto-draft.ts      greedy skin-line-overlap optimization (used by [7], [A], auto-follow)
├── options-builder.ts builds owned-options from CDragon (per-skin chroma colors)
├── cdragon.service.ts CDragon API calls + fuzzy champion search + skin-line index
└── types.ts           mirror of backend types + simulator-only types (ClientLifecycle, RoomStatePayload)
```
