# RageFridge — UX, Balance, and Art Guide

**Version:** 0.1 — initial prototype tuning, not validated balance  
**Audience:** UI/UX, gameplay, economy, visual development, animation, and audio  
**Companions:** [Game pitch](01-GAME-PITCH.md) · [Lightweight GDD](02-LIGHTWEIGHT-GDD.md)

## Part A: UI/UX Flow

### A1. Entry-to-Settlement Flow

**Team1 UniHack network:** Avalanche Fuji C-Chain, `chainId: 43113`; test credits only. The connected game wallet is a dedicated ERC-4337 Smart Account, not an upgraded/delegated external EOA. No EIP-7702 path is permitted.

```text
[Launch]
   |
   +--> [Guest local practice: no chain or deposit required]
   |
   +--> [Social / passkey embedded signer enrollment or login]
              |
       [Derive dedicated counterfactual Smart Account]
       [Pin Fuji 43113 + EntryPoint v0.7 + factory/modules]
       [NO EIP-7702 / NO primary-EOA delegation signatures]
              |
       [Eligibility + consent + mic/text + practice]
              |
       [Create / Join four-seat room]
              |
       [Pool preview: test stake S, loss, oracle trust,
        rules, deadlines, Smart Account recipient, host NFT]
              |
       [Fund Smart Account with test ERC-20 credits]
              |
       [Fresh 30-minute session policy preview]
       [Escrow only; joinAndDeposit / setReady / claimPayout;
        one match; cumulative stake <= S; AVAX value = 0]
              |
       [ONE embedded-owner approval per-match setup]
       [Atomic executeBatch UserOperation:
        install policy -> ERC20.approve(escrow,S)
        -> joinAndDeposit -> setReady]
       [Owner authorizes token call, NEVER the session key]
              |
       [Fuji bundler + Verifying Paymaster: 100% AVAX gas]
              |
       +--> [Failure: full rollback; retry, no AVAX fallback]
       |
       +--> [Receipt confirmed; four deposits + four ready]
                       |
                  [Lock pool]
                       |
                [Private role card: 10 s]
                       |
       [300 s HUD: thermometer / BP / chat-mic controls]
       [WebSockets: 1 s physics + AI scoring OFF-CHAIN]
             /                            \
     [Normal -> Sudden Death]       [Safety / technical stop]
             |                            |
       [Terminal result]             [Void / refund path]
             |                            |
             +--------------+-------------+
                            |
       [Single normal end-of-match EIP-712 payload
        + 2-of-3 ECDSA signatures + event-log Merkle root]
                            |
       [Role reveal + pending result / inspection window]
                            |
       [Finalization or permissionless timeout]
                            |
       [Sponsored claimPayout: prize OR original refund]
       [Session if valid; embedded owner after expiry]
                            |
       [Optional quote consent; payouts never gated]
                            |
       [Optional mintSouvenir: separate embedded-owner
        approval + sponsored UserOperation, or skip]
                            |
       [Rematch: new policy + fresh per-match approval]
```

Meme approval is available while settlement is pending; the vertical diagram shows screen progression, not a dependency that delays withdrawals. Provide a persistent claim link in match history even if the player leaves results. Never require NFT minting, public sharing, or a rematch to claim.

### A2. Screen-Level Interaction Requirements

