# RageFridge — Game Pitch

> **Keep the beef cold. Keep your cool.**

**Working title:** RageFridge  
**Format:** Four-player, real-time social-deduction party game  
**Match length:** Five minutes of active play; approximately seven minutes including onboarding and results  
**Platform target:** Desktop browser first, headphones recommended; keyboard-only play supported  
**Document status:** Prototype design v0.1. Numerical rules are specified in [the balance guide](03-UX-BALANCE-ART-GUIDE.md); implementation behavior is specified in [the GDD](02-LIGHTWEIGHT-GDD.md).

## 1. Hook and Elevator Pitch

Four friends lock a cartoon Wagyu Core inside a smart refrigerator. The refrigerator does not run on electricity: it runs on arguments. Every theatrical roast chills the meat, but delivering it raises the speaker's cartoon Blood Pressure meter. Get too worked up and your head launches off like a kettle lid. Meanwhile, one secretly wholesome saboteur is trying to calm everyone down until the fridge explodes.

**RageFridge is Among Us social suspicion compressed into an Overcooked-style pressure cooker: save the shared prize by starting an argument, then win a larger share by refusing to lose your composure.** A Dynamic Fridge NFT remembers the match's visual damage and, with consent, its best roast.

### Emotional subversion

| Familiar expectation | RageFridge inversion | Player decision |
|---|---|---|
| A fridge preserves valuable things | It needs interpersonal heat to make physical cold | Start an argument before the meat spoils |
| Cooperation means being nice | A suspiciously kind teammate may be sabotaging everyone | Decide whether a compliment is cover |
| Loudness demonstrates strength | Escalation can eliminate the speaker | Deliver a sharp line, then step back |
| A collectible is a static image | The fridge becomes a scarred match souvenir | Earn a story, not an advertised investment |

The desired emotion is **performative indignation among consenting players**, not genuine distress. Players roast fictional kitchen behavior, ridiculous avatars, and prompted rivalries—not protected traits, personal trauma, or private information.

### Human proof-of-anger: a creative hook, not a security guarantee

Live timing, contextual callbacks, interruptions, and social deduction make participation more expressive than clicking a farming button. Marketing may describe this as “human proof-of-anger” only alongside a clear explanation: the system scores theatrical interaction, does not measure actual anger, and cannot prove a person is human. Synthetic voices, coordinated players, and generated text remain possible. No emissions or financial rewards are paid simply for producing speech.

## 2. Player Promise and Design Pillars

1. **Readable chaos:** One shared temperature, one personal BP meter, one secret objective. A spectator understands the paradox in ten seconds.
2. **A joke should beat a scream:** Bounded language scoring and authored actions determine power; shouting never unlocks a higher damage tier.
3. **Every seat has agency:** Text, voice, and accessible canned actions use the same action budget. Quiet players still bluff, defend, and redirect.
4. **Trust has a visible boundary:** Fast gameplay is server-authoritative; custody and payout limits are enforced on-chain. An oracle signature is an attestation, not proof that a joke deserved its score.
5. **Collect the story, not a yield promise:** Cosmetics and match memories are the product; financial speculation is not required to enjoy a match.

## 3. Market Positioning

### Audience and entry point

- **Primary:** Existing friend groups and streamers who already enjoy social deduction, improv, and short co-op disasters.
- **Secondary:** Web3 communities seeking a playable social ritual instead of another passive token dashboard.
- **First session:** Guest access, no wallet, no deposit, test credits, immediate rematch.
- **Optional progression:** Wallet-linked collection and cosmetic ownership after the player understands the joke.

| Reference | What to borrow | What not to copy |
|---|---|---|
| Among Us | Secret motives, convincing lies, post-match revelations | Long downtime after elimination |
| Overcooked | Shared crisis, escalating audiovisual urgency | A large movement/control learning burden |
| Lethal Company | Friends creating memorable disasters for an audience | Lengthy setup before the first funny moment |
| Social-Fi | Community identity, portable souvenirs, transparent prize custody | Pay-to-earn loops, recruitment dependence, inflation-funded returns |