| Screen | Primary action | Required information | Failure behavior |
|---|---|---|---|
| Welcome | Play free | Five-minute premise, guest option, content tone | Unsupported browser gets readable requirements, not a wallet prompt |
| Embedded wallet | Social/passkey login | Dedicated counterfactual Smart Account address; Fuji 43113; pinned EntryPoint v0.7; approved factory/account implementation; no primary-EOA delegation | Decline returns to guest practice; reject wrong chain, unexpected account code, EIP-7702 prompts, and automatic migration paths |
| Consent / calibration | Ready | Banter scope, privacy retention, mic permission optional, BP fiction disclaimer | Permission denial opens text/canned actions |
| Pool / session | Approve one atomic entry UserOperation | Test ERC-20 S, possible full stake loss, zero player AVAX gas, roster/rules/deadlines, Smart Account payout recipient, host NFT owner; 30-minute escrow-only session with three selectors and aggregate cap S | Atomic policy install + exact approval + deposit + ready rolls back on any failure; show UserOperation hash then transaction receipt; no duplicate deposits or paid-gas fallback |
| Sponsorship | Automatic validation, no extra player gas payment | Fuji bundler and Verifying Paymaster sponsor 100% AVAX gas for approved deployment/entry, ready, claims, and optional owner-approved mint | Exhausted sponsor or unavailable bundler pauses entry; retain retryable claims and operator-funded liveness |
| Role card | Reveal / hide | Role objective and one-sentence payout condition | Private by default on shared-screen demo; never send other roles to client |
| Kitchen | Submit action | Temperature, own BP, target, action costs, global cooldown, Rest/Deflect timers | Ungraded response explains why without repeating harmful content |
| Results | Sponsored `claimPayout` | Outcome, revealed roles, weights, amounts, 2-of-3 EIP-712 result/Merkle root, inspection/finalization state; same function claims refunds | Distinguish estimate, finalized entitlement, and confirmed transfer; expired/lost session uses embedded-owner authorization, never a delegation upgrade |
| Meme | Approve exact quote / decline | Speaker and target consent, edit preview, permanence warning | No response means text withheld; payout unaffected |
| History | Open claim / rematch | Pending and final matches | Reconnect restores existing room, not a new funding request |

**Wallet security — pure ERC-4337 only:** Never ask for a seed phrase, primary external-wallet delegation signature, EIP-7702 authorization list, or `eip7702Auth`. Disable SDK delegated-EOA upgrades and automatic 7702 fallbacks. This post-October 2026 security boundary addresses the user-specified delegation-drain pattern; it does not assert an independently verified incident or eliminate ordinary signer/module compromise. Safe 4337 / Kernel v3 and Privy / Web3Auth are candidate integrations; pin one tested, compatible Fuji EntryPoint v0.7 stack before claiming support.

**One approval, strict privilege separation:** Explain the exact test-token approval, deposit, and readiness as separate decoded calls inside one owner-signed atomic `executeBatch` UserOperation. Include session-policy installation in the same atomic setup if supported by the selected stack; otherwise select a compatible stack. Do not split the normal per-match flow into separate approval/deposit signatures. The escrow-only session key cannot sign ERC-20 approvals or account administration. Its on-chain validator allows only `joinAndDeposit`, `setReady`, and `claimPayout` for one fixed match and escrow, expires 30 minutes after issue, caps cumulative token spend to S including the owner setup deposit, and requires native AVAX value zero. The owner setup consumes S; the session cannot deposit S again. Inspect nested calldata and reject arbitrary execution or recipient substitution.

**Gasless does not mean unrestricted:** The Verifying Paymaster sponsors 100% of AVAX gas for approved entry/ready/claim operations and separately owner-approved `mintSouvenir`. Bind sponsorship to the Fuji domain, sender, nonce, decoded call policy, validity, and gas limits. Show “Sponsored — you pay 0 AVAX,” not a gas payment request. Optional minting is outside session scope and needs separate explicit embedded-owner consent. No unlimited approval, hidden payout deduction, auto-redeposit, opaque signature, or countdown-pressure signing.

**Expiry and failure UX:** Display session expiry and revoke status. Keep session secrets out of logs, analytics, and persistent browser storage; lost or expired keys recover through embedded-owner authorization. Sponsored claims remain available after expiry without granting a new broad session. Sponsorship failure shows retry/support, never a silent paid-gas or EIP-7702 fallback. Link only to deployment-configured Fuji explorer records; distinguish bundler acceptance from a confirmed chain receipt.

**UX/security acceptance checklist:** Test the entire first-use, zero-AVAX entry batch; complete rollback on each failing call; wrong network; 7702 prompt rejection; session expiry/revocation/loss; cross-match and aggregate-S bypass attempts; blocked session mint/approval; paymaster exhaustion; bundler retry without double deposit; sponsored owner claims after expiry; refund through `claimPayout`; and optional mint refusal without payout impact. Keep physics and AI scoring on WebSockets with no per-second signing or on-chain transactions. See GDD §8 and §10 for contract enforcement and settlement tests.

### A3. In-Match HUD Layout

```text
+--------------------------------------------------------------------+
| RAGEFRIDGE     02:14 LEFT      Shared thermometer: -08 C   HOLD 0/10s |
| [Caption toggle] [Audio settings] [Safety stop] [Connection: good]    |
+--------------------+-------------------------+---------------------+
| PLAYER A           |                         | PLAYER B            |
| face + BP band     |    CENTRAL FRIDGE       | face + BP band      |
| target selector    | Wagyu window + frost    | target selector     |
|                    | Temperature and state   |                     |
+--------------------+-------------------------+---------------------+
| PLAYER C           | Event captions          | YOU                 |
| face + BP band     | A -> B: Sizzle [-4 C]    | BP 42/100 [gauge]    |
| target selector    | No permanent quote feed | Role: hold to peek  |
+--------------------+-------------------------+---------------------+
| Target: B | [Roast] [Compliment] [Rest] [Deflect] | Ready in 3 s      |
| [Text: max 180 chars] [Send] [Push-to-roast] [Mic mute]              |
| [Canned tier I / II / III]    Preview: -4 C, +7 BP self, +4 BP target |
+--------------------------------------------------------------------+
```

The sketch shows a desktop composition, not four public exact BP readouts. Others show BP bands and character tells; own BP is exact. Live public roles are hidden. Display raw temperature as °C and BP as points/100, never mmHg. Distinguish microphone mute from push-to-roast recording and from local incoming-player mute.

**Hierarchy:** Shared temperature first, personal BP second, target/action cost third, wallet balance absent during active play. Keep token valuation and transaction prompts out of the emotional peak. Exact temperature and own BP must remain readable when VFX fill the kitchen.

### A4. Feedback and Accessibility

- Every action previews its maximum tier costs; experimental grading can select a lower accepted tier. Display the final accepted tier and actual attenuation after resolution.
- Use labeled icons as well as color: snowflake for cold, flame for overheat risk, kettle for BP, shield for Deflect.
- Keyboard defaults: Tab navigates; Enter submits text; keys 1/2/3 choose authored Roast tiers when the text field is unfocused; R starts Rest, F Deflect, M toggles mic. All shortcuts remappable; never capture action keys during typing.
- Support push-to-talk and toggle recording, captions, individual volume, reduced motion, no-flash mode, and independent music/SFX/voice sliders.
- Use visible focus, screen-reader action labels, 44×44 px minimum targets, scalable text, and tested WCAG AA text contrast. Do not make waveform shape or pitch a gameplay requirement.
- Announce important threshold crossings, not every per-second temperature change, to assistive technology. Provide a manual “read current status” control.
- Narrow layouts stack fridge, player list, then controls; no horizontal scrolling. Mobile may spectate in the prototype; do not promise mobile competitive parity before testing.
- Safety stop is always one interaction away. Rest is a tactical ability, not a substitute for a player's right to leave harmful interaction.

### A5. Results and Consent Design

Results reveal the Saboteur with a comic title-card flip, then show the decisive condition, eliminated seats, payout weights, and a conservation line: **Deposits = player payouts + disclosed fee**. Refund results show original deposits, not “winnings.”

For meme selection, show the sanitized exact quote, fictional target avatar, and “This may be copied even if we remove it later.” Speaker and target approve independently; either may decline privately. Do not display who vetoed a quote. Default to no public voice clip and no wallet-address attribution. Quote editing restarts both approvals. Mint and share buttons are secondary and never preselected.

## Part B: Core Metrics and Balance Sheet

### B1. Shared Constants — Five-Minute Match

These values are the numeric source of truth for v0.1. The GDD defines ordering and edge cases. Lock a versioned configuration at funding; never hot-patch active financial matches.