These are positioning references, not evidence of market size or predicted commercial performance. Validate demand with free-play cohorts before adding financial stakes.

### Business model

Sell non-statistical fridge shells, character silhouettes, title-card packs, and optional private-room presentation tools. Offer a premium cosmetic pass only if ordinary purchases support content and operating costs. Never sell lower BP gain, stronger roasts, better role odds, or privileged oracle scoring.

An optional future staked mode may charge a clearly disclosed fixed service fee; the prototype fee is zero. Any real-value release requires jurisdiction-specific gambling, contest, consumer-protection, age, sanctions, and privacy review. Token denomination does not remove those obligations.

## 4. Core Loop

1. **Invite and consent:** Four players choose language, voice/text settings, allowed banter intensity, and a free or approved stake mode.
2. **Seal the pool:** Equal deposits are locked; every player sees maximum possible loss before confirming.
3. **Draw secret roles:** Two Chefs, one Pacifist/Saboteur, and one Stoic. The Stoic supports the cold objective but pursues a harder personal bonus.
4. **Work the kitchen:** Exchange approved roasts to lower fridge temperature; use limited cooling-down actions to manage personal BP.
5. **Read the room:** Watch who suspiciously compliments others, who takes attacks without flinching, and who is about to pop.
6. **Survive the last thirty seconds:** Ambient heat accelerates. The cold team needs a qualifying final cold hold; the Saboteur needs a catastrophic overheat.
7. **Reveal and settle:** Roles flip, escrow pays according to the signed outcome, and players may approve a sanitized quote for the match souvenir.
8. **Rematch:** Keep the social group and change the role assignment. No re-staking is automatic.

### Central dilemma

A strong roast cools more but raises the speaker's BP more. Attacks also add a smaller, predictable BP amount to their target. Resting lowers BP but temporarily removes an active contributor. Compliments warm the fridge and relieve a target's BP: they can look helpful while advancing the Saboteur's objective.

## 5. Hidden Roles

| Role | Seats | Primary objective | Distinct play pattern | Reward identity |
|---|---:|---|---|---|
| Chef | 2 | Finish with the fridge at or below −10°C and cold for the final ten seconds | Produce cooling while retaining enough composure to survive | Eligible share of cold-team pool, with a bounded composure weight |
| Pacifist / Saboteur | 1 | Make the fridge reach 100°C while still alive | Compliment, misdirect, persuade others to rest, disguise warming actions | Entire distributable pool on a valid sabotage victory |
| Stoic / Masochist | 1 | Support cold victory and absorb a strict majority of accepted targeted roasts without ever exceeding 20 BP | Invite safe fictional attacks while rationing their own escalation | 2× payout weight, not a guaranteed 2× deposit return |

“Masochist” is internal flavor; **Stoic** is the player-facing name. All roles share the same visible action kit so no exclusive ability gives away identity. There is no vote-to-eject system in the prototype.

### Outcomes players can understand

- **Cold victory:** The surviving Chefs and Stoic split the distributable pool by published weights. Eliminated players and the Saboteur receive nothing.
- **Sabotage victory:** A living Saboteur receives the entire distributable pool when the fridge reaches 100°C.
- **No valid winner:** Return every original deposit, including those of eliminated players. A failed cold hold is not automatically a Saboteur win.
- **Technical void:** Return all deposits; no gameplay service fee. A moderation incident stops scoring and voids the match rather than rewarding harmful content.

These refund rules are deliberate prototype protections, but they permit collusive refund-forcing. Keep the first build on nonredeemable test credits until adversarial playtesting addresses that exploit.

## 6. Viral and Stage-Demo Appeal

### Why it is watchable

The visual gag communicates before the rules do: a smug cartoon cook says something cutting, a cyan frost wave swallows the fridge, and their own ears begin to whistle. The audience can see that a teammate's saintly compliment is physically dangerous. A role reveal recontextualizes every helpful-sounding line.

### Ninety-second stage demonstration