| Parameter | Initial value | Unit / interpretation | Tuning intent |
|---|---:|---|---|
| Seats | 4 | 2 Chef / 1 Saboteur / 1 Stoic | Fixed roster for prototype |
| Active duration | 300 | seconds | Includes Sudden Death |
| Sudden Death start | 270 | elapsed seconds | Last 30 seconds |
| Physics tick | 1 | second | Server-authoritative |
| Starting fridge temperature | 20 | °C | Legible warm start |
| Temperature floor | −30 | °C | Prevent unlimited cold banking |
| Cold threshold | −10 | °C | Must include final ten ticks |
| Required final cold hold | 10 | consecutive end-of-tick seconds | Earlier cold periods do not count |
| Overheat threshold | 100 | °C | Immediate terminal check after full tick |
| Normal ambient heat | +0.20 | °C/s | +54°C across 270 s |
| Sudden Death ambient heat | +0.40 | °C/s | +12°C across 30 s |
| Event temperature cap | ±6 | °C net per tick | Excludes ambient heat |
| Scored-action cooldown | 6 | seconds per speaker | Shared across Roast / Compliment and input modes |
| Same-pair repeat window | <12 | seconds since prior accepted pair Roast | Exactly 12 seconds is unattenuated |
| Same-pair attenuation | 0.5 | cooling and target BP multiplier | Speaker cost unchanged |
| Target protection | 2 | effective incoming Roasts per rolling 10 s | Window is (now−10 s, now]; older boundary expires |
| Duplicate window | 30 | seconds per speaker | Exact/near-duplicate detector version locked |
| Text length | 180 | characters per scored submission | Limit request and caption size |
| Voice capture | 2 | seconds per push-to-roast | Then decision budget begins |
| Decision budget | 2 | seconds from submitted text / finished capture | Late response discarded |
| Last new scored submission | 298 | elapsed seconds, exclusive | At 298 s or later, reject new requests |
| Disconnect grace | 15 | seconds | Inert seat; eliminated if grace exceeded |

### B2. Roast and Support Actions

| Action / accepted tier | Fridge delta | Speaker BP | Target BP | Notes |
|---|---:|---:|---:|---|
| Tier I — Jab | −2°C | +4 | +2 | Deterministic canned baseline |
| Tier II — Sizzle | −4°C | +7 | +4 | Efficient cooling, meaningful self-cost |
| Tier III — Freezer Burn | −6°C | +11 | +6 | High burst, highest self-risk |
| Compliment | +2°C | +1 | −3 | Cannot target self; safety gate still required |
| Rest / Sip Water | 0°C | −3/s for 4 s | — | Cannot submit Roast / Compliment while Resting |
| Deflect | 0°C | 0 | Next incoming Roast ×0.5 | Three-second window; consumed by first effective incoming Roast |
| Ungraded / rejected submission | 0°C | 0 | 0 | Uses global cooldown |
| Duplicate / target-protected Roast | 0°C | Full tier cost | 0 | No Stoic credit; no additional harmful-content playback |

Rest cooldown: **18 seconds from activation**. Deflect cooldown: **12 seconds from activation**. Deflect does not stack and does not affect speaker BP or fridge cooling. Target BP never goes below zero. Pair attenuation and Deflect can produce fractional points; simulate in hundredths of BP and hundredths of °C, not floating-point values. Costs are cartoon resources, not health claims.

### B3. BP, Composure, and Role Weights

| Parameter | Initial value | Exact rule |
|---|---:|---|
| Starting BP | 10 | Every seat, all roles |
| BP range | 0–100 | Eliminate on reaching 100 at any event update |
| Passive recovery | 0.5 BP/s | Only after ≥3 s without any BP increase |
| Rest recovery | 3 BP/s for 4 ticks | Stacks with eligible passive recovery |
| Chef base weight | 1.00 | Alive at cold victory |
| Chef composure weight | 1.25 | Replaces base when peak BP ≤50 |
| Stoic normal weight | 1.00 or 1.25 | Same composure rule if special objective fails |
| Stoic special weight | 2.00 | Replaces, never multiplies, composure weight |
| Stoic BP limit | Peak BP ≤20 | Entire active match, including own actions |
| Stoic receipt minimum | 6 | Effective accepted incoming Roasts |
| Stoic majority | Strictly >50% | Of all effective targeted Roasts in match |
| Eliminated seat decisive weight | 0 | Original deposit also at risk in a decisive result |
| Saboteur cold-victory weight | 0 | Even if alive |
| Saboteur overheat award | 100% of distributable pool | Only if alive at terminal overheat |

**Implementation weights:** Encode 1.00 / 1.25 / 2.00 as integers 100 / 125 / 200. The special Stoic weight is a relative split advantage, not an unfunded promise of twice their stake.

### B4. Pool, Fees, and Conservation

| Symbol | Meaning | Prototype default |
|---|---|---|
| S | Equal deposit per seat in smallest token units | 10 nonredeemable test credits in UI |
| P | Total deposited pool | 4S = 40 credits |
| f | Fee rate in basis points | 0 bps |
| F | Fee charged on decisive outcome | floor(P × f / 10,000) |
| D | Distributable pool | P − F |
| E | Eligible surviving cold-aligned seats | Derived from final outcome |
| w_i | Eligible seat's integer weight | 100, 125, or 200 |
| W | Sum of eligible weights | Sum over E |

```text
Cold victory:
  preliminary_i = floor(D * w_i / W), for i in E
  preliminary_i = 0, otherwise
  dust = D - sum(preliminary_i)
  Give one smallest token unit to each of the first 'dust' eligible seats
  sorted by ascending precommitted seat index.

Sabotage victory:
  payout_living_saboteur = D
  payout_every_other_seat = 0

No valid winner / technical void / contract timeout:
  refund_i = original_deposit_i = S for all seats
  F = 0

Always:
  sum(payouts) + F = P, or sum(refunds) = P
```

For integer weights and floor allocation, dust is less than the number of eligible seats. No random dust lottery, unallocated treasury residue, hidden gas deduction, or payout claim dependent on later deposits. Operator pays prototype transaction costs; future gas policy must be explicit before funding.

### B5. Worked Payout Examples

For human-readable examples only, assume one displayed credit equals 100 smallest units. Actual token decimals are chosen during implementation.

| Scenario | Eligible weights | Payouts from 40-credit pool | Total |
|---|---|---|---:|
| Cold win, both Chefs composed, Stoic qualifies | Chef A 125; Chef B 125; Stoic 200 | A 11.12; B 11.11; Stoic 17.77; Saboteur 0.00 | 40.00 |
| Cold win, Chef B eliminated, Stoic qualifies | Chef A 125; Stoic 200 | A 15.39; Stoic 24.61; others 0.00 | 40.00 |
| Cold win, Stoic misses bonus, all cold seats composed | 125 / 125 / 125 | First eligible seat 13.34; other two 13.33 each; Saboteur 0.00 | 40.00 |
| Valid overheat, Saboteur alive | Saboteur sole recipient | Saboteur 40.00; others 0.00 | 40.00 |
| Failed final hold / void / timeout | Refund, not weight split | Every seat 10.00, regardless of elimination | 40.00 |

The first row deliberately shows why “2× bonus” is a payout-weight claim, not a guaranteed 20-credit payment. Display “2× share weight” in all transactional UI.

### B6. Thermodynamic and BP Sanity Checks

**Silent room:** `20 + 270×0.20 + 30×0.40 = 86°C`. Silence cannot satisfy cold victory, but silence alone also cannot cause an overheat. This gives the Saboteur a reason to act rather than merely remain quiet.

**Cold requirement:** To end at −10°C, the team needs at least **96°C net cooling** before additional sabotage heat and any floor/cap losses. Maintaining the last ten seconds in Sudden Death adds a timing constraint: cooling only at the very last moment is insufficient.

**Illustrative cooling budget:** Eighteen unattenuated tier-III Roasts provide 108°C cooling. Six Compliments add 12°C heat, leaving exactly 96°C net cooling. This is an energy-budget example, not a guaranteed winning schedule: the final hold, tick cap, target cap, BP, and −30°C floor can invalidate it. Distribute events across time and targets.

**Stoic feasibility:** Six unattenuated tier-I incoming Roasts add 12 BP. From 10 BP, taking them too quickly breaks the ≤20 peak condition; spacing them, using Deflect, and Resting can preserve it. Receiving six when the rest of the room receives six is exactly 50% and fails; receiving seven of thirteen passes. The majority target intentionally conflicts with anti-dogpile limits and should be difficult, not automatic.

**Potential dominant strategies:** Canned tier III may outcompete creative graded input; silence/refund coalitions may avoid losses; all players may collude to manufacture Stoic eligibility; a Saboteur may hide warming behind recovery assistance. Track these explicitly rather than assuming a cooldown eliminates collusion.