| Time | Beat | Visible proof |
|---|---|---|
| 0–10 s | Explain “arguments make it cold; anger makes you pop” | Temperature and BP move in opposite visual directions |
| 10–30 s | Two presenters trade authored kitchen roasts | Tier labels, frost response, readable BP costs |
| 30–50 s | Hidden Saboteur compliments everyone | Warmth surge and suspicious halo animation |
| 50–70 s | One presenter rests while another risks a big line | Clear agency rather than passive sentiment watching |
| 70–90 s | Scripted accelerated finale, reveal, souvenir preview | A complete story with an obvious payoff |

The stage build uses labeled simulated wallet funds, deterministic authored scoring, and a shortened demo clock. It must not masquerade as a live financial settlement or independently inferred emotion.

### Sharing loop

Generate a local/share-preview results card with role reveal, temperature trajectory summary, and one approved quote. Require speaker and target consent for quotation or voice clips. Default to anonymized avatars. Do not auto-post, reveal wallet addresses, or attach private lobby recordings. Public spectator feeds delay gameplay by ten seconds and never expose secret roles before results.

## 7. Web3 and Dynamic NFT Value Proposition

### What belongs on-chain

- Escrow deposits, locked rules hash, match identifier, bounded settlement authorization, and withdrawal entitlements.
- A canonical record that the match settled, voided, or timed out.
- Optional cosmetic NFT ownership and approved, nonpersonal match traits.

### What stays off-chain

Voice transport, temporary transcripts, sentiment labels, per-second physics, moderation, secret roles during play, and private evidence. A blockchain cannot independently decide whether sarcasm was funny or whether a voice sounded angry.

### Dynamic Fridge souvenir

The prototype creates **one optional room souvenir per match**, claimable by the lobby host after settlement; this ownership rule is displayed before funding and has no effect on payouts. Minting is independently opt-in, costs are disclosed, and skipping it changes no winnings. Each consenting player can receive a non-NFT local result card.

The NFT's artwork changes from enamel fridge to icy vault, scorched wreck, or pressure-dented survivor according to signed match traits. Live temperature is an off-chain preview; final settled traits are the canonical collectible state. No external NFT or high-value collateral is required for the first build.

### Hall of Shame / Meme inscription

Nominate the highest-tier accepted roast, break ties by unique non-speaker votes, then earliest event sequence. Speaker and target must approve the exact sanitized wording after the match. If either declines or does not respond, store a neutral trait such as “Legendary Roast — text withheld.” Keep quote text in removable moderated storage, not permanent on-chain bytes; an on-chain hash is optional only with explicit permanence consent and must not be treated as anonymous data.

### Sustainable economics

The “Wagyu Core” is a fictional match object, not a DeFi strategy. Four equal stakes fund a finite prize pool; optional sponsor rewards must be deposited before entry and disclosed separately. There is no promised APY, automatic lending, native-token emission, or reliance on later players. “Yield” in flavor copy means redistributed match winnings, never investment income.

## 8. Prototype Scope and Success Gates

**Build:** One kitchen, four original characters, three roles, deterministic authored actions, experimental text/voice grading, free-play escrow simulation, one settlement path, one consent-based souvenir preview.

**Defer:** Tradable native token, lending integrations, open matchmaking with cash stakes, user-generated public audio archives, cross-chain custody, community governance, and automatic public inscriptions.

| Question | Initial acceptance target | How to test |
|---|---|---|
| Is the inversion understandable? | 80% of first-time players explain both meters after one practice round | Unaided player interview |
| Is the social loop fun without money? | 60% of invited groups choose an immediate second match | Free-play telemetry; exclude staff/demo sessions |
| Are roles viable? | Cold team and Saboteur each win 40–60% of decisive matches | At least 200 varied-group matches; report draws separately |
| Does the oracle feel fair? | Under 10% of accepted graded actions receive a player dispute | Track by language and input mode, not only aggregate |
| Is the game becoming harmful? | Every report is reviewable; severe allowed-content failures block staked release | Moderated playtests with opt-out interviews |

These are hypotheses and launch gates, not measured results. The game must earn its party-game value before real-value staking is considered.