### B7. Tuning and Playtest Plan

| Metric | Initial hypothesis / threshold | Intervention if missed |
|---|---|---|
| Cold-team share of decisive wins | 40–60% | Adjust ambient heat by 0.02°C/s increments, one variable per cohort |
| Saboteur share of decisive wins | 40–60% | Evaluate Compliment heat, not role odds, first |
| No-winner rate | <20% excluding technical voids | Check final-hold clarity and refund gaming before simply lowering difficulty |
| BP eliminations | Median 0–1 per match | Inspect Rest usage and burst targeting before reducing all BP costs |
| Stoic bonus activation | 10–25% of cold wins | Review majority/minimum constraints; do not silently raise payout budget |
| Oracle dispute rate | <10% of graded actions | Compare modes/languages; keep authored mode available |
| Inference latency | p95 ≤2 s after capture | Reduce pipeline work or return ungraded; never late-rewrite outcomes |
| Repeat-session choice | ≥60% of first-time invited groups | Test fun without financial stakes; don't buy retention with emissions |

Collect at least 200 varied-group matches before treating win-rate estimates as directional evidence. Report sample sizes, confidence intervals, mode, language, friend-group familiarity, and separate draws/technical voids. Instrument accepted action tier/source, attenuation reason, target distribution, peak BP, recovery use, cold-hold resets, and result—not private voice biographies.

## Part C: Modernized 1940–1958 Cartoon Art Direction

### C1. Visual Thesis and Originality Boundary

**A hand-painted mid-century kitchen being bullied by modern game logic.** Backgrounds use soft gouache edges and imperfect perspective; characters use thick expressive ink and clean silhouettes; the HUD uses precise typography and restrained panels so the joke remains readable under pressure.

Use 1940–1958 theatrical slapstick as a craft reference: anticipation, holds, impossible elasticity, literal visual metaphors, and musical punctuation. Create original silhouettes, personalities, props, title lettering, animation poses, and melodies. Do not reproduce Tom & Jerry characters, studio logos, recognizable compositions, signature footage, or existing music. The reference era is a direction for technique, not an asset license.

### C2. Palette and Material Language

| Token / color | Hex | Application | Constraint |
|---|---|---|---|
| Paper cream | `#F5E6C8` | Title cards, kitchen plaster, readable light surfaces | Never use as white ice highlight everywhere |
| Butter yellow | `#E8BE63` | Cupboards, warm practical lighting | Decorative, not a warning semantic |
| Toasted terracotta | `#B96548` | Tile, wood, warm scene masses | Keep behind characters at lower saturation |
| Dusty teal | `#537E78` | Enamel trims, quiet props | Base fridge identity |
| Ink charcoal | `#211F26` | Character outlines, primary text on cream | Stable darkest anchor |
| Ice cyan | `#72DDEB` | Cooling bursts, thermometer cold region | Always pair with snowflake/temperature text |
| Glacier blue | `#236485` | Deep ice shadows, frozen enamel | Do not use alone for small dark-background text |
| Frost white | `#EAFBFF` | Ice edges and cold highlights | Limit bloom near numeric HUD |
| Rage vermilion | `#D84A3A` | Face flush, BP danger, hot metal | Shape/label duplicates color meaning |
| Boiler maroon | `#7A2739` | Overheat shadow, danger outlines | Distinct from cheerful terracotta |
| Brass gold | `#E9C46A` | Mechanical gauges, optional wallet accent | Not a “buy now” flash |
| HUD midnight | `#151B25` | Opaque HUD plates and result backgrounds | Frost-white text; test final contrast |

**Area hierarchy:** Approximately 65% quiet vintage neutrals, 25% character/prop midtones, and 10% state accents in a normal frame. During a burst, let cyan or vermilion dominate briefly, then restore neutral readability. These are art composition targets, not measured chart ratios.

**Light UI:** Charcoal text on paper cream. **Dark UI:** Frost-white text on HUD midnight. Validate all implemented small text at 4.5:1 contrast and large text at 3:1; the full decorative palette is not automatically an accessible text palette. Temperature and BP use different silhouettes even when both are red.

### C3. Character and Fridge Animation States

| State | Character performance | Fridge performance | Gameplay cue |
|---|---|---|---|
| Idle | Asymmetric blink, elastic knee settle, smug eyebrow | Slow compressor wobble, door-handle breathing | Ready state; low visual noise |
| Simmering | Cheeks inflate, foot taps, collar lifts | Hinges twitch; thermometer glass trembles | BP 50–74 or fridge 40–<70°C, respectively |
| Boiling / Steaming | Ear whistles, red face climbs like a thermometer | Rivets rattle, hot light, lid-shaped top bulge | BP ≥75 or fridge ≥70°C; keep triggers independent |
| Frozen Solid | Brief frost-beard recoil after a big cooling hit; no loss of control | Thick cyan frost, brittle icicles, icy Wagyu window | Fridge ≤−10°C; cold-hold progress stays visible |
| Exploded | Head pops into a kettle lid; soot silhouette, no gore | Door becomes a harmless spring-loaded projectile; scorched reveal | Character at 100 BP; fridge at 100°C |
| Resting | Deliberate sip, shoulders drop, exaggerated patient stare | No automatic fridge change | Four-second recovery commitment |
| Deflecting | Pan shield snaps up, eyes peek over rim | No unique fridge change | Three-second protection window |

Frozen Solid is a fridge state and a short character reaction, **not** an extra stun mechanic. A character may be furious while the fridge is frozen; the contrast is the core joke. Character BP state never follows fridge temperature automatically.

### C4. Motion Timing and Implementation Rules

- Use original 24 fps animation timing, commonly on twos for the painted-cartoon feel; keep HUD and input feedback at native display refresh.
- Small roast response: 100 ms anticipation, 150 ms impact, 250 ms settle. Legendary response: up to 150/200/450 ms. Do not delay the authoritative numeric update until animation finishes.
- Favor strong held poses with one- or two-frame smear drawings during snaps. Avoid constant rubbery interpolation; reserve distortion for emphasis.
- Every exaggerated action returns to a readable silhouette. Keep hands, face, and target direction identifiable at thumbnail size.
- Maximum normal screen shake: 6 px for ≤200 ms. Reduced-motion mode disables camera shake, rapid squash, and smear flashes while preserving state icons.
- No full-screen strobing or rapid red/white flashes. Use a single expanding ink ring for impact instead.
- Physics VFX can overlap socially, but the shared temperature, own BP, target selector, and safety control always render above them.
- Use animation layers: body posture, face/BP, mouth/caption, action prop, reaction FX. Never bake every combination into a separate full-body animation.

### C5. Composition, Backgrounds, and Prop Design

Build one three-quarter kitchen with a large central fridge and four peripheral portrait stations. Paint broad warm value groups first; the fridge window is the clearest central rectangle. Use slightly bowed cabinet lines and imperfect ink registration sparingly, not as blurry UI.

The Wagyu Core is an oversized marbled steak in a jewel-like dish: valuable through staging, not through a real asset-price ticker. Its states are fresh shine, worried bead of juice, scorched cartoon puff, and crystalline preservation. No graphic decay or realistic injury.

Use original character concepts with distinct silhouettes, such as a lanky line cook, a squat pastry fanatic, a triangular apron-wearing critic, and a round dishwasher philosopher. Cosmetics cannot visually imply role, alter gauge visibility, or obscure a target. Secret role identity belongs in the reveal, not in exclusive costume assets.

### C6. Typography and Diegetic UI Rules

| Layer | Direction | Production requirement |
|---|---|---|
| Main title / result cards | Original hand-lettered 1950s-inspired brush script or chunky irregular display forms | Create custom lettering; 1–5 words, never body copy |
| Section labels / role reveal | Condensed display lettering with broad counters | Licensed font or original design; no thin strokes |
| HUD / chat / wallet | Clean sans-serif, e.g. appropriately licensed Inter or Atkinson Hyperlegible | Tabular numerals; localizable; minimum 16 px body at desktop reference scale |
| Temperature / timer | Strong tabular digits | Always include sign and unit; no jitter on changing width |
| Captions | High-contrast sans-serif on opaque plate | Speaker label + target; two lines maximum, expandable accessible log |

**Diegetic:** Temperature lives on the fridge's tall thermometer, own BP resembles a pressure dial, cooldowns resemble kitchen timers. **Non-diegetic where clarity demands:** Wallet permissions, transaction details, safety controls, exact numbers, and legal disclosure use conventional clean panels.

Never rotate crucial numeric text, put wallet addresses in brush script, or require a shaking needle to convey a threshold. Keep the needle expressive but duplicate its value numerically. The role card is private and hold-to-peek; no public halo effect uniquely identifies the Saboteur.

### C7. Sound Design and Foley

| Event | Sound direction | Mix / gameplay requirement |
|---|---|---|
| Lobby | Light pizzicato, brushed percussion, distant enamel clink | Social voice remains dominant |
| Tier I Roast | Woodblock tap + small ice tick | Short, dry, not a punishment buzzer |
| Tier II Roast | Muted brass jab + two brittle ice cracks | Distinct cadence from tier I |
| Tier III Roast | Original orchestral slapstick hit + freezing glass bloom | Peak-limited; no loudness advantage |
| Compliment | Suspiciously sweet harp/glissando + warm-air sigh | Same cue for all roles; not an identity reveal |
| BP 75+ | Soft kettle pulse and collar squeak | Player-local warning, captions available |
| Rest | Ceramic cup clink + long soft exhale | Calm, audible confirmation, not medical feedback |
| Deflect | Frying-pan ping with short spring wobble | Must identify successful consumption, not just activation |
| Cold hold | Gentle glass harmonics, ten-step restrained tick | Builds tension without drowning voice |
| Sudden Death | Faster ostinato and ticking stove timer | Layer change, not master-volume jump |
| Elimination | Kettle whistle slide + cork pop | Comic and non-gory; brief voice duck only |
| Fridge explosion | Anticipation inhale, padded orchestral crash, utensil rain | No startling sub-bass shock; low-intensity option |
| Settlement | Small cash-register-like clink with role-reveal cadence | Never imply a transfer succeeded before confirmation |

Use newly composed melodies and recorded/licensed Foley. Avoid recognizable cartoon scores or sampled film effects. Normalize incoming voice, limit peaks, and keep SFX ducked beneath conversation. A useful starting mix is dialogue reference at 0 dB relative, music −18 dB, and sustained ambience −24 dB; final mastering must be tested on headphones and low-volume laptop speakers. Per-bus sliders and a limiter are mandatory; pitch telemetry may bend a whistle within a bounded range but may not increase output volume.

### C8. Artist and Developer Deliverables

| Discipline | First-playable handoff | Acceptance check |
|---|---|---|
| Visual development | One kitchen keyframe; warm/cold/overheat lighting variants; silhouette sheet | Fridge and four players readable in grayscale at 320 px thumbnail |
| Character animation | Four silhouettes with layered Idle, Roast, Compliment, Rest, Deflect, hit, critical, eliminated | State transitions preserve target and BP readability |
| Fridge animation | Idle, Simmering, Boiling, Frozen, Exploded; reusable frost/steam overlays | Numeric HUD remains unobscured at every state |
| UI | Entry, consent, pool, private role, kitchen, results, meme approval, claim-history layouts | Keyboard-only golden path and 200% text scale remain usable |
| Audio | Original music stems, tier stingers, state warnings, Foley, low-intensity mix | No essential event depends solely on sound |
| Technical art | Named layers, transparent VFX, atlas/import settings, reduced-motion alternatives | Deterministic gameplay does not wait for animation completion |
| QA | Replay fixtures, role/outcome matrix, accessibility and wallet failure scenarios | Results conserve funds and quote refusal never blocks claims |

Export concept sheets as lossless PNG; keep editable layered masters separately. Supply animation timing in milliseconds plus source frame rate, pivot points at stable character roots, clear collision-free UI safe areas, and documented alpha/color-space settings. Choose runtime sprite/rig formats with engineering after a representative performance test rather than promising a toolchain this document has not validated.

**Handoff priority:** Make the paradox understandable in gray-box free play, then prove the four-seat social loop is fun, then add painted polish and optional custody. Real-value stakes remain gated behind legal, security, oracle-fairness, and collusion review.
