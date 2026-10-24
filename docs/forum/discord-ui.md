# Discord forum channel: UI reference

A reference for rebuilding Discord's forum channel view 1:1 in the holt chatbox (`main/src/pages/chat/`). The chatbox already uses Discord's class-name scheme (`discord-class-manifest.json` → `discord-vendored.css`). The extracted rules are in [`discord-forum.css`](./discord-forum.css), and this document explains what they style and how the UI behaves.

## 0. Provenance and method

- **Source:** the public web client at `https://discord.com/app` (stable), `BUILD_NUMBER` **649389**, fetched 2026-10-24. No login and no API calls; only `/app` and `/assets/*`. Everything below comes from static reading of the minified bundle; nothing was executed. I could not see a live DOM because that needs a logged-in session.
- **How the forum code was found** (same approach as `rip-discord-css.mjs`, extended for lazy chunks):
  1. `web.<hash>.js` (the webpack runtime) has the chunk maps `T.u` (JS) and `T.k` (CSS). Each is a ternary of `"<id>"===e?"<id>.<hash>.js"` entries plus a dictionary fallback whose files are named **hash-only** (`<hash>.js` / `<hash>.css`, with no id prefix).
  2. web.js lazily loads `Channel` (`webpackId:595840`, 633 chunks). Its owning chunk 192461 lazily loads **`ForumChannel` (`webpackId:559296`)** from 18 chunks: `229511 599660 452880 726399 500194 207309 430877 302800 249681 666140 333097 704374 777848 689160 623685 842516 421225 822070`.
  3. Each CSS chunk has a JS twin holding the CSS-module class maps (`123(e){e.exports={kL:"container_abc"}}` or `_.r(e.exports={…})`). The code references them as `X.kL`, so mangled keys resolve to real class names exactly. Short keys like `kL` are only unique within one module, so they cannot be guessed across modules. Every class name in this document comes from such a map.
  4. English labels come from the main en-US message bundle (chunk 1868, `26d528cd23025094.js`).
- **Key modules:** `559296` ForumChannel (chunk 822070: header, composer, grid card, sort/tag popouts, empty states); `350527` list card and `52933` tags row (chunk 842516); `192461` channel/thread sidebar (header for an open post).
- **Requests: about 600, not "a handful".** The forum view is a lazy chunk two levels deep. Nothing in the runtime names a CSS chunk, so locating the forum CSS required fetching what a single browser load of one channel fetches: 318 shell stylesheets, 221 + 27 Channel-group chunks, and the 25 forum chunks. Requests were sequential with a browser UA, a 0.25–0.3 s delay, and a single client. The temp directory was deleted afterwards.
- **Hashes are stable across builds.** The suffix (`_f369db`, `__9293f`) is a hash of the source path. Classes already in `discord-class-manifest.json` (e.g. `container__9293f`, `channelTextArea__74017`) are unchanged in this build, so the hashes below should match a canary rip too. Chunk *file* hashes do change every build.

## 1. Structure

Discord's own component names are unknown (the bundle is minified). The names in brackets are the minified identifiers inside module 559296, given so the code can be found again.

### 1.1 Page container and layouts

```
div.container_f369db  [data-member-list-open]                 ← whole forum view (min-width 320px, chat background)
├─ (drag & drop) .uploadArea_f369db                            ← file-drop overlay for the New Post draft
├─ .newPostsButton_f369db  "N New Post(s)"                    ← floating pill, bottom centre; click = re-sort
├─ .optInNotice_f369db                                         ← channel opt-in notice (when applicable)
└─ LIST layout:  ul-like virtual list  .list_f369db  (role=list)
   or GRID layout: masonry list .grid_f369db (role=grid per section)
     section 0  → header card  (§1.2)          one row; spans all columns (.columnsSpan_f369db)
     section 1  → active posts  (§1.5 list card / §1.6 gallery card)
     section 2  → "Older Posts" divider, then archived posts
     section 3  → loading placeholders (.loadingCard_f369db + .loadingCard-{0,1,2}_f369db, opacity .33/1/.66)
```

- **List layout:** each row is `li.card_f369db > [list card].mainCard_f369db`. Row height is the measured card height + 8 (default 104 before measurement). Section 2 has a 40px header when there are active posts. Virtual chunk size is 150 rows, bottom padding 24, and the list scrolls into view with 96px padding.
- **Gallery layout:** a masonry grid with `itemGutter 16` and `padding 24`. Columns are computed with `minWidth 320, maxWidth 450, gap 16`:
  - if width ≤ 320, use 1 column;
  - otherwise `n = max(floor(w/450 + (w/320 − w/450)/2), 1)` and `columnWidth = (w − 16(n−1))/n`.
  - Item height is `60 + ceil((colWidth − 24 − 2) × ratio) + 24 + 36`, where ratio is 2/3 (16:9 for media channels; game-invite channels use a fixed 280).
  - Each item is `li.container__9a337.card_f369db.mainCard_f369db`, absolutely positioned.
- **Archived divider:** `.card_f369db.archivedDividerRow_f369db.columnsSpan_f369db > .emptyMainCard_f369db > h(eyebrow).archivedDivider_f369db` with the text **"Older Posts"**.
- **Permission rows:** `.missingReadHistoryPermission_f369db.columnsSpan_f369db` with "You do not have permission to view the post history of **#channel**." / "…to search the post history of **#channel**."

### 1.2 Header card (section 0) `[sB]`

```
div.card_f369db.headerRow_f369db.columnsSpan_f369db   (role from list navigator; focus → title input)
├─ [new-member banner] .newMemberBanner_f369db (+ .gridViewBanner_f369db in gallery)
├─ div.headerContainer_f369db  (+ .gameInvitesHeaderContainer_f369db for game-invite channels)
│  └─ div.mainCardContainer_f369db
│     ├─ div.mainCard_f369db.header_f369db (+ .headerWithMatchingPosts_f369db when the row below shows)
│     │   └─ COMPOSER  (§1.3)
│     └─ div.matchingPostsRow_f369db   (only while searching, or as the keyboard hint)
│        ├─ div.matchingPosts_f369db:  "Searching..." | "No matching posts" | "{n} post(s) with "{query}""  + "Clear" (.clear_f369db, brand, underline on hover)
│        ├─ div.tagsSpacer_f369db
│        └─ div.startPostHelp_f369db: [SHIFT] + [ENTER] "to create a new post"  (keys = .keyboardShortcut_f369db)
│                                     or ⚠ (.warnIcon_f369db) "You do not have permission to post in this channel."
├─ POST GUIDELINES panel  (§1.4)  ← channel.topic
├─ div.tagsContainer_f369db                         ← sort + tag filter row
│  ├─ button.sortDropdown_f369db > .sortDropdownInner_f369db : [sort icon] <span.sortDropdownText_f369db>"Sort & View"</span> [chevron]
│  ├─ (if channel has tags) div.divider_f369db      ← 2×24 vertical rule
│  ├─ div.tagList_f369db (height 32, overflow hidden) > div.tagListInner_f369db  ← one TAG PILL per available tag (§1.7)
│  ├─ button.tagsButton_f369db(.tagsButtonWithCount_f369db) > .tagsButtonInner_f369db   ← absolutely positioned right after the last VISIBLE pill
│  │     label "All" + chevron, or a brand count bubble .countContainer_f369db>.countText_f369db (number of selected tags)
│  └─ button.tagsButton_f369db.tagsButtonPlaceholder_f369db   ← invisible twin that reserves width
└─ [empty state for the whole channel] (§1.9)
```

- The overflow tags button is positioned in JS: after layout, it takes the right edge of the last pill in the first row and sets `style.left` to it.
- "Sort & View" reads "Sort" for media and game-invite channels.

### 1.3 Composer (inside the header card) `[ig, ij, iv, iC, iy, ik, iT]`

Collapsed (no draft) is the search/title bar. Expanded is the New Post form.

```
div.container_d9be46 (+ .collapsed_d9be46 when not open)  aria-label "Create Post" | "Search"
└─ form
   ├─ div.formContainer_d9be46
   │  ├─ div.prefixElement_d9be46 : magnifier/clear button, or ✎ .pencilIcon_d9be46 when there is a draft
   │  ├─ div.form_d9be46 (or .previewForm_d9be46 in preview)
   │  │   ├─ div.titleContainer_d9be46
   │  │   │   ├─ textarea.title_d9be46 (rows 1, maxLength = thread-name limit)
   │  │   │   │      placeholder: "Search or create a post..." | "Title" (form open / draft) | "Search" (can't post / game invites)
   │  │   │   │      when the form is open and the title is set it renders as heading-md/semibold text
   │  │   │   └─ (collapsed only) right side: [Post Guidelines icon button]  [New Post button]
   │  │   ├─ body: div.bodyContainer_d9be46 > .contentContainer_d9be46 > rich editor
   │  │   │        .channelTextArea_d9be46 / inner .channelTextAreaInner_d9be46 (+ .channelTextAreaInnerError_d9be46)
   │  │   │        placeholder "Enter a message..."; preview uses .channelTextAreaInner_d9be46.previewTextArea_d9be46
   │  │   └─ "Preview Mode" chip .previewModeIndicator_d9be46
   │  └─ attachments strip (§CSS 4) when files are added
   └─ div.form_d9be46 (second row, form open)
      └─ .horizontalPadding_d9be46 controls block:
         ├─ TAG PICKER div.tagsContainer_d9be46 : TagIcon .tagsIcon_d9be46 | .tagList_d9be46>.tagListInner_d9be46 (SMALL pills, aria "Add tag, {tagName}")
         │      | "See more tags" button .tagsButton_d9be46 (+ placeholder twin) → popout with "Enter a tag..." combobox
         ├─ div.tagsDivider_d9be46
         ├─ div.controlsContainer_d9be46 (row-reverse, height 40)
         │   ├─ div.controls_d9be46 > div.wrappedControls_d9be46 [char count .characterCount_d9be46, slowmode] | [Guidelines] | [Preview/Exit Preview] | [Post]
         │   └─ expression picker button .expressionPicker_d9be46
         └─ "A tag is required to create a post in this channel" .requiredError_d9be46 (text-feedback-critical)
```

- **New Post button:** primary, size sm, ChatIcon. It reads "New Post" in the collapsed bar and "Post" once the form is open. It is disabled when the user can't post (`canCreatePost`), when slowmode applies, or in the form when `disableIfInvalid` and the draft isn't valid (needs a body or attachment, a trimmed title, and no missing required tag). A further flag (`J.V(channel)`, not resolved) hides it.
- **Required tags:** when the channel has the `REQUIRE_TAG` flag, no tag is applied, and both title and body exist, the error line shows and submit is blocked. Submit errors: "A title is required", "A message is required". AutoMod errors for title or body are shown under the matching field.
- **Tag limit:** at most **5** tags. Once 5 are selected, unselected pills become `disabled`.
- **Post Guidelines button:** shown only if `channel.topic` is set. It is an icon button (secondary, sm) with the book-check icon and the tooltip "Post Guidelines".

### 1.4 Post Guidelines panel `[nX]`, module 257701

`div.container_ca49a1` (12px padding, base-low card) contains:
- `.headerContainer_ca49a1` with `h(heading-lg/semibold).guidelinesHeader_ca49a1`: [book-check 20px] "Post Guidelines" [✎ `.clickable_ca49a1`, editors only], then an ✕ close button `.clickable_ca49a1`.
- `.descriptionContainer_ca49a1` holding the selectable text `.guidelines_ca49a1` (max-height 220, markdown with headings and lists).
- When it overflows, a `.showMore_ca49a1` block with `.gradient_ca49a1` and `.linkContainer_ca49a1 > .showMoreLink_ca49a1 > .showMoreText_ca49a1`: "View All" plus a chevron (`.showMoreIcon_ca49a1`).

The panel is animated (react-spring opacity/height). While hidden it gets `.hiddenVisually_ca49a1`.

### 1.5 List-layout post card `[ns.Ay = module 350527]`, CSS module 223139 `_faa96b`

```
div.container_faa96b (+ .isOpen_faa96b when this post is open in the thread sidebar)  data-item-id=<threadId>
├─ focus ring target .focusTarget_faa96b   aria-label "Post {title}, {count} message(s)"
├─ div.left_faa96b
│  ├─ div.body_faa96b
│  │  ├─ TAGS ROW (§1.7)   [New badge] [📌 pinned] [≤3 tags] [+N]
│  │  ├─ div.header_faa96b (+ .withNewBadgeOverflow_faa96b) > div.headerText_faa96b
│  │  │    └─ h(heading-lg/semibold, lineClamp 2).postTitleText_faa96b  — colour text-strong if unread, else text-muted
│  │  │         └─ inline "NEW" badge .newBadgeWrapper_faa96b > .newBadge_faa96b   (moves to .newBadgeOverflow_faa96b if title > 60px tall)
│  │  │       search hits inside the title are wrapped in <span class="highlight">
│  │  └─ div.message_faa96b  (one line, 18px)
│  │       [author .author_d3eee8(.hasUnreads_d3eee8) "Name" + ": "]  [preview .messageContent_faa96b (ellipsis)]
│  │       preview: first message rendered inline (text-sm/semibold) | "Original message was deleted" | italic .blockedMessage_faa96b
│  │                "Post contains a blocked message" / "Post contains an ignored message"
│  └─ div.footer_faa96b (height 20, gap 8)
│       [default-reaction button | top reaction pill .updateReactionButton_faa96b]
│       [message count .messageCountBox_faa96b: ChatIcon 14 in .messageCountIcon_faa96b + .messageCountText_faa96b (+ "(N New)" .newMessageCount_faa96b brand)]
│       "•" .bullet_faa96b
│       typing: .typing_faa96b [facepile max 5 @16px] [.dots_faa96b animated] [.typingUsers_faa96b]
│       else: relative time (text-sm/normal), tooltip "Posted {full timestamp}"
└─ media thumbnail .bodyMedia_faa96b (72×72, right side; blur .obscured_faa96b for spoiler/NSFW + .obscuredTag_faa96b icon)
```

- **Reaction/like count.** If the first message has reactions, the footer shows its top reaction as a normal reaction pill with its count, burst-aware. If it has none and the forum has a *default reaction emoji*, the footer shows that emoji as a clickable "add reaction" pill with the count hidden. Both are read-only on archived or locked posts.
- **Activity time.** The text depends on the sort order: last activity for "Recently Active", creation time for "Date Posted".
- **Unread markers.** Unread changes the title colour (strong vs muted) and the author link colour. A "NEW" badge marks posts created since the user's last visit. "(N New)" shows the unread message count. `.hasRead_faa96b` dims the count when nothing is unread.
- **Moderator-report forums** use a different card, `[e4]`, styled by module 948389 `_fc958f`. It has a 40px author avatar and a flag footer. This is out of scope here.

### 1.6 Gallery-layout post card `[su → sm]`, CSS module 475290 `__9a337`

```
li.container__9a337.card_f369db.mainCard_f369db (+ .isOpen__9a337)   style = masonry coords
├─ .focusTarget__9a337 (aria-label as list card)
├─ div.header__9a337
│  ├─ div.authorRow__9a337 > div.rowGroup__9a337 [author name] [creation time text-xs .postCreationTimestamp__9a337]   + NEW badge .newBadge__9a337
│  └─ h(heading-md/extrabold).title__9a337  (single line, ellipsis; text-strong if unread else text-muted; width = card − 24)
├─ div.postBody__9a337
│  ├─ media: .bodyMedia__9a337 (aspect 2/3 of width; 16:9 for media posts)
│  │   up to 4 tiles .bodyMediaFrame__9a337 (img cover .imageCover__9a337 / contain / .mediaPostThumbnail__9a337)
│  │   .mediaIconsRow__9a337 (play icon for video and a second media-type icon, 22–29px) top-left; "+N" pill .moreImagesPill__9a337 bottom-right when > 4
│  │   tags overlaid bottom-left .tagsRow__9a337 (pills get .tagPill__9a337: raised background)
│  └─ or text: .contentPreview__9a337 > .content__9a337 (first message, colour .textContentUnread/.textContentRead)
│        + fade footer .textContentFooter__9a337 (mask gradient) holding the tags row (.noTags__9a337 → 10% height)
└─ div.footer__9a337 > .forumPostControls__9a337
     ├─ .controlsGroup__9a337: message count (.messageCountContainer__9a337, read-state aware) [• typing facepile/dots]
     └─ .controlsGroup__9a337: [default reaction] [top reaction]
```

Game-invite channels use another card (`[sc]`, module 227483 `_a2d698`), which is not covered here.

### 1.7 Tags row and tag pill

- **Tags row** (component `52933`, CSS 240103 `__08166`): `div.tags__08166` (inline-flex, 24px tall, gap 8) contains, in order:
  1. a "NEW" badge (`.newBadge__08166`) when the post is new;
  2. a pinned marker `.pinIcon__08166` (22px brand-500 circle, white pin glyph 16px, tooltip "Pinned") when the thread has the `PINNED` flag;
  3. the first **3** applied tags as SMALL pills, where a tag that is in the active filter gets `.tagFiltered__08166`;
  4. "+N" (more-tags pill with a tooltip listing the rest).
- **Tag pill** (module 715434 `_a2c9e8`): `pill_a2c9e8` (32px; `.small_a2c9e8` gives 24px), with `.clickable_a2c9e8`, `.selected_a2c9e8` (reacted-blurple background, brand border in dark theme), and `.disabled_a2c9e8`. An optional emoji `.emoji_a2c9e8` (14px, 12px when small) sits before the tag name; with no emoji, the TagIcon is used in the picker. The pill React component (`376310`) itself was **not fetched**. This class module is attributed to it because it is the only pill module in the forum chunk set with exactly those props (selected / small / emoji / manaFilterTag).
- **Experiment path:** when the `forum-post-tags` / `forum-channel-header` experiment is on, tags render with the design-system **TagGroup** instead (`tagGroup_cfee8f` / `tag_cfee8f` / `tagLabel_cfee8f` with `data-variant="filter"`, `data-size="sm|xs"`, `data-selection-mode="multiple"`; shell chunk 964940). This match is by props only; its class map was not fetched.

### 1.8 "Select Tags" popout `[sI]`, module 287683 `__5808f`

Opened by the "All" button (bottom, aligned right). `div.container__5808f` (336px, surface-higher, shadow-medium, aria "Filter by tags") contains:
- `.header__5808f > .headerLeft__5808f`: "Select Tags" (heading-md/semibold) + count bubble `.countContainer__5808f > .countText__5808f`;
- `.tagContainer__5808f` with every tag as a pill `.tag__5808f` (selected state reflects the filter);
- `.separator__5808f`;
- a "Clear all" button.

The Sort & View popout wrapper is `div.container_f8b2d2` (180px). The menu inside is Discord's standard menu component, the same one the chatbox's context menus use.

### 1.9 Empty states

- **Channel has no posts** (`[nW]`, module 922396): `div.container__93db4` (base-low card, centred, 16px padding) contains:
  - title `h(heading-md/semibold).header__93db4`: "Be the first to start the conversation!", or with a tag filter "There are no posts with {this tag|these tags} yet!";
  - body (text-sm): "What do you want to post about in #{channelName}?", or with a filter "Be the first to start a conversation with {this tag|these tags}";
  - when allowed, a secondary button "Create a post" (or "See Examples" for the first-post admin flow). Clicking focuses the composer title.
- **Admins only, new forum:** a "Get Started" checklist card (module 986359 `_a68543`; "(n of m Completed)", "Only moderators can see this"). Its steps are "Set recommended permissions", "Create post guidelines", "Create tags", "Set a default reaction for posts", and "Make the first post!". The CSS for this card was not extracted.
- **Game-invite channels** have their own empty state (module 296853 `__0acd6`); its strings are in a secondary message bundle that was not fetched.
- **Inside an open post** with no replies, the message list uses the spacer `.scrollerSpacer__36d07.emptyForum__36d07` (32px). The member list reads "There’s no one in this post."

### 1.10 An open post (thread view)

- **Where it opens.** Clicking a card opens the post, normally in the **thread sidebar** next to the forum. The grid's keyboard select passes a flag that takes a different open path (`N9(..., {source: BROWSER})`). `getCurrentSidebarChannelId(parent) === post.id` drives `.isOpen_*` on that card. The sidebar body is the normal thread chat with a sidebar composer.
- **Sidebar header** (`[iY]` in chunk 192461). It is the standard channel HeaderBar (`container__9293f` …, already in the manifest) with aria-label "Thread header". The title is built by helper `zF({channel, parentChannel, channelName, guild, inSidebar:true})` in module 353428, which was **not fetched**, so the exact breadcrumb markup (forum name › post title) and any tag display in the header are unverified.
  - The title has a click handler (`nt.uh(guildId, threadId)`, target not resolved) and a context-menu handler (the thread context menu).
  - The toolbar (`[iF]`) has, for forum posts, **no notification bell** (that button is skipped when `isForumPost()`).
  - The toolbar's "More" (⋯) menu `thread-context` contains: "Open in Full View", "Search", "Pins", "Copy Thread ID", and other thread actions from hooks that were not resolved.
  - The ✕ "Close" button closes the sidebar.
- **Starter message area.** CSS module 950490 `__31080`:
  - `.nonMessageContent__31080` (column, gap 16, margin 16) contains `.tagsRow__31080` (wrap, gap 8) and the `.forumPostActionBar__31080`;
  - dividers `.dividerThin__31080` (1px, full-bleed) and `.dividerThick__31080` (6px);
  - in a sticky layout, `.stickyMessage__31080` (max-height 50%).
  - The list-item type `FORUM_POST_ACTION_BAR` exists in web.js. The action bar's JSX, which holds the Follow/Following button ("Follow" / "Following" strings exist in the bundle), reactions and share, lives in a Channel code chunk I did **not** fetch.
  - Discord also has an "Open in Full View" mode: the main channel view with the forum post as the channel.

## 2. Interactions

### Sort & View menu `[sE]`

`navId "sort-and-view"`, aria "Set sort or view" ("Change the sort for Media Posts" for media channels). Each choice is applied per channel and closes the menu. It contains radio groups:

| group label | items (`id`) | value |
|---|---|---|
| **Sort by** | "Recently Active" (`sort-by-recent-activity`) · "Date Posted" (`sort-by-date-posted`) | `LATEST_ACTIVITY` / `CREATION_DATE` |
| **View as** (hidden for media, mod-report and game-invite channels) | "List" (`view-as-list`) · "Gallery" (`view-as-grid`) | `LIST` / `GRID` |
| **Tag Matching** (only if the channel has tags) | "Match Some" (`match-some`) · "Match All" | `MATCH_SOME` (any) / `MATCH_ALL` |
| (no label) | "Reset to default" (`reset-all`) | channel defaults |

The channel defaults come from the channel's default sort order and default forum layout (Discord API fields `default_sort_order` / `default_forum_layout`; the audit-log constant `DEFAULT_FORUM_LAYOUT` is in web.js).

### Tag filter

Multi-select. Clicking a pill in the header row, or in "Select Tags", toggles that tag in the channel's `tagFilter` set. Selected pills use the `selected` style, and the "All" button switches to a count bubble. "Match Some" shows posts with any selected tag; "Match All" requires every selected tag. "Clear all" empties the set. An empty result shows the tag-filter empty state.

### Search

Typing in the collapsed title field and pressing **Enter** runs a forum search. The matching row shows "Searching..." → "No matching posts" or "{n} posts with "{query}"", plus "Clear". Search hits are highlighted in titles.

### Hover, active, and open states (from the CSS)

| element | hover | active | other |
|---|---|---|---|
| list card | bg `--background-surface-high`, border `--border-strong`, `--shadow-low` | bg `--interactive-background-active`, `--shadow-border, --shadow-high` | `.isOpen` bg `--background-surface-higher`; transitions .2s under `.full-motion` |
| gallery card | bg + border `--interactive-background-hover`, `--shadow-border, --shadow-high` | `--interactive-background-active` | `.isOpen` bg `--interactive-background-selected`; base border `--border-muted` |
| Sort & View / All buttons | `--control-secondary-background-hover` | `…-active` | |
| tag pill | `--control-secondary-background-hover` | `…-active` | selected hover `--opacity-blurple-32`, active `--opacity-blurple-12`; `.disabled` opacity .5 |
| guidelines ✎/✕ | colour `--interactive-text-hover` | `--interactive-text-active` | |
| "Clear", guideline links | underline | | |
| typing dots ring | border follows the card state colour | | |

Right-click on a card opens the thread context menu. Left-click on the facepile opens user popouts and does not open the post.

### Keyboard

- **Title field.**
  - Enter with the form open and a title present moves focus to the body.
  - **Shift+Enter** (when the user can post) opens the New Post form, using the typed text as the title, and focuses the body if a title exists. Under a condition that was not resolved, it also opens the Post Guidelines panel. The hint row "[SHIFT] + [ENTER] to create a new post" shows while the title is focused and empty.
  - Plain Enter otherwise searches.
- **Header card.** Focusing it moves focus to the title input, except during Shift+Tab.
- **Post list** (keyboard mode only, composer not focused).
  - List layout: a vertical list navigator `forum-channel-list-<id>`.
  - Gallery layout: a 2-D grid navigator `forum-grid-view`. Left and Right move across columns. Up and Down move rows and continue into the previous or next section. **Enter/Space** activates the focused card (key repeat is ignored).
- **Tag row.** A horizontal, wrapping navigator `<channelId>-tags-navigator`.
- **Popouts.** These are standard Discord menus and popouts (arrow keys, Esc).

## 3. Sidebar icon and labels

All icons use a 24×24 viewBox, `fill="currentColor"`.

**Forum channel icon** (module 56059, export `b`). Two paths, no fill-rule:

```
M18.91 12.98a5.45 5.45 0 0 1 2.18 6.2c-.1.33-.09.68.1.96l.83 1.32a1 1 0 0 1-.84 1.54h-5.5A5.6 5.6 0 0 1 10 17.5a5.6 5.6 0 0 1 5.68-5.5c1.2 0 2.32.36 3.23.98Z
M19.24 10.86c.32.16.72-.02.74-.38L20 10c0-4.42-4.03-8-9-8s-9 3.58-9 8c0 1.5.47 2.91 1.28 4.11.14.21.12.49-.06.67l-1.51 1.51A1 1 0 0 0 2.4 18h5.1a.5.5 0 0 0 .49-.5c0-4.2 3.5-7.5 7.68-7.5 1.28 0 2.5.3 3.56.86Z
```

**Variants**, in the order the resolver checks them (`ei()` in web.js module 713654). Moderator-report forums return FlagIcon and the rules channel returns the book icon before this switch:

| condition | icon (module.export) | label |
|---|---|---|
| NSFW | 781481.f (forum + warning triangle, `fill-rule=evenodd`) | "Forum (Age-Restricted)" |
| spoiler channel | 760911.H (forum + eye) | "Forum (Spoiler)" |
| locked (`Q.A(channel)`, the same helper as the locked text icon) | 597050.Q (forum + padlock) | "Forum (Limited)" |
| media channel | 191023 ImageIcon | "Media Channel" |
| game-invite channel | 434831.t | |
| default | **56059.b** | "Forum" |

Exact variant paths:
```
NSFW (evenodd):
  M18.09 1.63c.4-.7 1.43-.7 1.82 0l3.96 6.9c.38.66-.12 1.47-.91 1.47h-7.92c-.79 0-1.3-.81-.91-1.48l3.96-6.9Zm.46 1.87h.9c.3 0 .52.26.5.55l-.22 2.02c-.01.16-.17.26-.33.23a1.92 1.92 0 0 0-.8 0c-.16.03-.32-.07-.33-.23l-.21-2.02a.5.5 0 0 1 .5-.55ZM19 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z
  M14.8 3.34a.48.48 0 0 0-.24-.69A9.94 9.94 0 0 0 11 2c-4.97 0-9 3.58-9 8 0 1.5.47 2.91 1.28 4.11.14.21.12.49-.06.67l-1.51 1.51A1 1 0 0 0 2.4 18h5.1a.5.5 0 0 0 .49-.5c0-2.86 1.62-5.3 3.97-6.56.28-.15.38-.51.25-.8a2.87 2.87 0 0 1 .18-2.61l2.4-4.19ZM18.91 12.98a5.45 5.45 0 0 1 2.18 6.2c-.1.33-.09.68.1.96l.83 1.32a1 1 0 0 1-.84 1.54h-5.5A5.6 5.6 0 0 1 10 17.5a5.6 5.6 0 0 1 5.68-5.5c1.2 0 2.32.36 3.23.98Z
Spoiler (evenodd):
  M15.7 12a5.6 5.6 0 0 1 5.67 5.5c0 .57-.09 1.14-.27 1.69-.1.32-.09.67.1.95l.83 1.32A1 1 0 0 1 21.2 23h-5.5a5.6 5.6 0 0 1-5.68-5.5 5.6 5.6 0 0 1 5.68-5.5Z
  M11 2c.52 0 1.02.04 1.51.11.43.07.61.57.38.94-.23.36-.4.7-.53.97l-.12.24a2.78 2.78 0 0 0 0 2.26c.26.59.86 1.75 1.9 2.8.27.27.12.8-.25.89A7.54 7.54 0 0 0 8 17.5a.5.5 0 0 1-.48.5h-5.1a1 1 0 0 1-.72-1.7l1.52-1.53c.18-.17.2-.45.06-.66A7.31 7.31 0 0 1 2 10c0-4.42 4.03-8 9-8Z
  M19 1.39c3.05 0 4.52 2.73 4.94 3.68.09.2.09.43 0 .64-.42.95-1.89 3.68-4.93 3.68-3.05 0-4.52-2.73-4.93-3.68a.78.78 0 0 1 0-.64c.41-.95 1.88-3.68 4.93-3.68Zm0 2.36c0-.34-.28-.61-.6-.52a2.25 2.25 0 1 0 2.86 2.12c0-.34-.35-.52-.67-.42l-.82.25a.6.6 0 0 1-.78-.58v-.85Z
Locked (evenodd):
  M16 4h.5v-.5a2.5 2.5 0 0 1 5 0V4h.5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm4-.5V4h-2v-.5a1 1 0 1 1 2 0Z
  M13.58 3.23c.24-.33.16-.86-.24-.96C12.59 2.1 11.8 2 11 2c-4.97 0-9 3.58-9 8 0 1.5.47 2.91 1.28 4.11.14.21.12.49-.06.67l-1.51 1.51A1 1 0 0 0 2.4 18h5.1a.5.5 0 0 0 .49-.5c0-3.17 2-5.82 4.77-6.94.29-.11.43-.45.34-.75A3 3 0 0 1 13 9V5c0-.66.22-1.28.58-1.77ZM18.91 12.98a5.45 5.45 0 0 1 2.18 6.2c-.1.33-.09.68.1.96l.83 1.32a1 1 0 0 1-.84 1.54h-5.5A5.6 5.6 0 0 1 10 17.5a5.6 5.6 0 0 1 5.68-5.5c1.2 0 2.32.36 3.23.98Z
```

- **Forum posts** (thread rows under the forum in the channel list, and post mentions) use **ChatIcon**: `M12 22a10 10 0 1 0-8.45-4.64c.13.19.11.44-.04.61l-2.06 2.37A1 1 0 0 0 2.2 22H12Z`.
- **holt today:** `channelIcons.tsx` has `ChannelIconKind = 'text' | 'announcement' | 'rules'` and maps every non-5 type to text. Forum (type 15) needs a new kind.

**Other icons used by the forum UI** (module.export, path):
- Sort & View button, `112173.J`: `M16.3 21.7a1 1 0 0 0 1.4 0l4-4a1 1 0 0 0-1.4-1.4L18 18.58V3a1 1 0 1 0-2 0v15.59l-2.3-2.3a1 1 0 0 0-1.4 1.42l4 4ZM6.3 2.3a1 1 0 0 1 1.4 0l4 4a1 1 0 0 1-1.4 1.4L8 5.42V21a1 1 0 1 1-2 0V5.41l-2.3 2.3a1 1 0 0 1-1.4-1.42l4-4Z`
- Chevron down (closed), `847374.a`: `M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z`. Chevron up (popout open), `900797.t`: `M5.3 14.7a1 1 0 0 0 1.4 0L12 9.42l5.3 5.3a1 1 0 0 0 1.4-1.42l-6-6a1 1 0 0 0-1.4 0l-6 6a1 1 0 0 0 0 1.42Z`. Both are drawn at 20px.
- TagIcon, `278416`: `M12.24 2a3 3 0 0 0-2.12.88l-8.25 8.25a3 3 0 0 0 0 4.24l6.76 6.76a3 3 0 0 0 4.24 0l8.25-8.25a3 3 0 0 0 .88-2.12V4a2 2 0 0 0-2-2h-7.76ZM17 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z`
- Post Guidelines, `622629.B`: the same book-check path as holt's `BOOK_CHECK_ICON_PATH`.
- Pinned marker, `366605.t`: `M19.38 11.38a3 3 0 0 0 4.24 0l.03-.03a.5.5 0 0 0 0-.7L13.35.35a.5.5 0 0 0-.7 0l-.03.03a3 3 0 0 0 0 4.24L13 5l-2.92 2.92-3.65-.34a2 2 0 0 0-1.6.58l-.62.63a1 1 0 0 0 0 1.42l9.58 9.58a1 1 0 0 0 1.42 0l.63-.63a2 2 0 0 0 .58-1.6l-.34-3.64L19 11l.38.38ZM9.07 17.07a.5.5 0 0 1-.08.77l-5.15 3.43a.5.5 0 0 1-.63-.06l-.42-.42a.5.5 0 0 1-.06-.63L6.16 15a.5.5 0 0 1 .77-.08l2.14 2.14Z`
- Composer draft pencil, `22231 PencilIcon`: `m13.96 5.46 4.58 4.58a1 1 0 0 0 1.42 0l1.38-1.38a2 2 0 0 0 0-2.82l-3.18-3.18a2 2 0 0 0-2.82 0l-1.38 1.38a1 1 0 0 0 0 1.42ZM2.11 20.16l.73-4.22a3 3 0 0 1 .83-1.61l7.87-7.87a1 1 0 0 1 1.42 0l4.58 4.58a1 1 0 0 1 0 1.42l-7.87 7.87a3 3 0 0 1-1.6.83l-4.23.73a1.5 1.5 0 0 1-1.73-1.73Z`
- Close ✕, `789645.P`: `M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z`
- Magnifier, `7689`: `M15.62 17.03a9 9 0 1 1 1.41-1.41l4.68 4.67a1 1 0 0 1-1.42 1.42l-4.67-4.68ZM17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z`

### Strings (en-US; message key in parentheses where looked up)

- **Channel list and labels:** "Forum" · "Forum Channel" (GbryDd) · "Forum (Limited)" · "Forum (Age-Restricted)" · "Forum (Spoiler)". Channel-row aria labels: "{channelName} (forum channel)" (Ajnhpa), "unread, {channelName} (forum channel)" (dr/Oik), "{n} mention(s), {channelName} (forum channel)" (rSsuUF). Also "Forum Post", "New Forum Post", "Search forum posts", "Compose Message, Forum Post {channel}".
- **Header:** "Search or create a post..." · "Search" · "Title" · "Create Post" · "New Post" · "Post" · "Post Guidelines" · "View All" · "Close" · "Sort & View" / "Sort" · "All" · "see all tags" / "see more tags" (aria) · "Tags" · "Searching..." · "No matching posts" · "{n} post(s) with "{query}"" · "Clear" · "to create a new post" · "You do not have permission to post in this channel."
- **Composer:** "Enter a message..." · "Enter a tag..." · "See more tags" · "Add tag, {tagName}" · "A tag is required to create a post in this channel" · "A title is required" · "A message is required" · "Preview" / "Exit Preview" / "Preview Mode".
- **Menus and popouts:** "Set sort or view" · "Sort by" · "Recently Active" · "Date Posted" · "View as" · "List" · "Gallery" · "Tag Matching" · "Match Some" · "Match All" · "Reset to default" · "Filter by tags" · "Select Tags" · "Clear all".
- **Cards:** "Post {title}, {count} message(s)" (aria) · "{name}, post author" (aria) · "Posted {timestamp}" · "{count} New" · "Original message was deleted" · "Post contains a blocked message" · "Post contains an ignored message" · "Obscured content" · "Pinned" · "{n} New Post(s)" · "Older Posts".
- **Empty states and permissions:** "Be the first to start the conversation!" · "What do you want to post about in #{channelName}?" · "There are no posts with {this tag|these tags} yet!" · "Be the first to start a conversation with {this tag|these tags}" · "Create a post" · "See Examples" · "You do not have permission to view the post history of **#{channelName}**." · "…to search the post history of **#{channelName}**." · "There’s no one in this post."
- **Open post:** "Thread header" (aria) · "More" · "Open in Full View" · "Copy Thread ID" · "Pins" · "Follow" / "Following" (exist in the bundle; their forum-post usage was not located).

## 4. Not found / not verified

1. **Forum post action bar JSX** (Follow/Following button, share and reaction controls under the starter message) and the **thread breadcrumb title** (`zF`, module 353428). Both are in Channel code chunks that were not fetched. The CSS for the action bar *container* is extracted (§CSS 11), but its inner button classes are unknown.
2. **Tag pill component** (`376310`) was not fetched. The `pill_a2c9e8` attribution is inferred from props (see §1.7). The TagGroup `_cfee8f` class map was not fetched; it is matched by data attributes only.
3. **Secondary message bundle** (module 490094) was not fetched. It holds the game-invite empty-state strings and the game-invite "New Post" label (`QwW8zd`). The regular forum strings are all resolved.
4. **Not extracted (out of scope or rare):**
   - admin Get Started card `_a68543`;
   - media-channel upsell `_c6ad88`;
   - mod-report card `_fc958f`;
   - game-invite cards `_a2d698` / `__53b91` / `__0acd6`;
   - the experimental filter bar in chunk 430877 (`_ded0dc`, `_f975d3`, `__0d9a8`, `_fe4819`, `__3dde2`; none referenced by ForumChannel);
   - chunk 229511 (`_d13feb`, `__269fe`; not referenced by ForumChannel);
   - `forumPost__02068` / `forumPost__8a0ec` (embedded forum-post previews elsewhere).
5. **Light theme:** `theme-light` variants were dropped, matching the existing rip filter.
6. **Live DOM and pixel checks:** not possible without a logged-in session.

## 5. Design tokens

The extracted rules use these `var(--…)` names. Checked against `main/src/pages/chat/discord-tokens.css` and the other chat CSS files.

**Already defined in `discord-tokens.css` (54):** `--background-base-low`, `--background-base-lower`, `--background-base-lowest`, `--background-gradient-chat`, `--background-mod-normal`, `--background-mod-strong`, `--background-mod-subtle`, `--background-surface-high`, `--background-surface-higher`, `--border-feedback-critical`, `--border-focus`, `--border-muted`, `--border-strong`, `--border-subtle`, `--brand-500`, `--control-secondary-background-active`, `--control-secondary-background-hover`, `--font-weight-medium`, `--font-weight-normal`, `--icon-muted`, `--input-background-default`, `--input-border-default`, `--interactive-background-active`, `--interactive-background-hover`, `--interactive-background-selected`, `--interactive-text-active`, `--interactive-text-default`, `--interactive-text-hover`, `--opacity-black-60`, `--primary-800-hsl`, `--radius-lg`, `--radius-md`, `--radius-sm`, `--radius-xs`, `--reaction-background-reacted-default`, `--reaction-text-reacted-default`, `--shadow-border`, `--shadow-high`, `--shadow-low`, `--shadow-medium`, `--space-12`, `--space-16`, `--space-4`, `--space-8`, `--space-lg`, `--space-md`, `--space-sm`, `--space-xs`, `--text-default`, `--text-feedback-critical`, `--text-link`, `--text-muted`, `--text-strong`, `--text-subtle`

**Defined elsewhere in the chat CSS, not in `discord-tokens.css` (works today only where that file applies; move to the token sheet):**

- `--control-secondary-background-default`: interactions.css, onboarding.css
- `--control-secondary-border-default`: interactions.css, onboarding.css
- `--control-secondary-text-default`: interactions.css, onboarding.css
- `--elevation-low`: chat.css
- `--elevation-medium`: chat.css
- `--font-primary`: chat.css
- `--opacity-blurple-12`: onboarding.css

**Missing everywhere (add to `discord-tokens.css`). Values are Discord's dark theme / `:root` from theme chunk 952007 (`952007.87dea5a700fabeaf.css`) unless noted.**

| token | Discord value | notes |
|---|---|---|
| `--__post-thumbnail-size` | `(n/a)` | local, set inside `.thumbnailContainer_faa96b` (72px) |
| `--background-feedback-critical` | `hsl(var(--opacity-red-8-hsl)/0.0784313725490196)` | from `952007.87dea5a700fabeaf.css` |
| `--background-feedback-positive` | `hsl(var(--opacity-green-8-hsl)/0.0784313725490196)` | from `952007.87dea5a700fabeaf.css` |
| `--background-feedback-warning` | `hsl(var(--opacity-yellow-8-hsl)/0.0784313725490196)` | from `952007.87dea5a700fabeaf.css` |
| `--background-gradient-high` | `(n/a)` | optional custom-theme gradient, always used with a fallback: `var(--background-gradient-high,var(--background-base-low))`. No definition needed |
| `--brand-15a` | `hsla(var(--brand-500-hsl)/0.15)` | from `shell css` |
| `--channel-text-area-placeholder` | `var(--primary-430)` | from `952007.87dea5a700fabeaf.css` |
| `--control-icon-only-background-hover` | `hsl(var(--opacity-16-hsl)/0.1607843137254902)` | from `952007.87dea5a700fabeaf.css` |
| `--control-icon-only-border-hover` | `hsl(var(--opacity-4-hsl)/0.0392156862745098)` | from `952007.87dea5a700fabeaf.css` |
| `--custom-forum-composer-attachments-attachment-size` | `78px` | from `419070.573a47afd8bdcf20.css` |
| `--custom-forum-post-form-control-size` | `40px` | from `css-302800.css` |
| `--custom-forum-post-form-padding` | `var(--space-8)` | from `css-302800.css` |
| `--custom-forum-post-grid-view-obscured-blur-radius` | `20px` | from `419070.573a47afd8bdcf20.css` |
| `--custom-forum-post-obscured-blur-radius` | `20px` | from `419070.573a47afd8bdcf20.css` |
| `--custom-media-post-attachments-horizontal-padding` | `48px` | from `419070.573a47afd8bdcf20.css` |
| `--custom-non-message-content-margin` | `(n/a)` | local, set inside `.nonMessageContent__31080` (`var(--space-16)`) |
| `--opacity-black-80` | `hsl(var(--opacity-black-80-hsl)/0.8)` | from `952007.87dea5a700fabeaf.css` |
| `--opacity-blurple-32` | `hsl(var(--opacity-blurple-32-hsl)/0.3215686274509804)` | from `952007.87dea5a700fabeaf.css` |
| `--radius-round` | `2147483647px` | from `952007.87dea5a700fabeaf.css` |
| `--radius-xl` | `24px` | from `952007.87dea5a700fabeaf.css` |
| `--red-400` | `hsl(var(--red-400-hsl)/1)` | from `952007.87dea5a700fabeaf.css` |
| `--text-feedback-positive` | `var(--green-new-22)` | from `952007.87dea5a700fabeaf.css` |
| `--text-feedback-warning` | `var(--yellow-new-38)` | from `952007.87dea5a700fabeaf.css` |

**Raw ramps those values need that are also missing:**

| token | Discord value |
|---|---|
| `--opacity-red-8-hsl` | `355.636 calc(var(--saturation-factor, 1)*64.706%) 50%` |
| `--opacity-green-8-hsl` | `151.128 calc(var(--saturation-factor, 1)*100%) 26.078%` |
| `--primary-430` | `hsl(var(--primary-430-hsl)/1)` |
| `--primary-430-hsl` | `229.091 calc(var(--saturation-factor, 1)*4.803%) 44.902%` |
| `--opacity-4-hsl` | `240 calc(var(--saturation-factor, 1)*4%) 60.784%` |
| `--neutral-1` | `hsl(var(--neutral-1-hsl)/1)` |
| `--opacity-black-4` | `hsl(var(--opacity-black-4-hsl)/0.0392156862745098)` |
| `--opacity-black-4-hsl` | `0 calc(var(--saturation-factor, 1)*0%) 0%` |
| `--opacity-black-16` | `hsl(var(--opacity-black-16-hsl)/0.1607843137254902)` |
| `--opacity-black-80-hsl` | `0 calc(var(--saturation-factor, 1)*0%) 0%` |
| `--opacity-blurple-32-hsl` | `234.935 calc(var(--saturation-factor, 1)*85.556%) 64.706%` |
| `--green-new-22` | `hsl(var(--green-new-22-hsl)/1)` |
| `--green-new-22-hsl` | `137.143 calc(var(--saturation-factor, 1)*42.541%) 64.51%` |
| `--yellow-new-38` | `hsl(var(--yellow-new-38-hsl)/1)` |
| `--yellow-new-38-hsl` | `39.81 calc(var(--saturation-factor, 1)*97.235%) 57.451%` |

## 6. Class names (appendix)

Every row comes from a CSS-module class map in the bundle. Proposed manifest keys follow `discord-class-manifest.json` (camelCase stable name → hashed class). The prefixes are a suggestion only, and the chatbox may prefer shorter names. Typography helper classes compiled into the same modules (`heading-*`, `text-*`, `eyebrow`, …) are left out.

CSS chunk files for the manifest's `chunks` map (this build; chunk file hashes rotate every deploy, so re-resolve them via `T.k` in `web.<hash>.js`):

```jsonc
"forum-shell":      "1605ef4c1175a9e3.css",          // chunk 500194: page shell, header, guidelines, admin card
"forum-composer":   "c1f8ba2a3ba90d23.css",          // chunk 302800: composer, gallery card, tag/sort popouts
"forum-list-card":  "779a3376f640c187.css",          // chunk 452880: list card, empty state, mod-report card
"forum-post-tags":  "98e2bda00841b282.css",          // chunk 599660: tags row on a post
"forum-uploads":    "02667be3dbda1429.css",          // chunk 207309: composer attachments
"forum-tag-pill":   "726399.659780c39208b55b.css",   // chunk 726399: tag pill, tags wrap, post author
"forum-post-view":  "97585.c5d9b4ece02fa77e.css",    // chunk 97585: starter-message action bar, emptyForum spacer
"tag-group":        "964940.62a0e9d626b739d9.css"    // shell chunk 964940: design-system TagGroup (experiment path)
```

`rip-discord-css.mjs` reads these from `https://canary.discord.com/assets/<file>`. Hash-only names exist on both hosts, but canary can be a different build, so take the names from canary's own `web.<hash>.js`.

Classes reused from modules already in the manifest: the open-post sidebar header uses `container__9293f`, `title__9293f`, `toolbar__9293f`, … (manifest keys `header*`). The thread chat and composer use the existing message and `channelTextArea__74017` classes.

#### Page shell, header card, tag filter row, Sort & View, list/grid (module 253898, chunk 500194, CSS `1605ef4c1175a9e3.css`)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `container` | `container_f369db` | `forumContainer` |
| `uploadArea` | `uploadArea_f369db` | `forumUploadArea` |
| `label` | `label_f369db` | `forumLabel` |
| `content` | `content_f369db` | `forumContent` |
| `grid` | `grid_f369db` | `forumGrid` |
| `list` | `list_f369db` | `forumList` |
| `noListContainer` | `noListContainer_f369db` | `forumNoListContainer` |
| `headerRow` | `headerRow_f369db` | `forumHeaderRow` |
| `card` | `card_f369db` | `forumCard` |
| `columnsSpan` | `columnsSpan_f369db` | `forumColumnsSpan` |
| `emptyStateRow` | `emptyStateRow_f369db` | `forumEmptyStateRow` |
| `newMemberBanner` | `newMemberBanner_f369db` | `forumNewMemberBanner` |
| `gridViewBanner` | `gridViewBanner_f369db` | `forumGridViewBanner` |
| `placeholder` | `placeholder_f369db` | `forumPlaceholder` |
| `mainCard` | `mainCard_f369db` | `forumMainCard` |
| `mainCardContainer` | `mainCardContainer_f369db` | `forumMainCardContainer` |
| `gameInvitesHeaderContainer` | `gameInvitesHeaderContainer_f369db` | `forumGameInvitesHeaderContainer` |
| `gameIcon` | `gameIcon_f369db` | `forumGameIcon` |
| `gameIconClickable` | `gameIconClickable_f369db` | `forumGameIconClickable` |
| `emptyMainCard` | `emptyMainCard_f369db` | `forumEmptyMainCard` |
| `outOfDate` | `outOfDate_f369db` | `forumOutOfDate` |
| `header` | `header_f369db` | `forumHeader` |
| `headerContainer` | `headerContainer_f369db` | `forumHeaderContainer` |
| `headerWithMatchingPosts` | `headerWithMatchingPosts_f369db` | `forumHeaderWithMatchingPosts` |
| `noForm` | `noForm_f369db` | `forumNoForm` |
| `sortContainer` | `sortContainer_f369db` | `forumSortContainer` |
| `sort` | `sort_f369db text-sm/medium_f369db` | `forumSort` |
| `sortPopout` | `sortPopout_f369db` | `forumSortPopout` |
| `archivedDividerRow` | `archivedDividerRow_f369db` | `forumArchivedDividerRow` |
| `archivedDivider` | `archivedDivider_f369db` | `forumArchivedDivider` |
| `newPostsButton` | `newPostsButton_f369db` | `forumNewPostsButton` |
| `loadingCard` | `loadingCard_f369db` | `forumLoadingCard` |
| `loadingCard-0` | `loadingCard-0_f369db` | `forumLoadingCard0` |
| `loadingCard-1` | `loadingCard-1_f369db` | `forumLoadingCard1` |
| `loadingCard-2` | `loadingCard-2_f369db` | `forumLoadingCard2` |
| `matchingPostsRow` | `matchingPostsRow_f369db` | `forumMatchingPostsRow` |
| `enterIcon` | `enterIcon_f369db` | `forumEnterIcon` |
| `warnIcon` | `warnIcon_f369db` | `forumWarnIcon` |
| `searchIcon` | `searchIcon_f369db` | `forumSearchIcon` |
| `missingReadHistoryPermission` | `missingReadHistoryPermission_f369db` | `forumMissingReadHistoryPermission` |
| `divider` | `divider_f369db` | `forumDivider` |
| `tagsContainer` | `tagsContainer_f369db` | `forumTagsContainer` |
| `filterIcon` | `filterIcon_f369db` | `forumFilterIcon` |
| `tagList` | `tagList_f369db` | `forumTagList` |
| `tagListInner` | `tagListInner_f369db` | `forumTagListInner` |
| `tagsButton` | `tagsButton_f369db` | `forumTagsButton` |
| `tagsButtonInner` | `tagsButtonInner_f369db` | `forumTagsButtonInner` |
| `tagsButtonPlaceholder` | `tagsButtonPlaceholder_f369db` | `forumTagsButtonPlaceholder` |
| `tagsButtonWithCount` | `tagsButtonWithCount_f369db` | `forumTagsButtonWithCount` |
| `sortDropdown` | `sortDropdown_f369db` | `forumSortDropdown` |
| `sortDropdownInner` | `sortDropdownInner_f369db` | `forumSortDropdownInner` |
| `sortDropdownText` | `sortDropdownText_f369db` | `forumSortDropdownText` |
| `sortDropdownTextHighContrastForcedColor` | `sortDropdownTextHighContrastForcedColor_f369db` | `forumSortDropdownTextHighContrastForcedColor` |
| `clear` | `clear_f369db` | `forumClear` |
| `matchingPosts` | `matchingPosts_f369db` | `forumMatchingPosts` |
| `startPostHelp` | `startPostHelp_f369db` | `forumStartPostHelp` |
| `tagsSpacer` | `tagsSpacer_f369db` | `forumTagsSpacer` |
| `keyboardShortcut` | `keyboardShortcut_f369db` | `forumKeyboardShortcut` |
| `key` | `key_f369db` | `forumKey` |
| `countContainer` | `countContainer_f369db` | `forumCountContainer` |
| `countText` | `countText_f369db` | `forumCountText` |
| `optInNotice` | `optInNotice_f369db` | `forumOptInNotice` |

#### Post Guidelines (257701, chunk 500194)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `kL` | `container_ca49a1` | `forumGuidelinesContainer` |
| `I4` | `guidelines_ca49a1` | `forumGuidelinesGuidelines` |
| `$4` | `guidelinesHeader_ca49a1` | `forumGuidelinesGuidelinesHeader` |
| `N1` | `headerContainer_ca49a1` | `forumGuidelinesHeaderContainer` |
| `iQ` | `descriptionContainer_ca49a1` | `forumGuidelinesDescriptionContainer` |
| `jP` | `showMore_ca49a1` | `forumGuidelinesShowMore` |
| `D7` | `gradient_ca49a1` | `forumGuidelinesGradient` |
| `kx` | `linkContainer_ca49a1` | `forumGuidelinesLinkContainer` |
| `DD` | `showMoreLink_ca49a1` | `forumGuidelinesShowMoreLink` |
| `ur` | `showMoreText_ca49a1` | `forumGuidelinesShowMoreText` |
| `yS` | `showMoreIcon_ca49a1` | `forumGuidelinesShowMoreIcon` |
| `vk` | `clickable_ca49a1` | `forumGuidelinesClickable` |
| `kK` | `hiddenVisually_ca49a1` | `forumGuidelinesHiddenVisually` |

#### Header composer / New Post form (803181, chunk 302800, CSS `c1f8ba2a3ba90d23.css`)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `kL` | `container_d9be46` | `forumComposerContainer` |
| `CN` | `horizontalPadding_d9be46` | `forumComposerHorizontalPadding` |
| `KJ` | `formContainer_d9be46` | `forumComposerFormContainer` |
| `Zd` | `form_d9be46` | `forumComposerForm` |
| `vJ` | `previewForm_d9be46` | `forumComposerPreviewForm` |
| `VB` | `prefixElement_d9be46` | `forumComposerPrefixElement` |
| `gn` | `titleContainer_d9be46` | `forumComposerTitleContainer` |
| `DD` | `title_d9be46 heading-lg/semibold_d9be46` | `forumComposerTitle` |
| `yZ` | `collapsed_d9be46` | `forumComposerCollapsed` |
| `IP` | `bodyContainer_d9be46` | `forumComposerBodyContainer` |
| `hQ` | `contentContainer_d9be46` | `forumComposerContentContainer` |
| `gM` | `channelTextArea_d9be46` | `forumComposerChannelTextArea` |
| `SL` | `channelTextAreaInner_d9be46` | `forumComposerChannelTextAreaInner` |
| `EV` | `previewTextArea_d9be46` | `forumComposerPreviewTextArea` |
| `cr` | `channelTextAreaInnerError_d9be46` | `forumComposerChannelTextAreaInnerError` |
| `gO` | `controlsContainer_d9be46` | `forumComposerControlsContainer` |
| `ne` | `controls_d9be46` | `forumComposerControls` |
| `Kk` | `wrappedControls_d9be46` | `forumComposerWrappedControls` |
| `ku` | `requiredError_d9be46` | `forumComposerRequiredError` |
| `Dq` | `characterCount_d9be46` | `forumComposerCharacterCount` |
| `n1` | `expressionPicker_d9be46` | `forumComposerExpressionPicker` |
| `Pc` | `tagsContainer_d9be46` | `forumComposerTagsContainer` |
| `HZ` | `tagsIcon_d9be46` | `forumComposerTagsIcon` |
| `kU` | `tagList_d9be46` | `forumComposerTagList` |
| `j5` | `tagListInner_d9be46` | `forumComposerTagListInner` |
| `Wk` | `tagsButton_d9be46` | `forumComposerTagsButton` |
| `Dz` | `tagsButtonPlaceholder_d9be46` | `forumComposerTagsButtonPlaceholder` |
| `XJ` | `tagsDivider_d9be46` | `forumComposerTagsDivider` |
| `rD` | `pencilIcon_d9be46` | `forumComposerPencilIcon` |
| `Ul` | `loaderAnimation_d9be46` | `forumComposerLoaderAnimation` |
| `fv` | `previewModeIndicator_d9be46` | `forumComposerPreviewModeIndicator` |

#### List card (223139, chunk 452880, CSS `779a3376f640c187.css`)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `kL` | `container_faa96b` | `forumListCardContainer` |
| `r$` | `dots_faa96b` | `forumListCardDots` |
| `nT` | `isOpen_faa96b` | `forumListCardIsOpen` |
| `Kv` | `focusTarget_faa96b` | `forumListCardFocusTarget` |
| `kb` | `left_faa96b` | `forumListCardLeft` |
| `rf` | `body_faa96b` | `forumListCardBody` |
| `JY` | `messageFocusBlock_faa96b` | `forumListCardMessageFocusBlock` |
| `iU` | `message_faa96b` | `forumListCardMessage` |
| `BK` | `messageContent_faa96b` | `forumListCardMessageContent` |
| `sl` | `messageContentTrailingIcon_faa96b` | `forumListCardMessageContentTrailingIcon` |
| `aG` | `messageContentLeadingIcon_faa96b` | `forumListCardMessageContentLeadingIcon` |
| `pV` | `bodyMedia_faa96b` | `forumListCardBodyMedia` |
| `yo` | `obscuredTag_faa96b` | `forumListCardObscuredTag` |
| `iT` | `thumbnailContainer_faa96b` | `forumListCardThumbnailContainer` |
| `LW` | `thumbnailOverride_faa96b` | `forumListCardThumbnailOverride` |
| `cd` | `obscured_faa96b` | `forumListCardObscured` |
| `nh` | `obscuredThumbnailPlaceholder_faa96b` | `forumListCardObscuredThumbnailPlaceholder` |
| `wx` | `header_faa96b` | `forumListCardHeader` |
| `qr` | `footer_faa96b` | `forumListCardFooter` |
| `xE` | `bullet_faa96b` | `forumListCardBullet` |
| `TK` | `headerText_faa96b` | `forumListCardHeaderText` |
| `o$` | `postTitleText_faa96b` | `forumListCardPostTitleText` |
| `pr` | `newBadgeWrapper_faa96b` | `forumListCardNewBadgeWrapper` |
| `Ad` | `newBadge_faa96b` | `forumListCardNewBadge` |
| `gi` | `newBadgeOverflow_faa96b` | `forumListCardNewBadgeOverflow` |
| `IW` | `typing_faa96b` | `forumListCardTyping` |
| `mD` | `typingUsers_faa96b` | `forumListCardTypingUsers` |
| `Mv` | `messageCountBox_faa96b` | `forumListCardMessageCountBox` |
| `SZ` | `messageCountIcon_faa96b` | `forumListCardMessageCountIcon` |
| `hT` | `hasRead_faa96b` | `forumListCardHasRead` |
| `gv` | `messageCountText_faa96b` | `forumListCardMessageCountText` |
| `bU` | `newMessageCount_faa96b` | `forumListCardNewMessageCount` |
| `vC` | `updateReactionButton_faa96b` | `forumListCardUpdateReactionButton` |
| `Wv` | `blockedMessage_faa96b` | `forumListCardBlockedMessage` |
| `qN` | `withNewBadgeOverflow_faa96b` | `forumListCardWithNewBadgeOverflow` |

#### List card author name (422256, chunk 726399, CSS `726399.659780c39208b55b.css`)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `c` | `author_d3eee8` | `forumPostAuthorAuthor` |
| `p` | `hasUnreads_d3eee8` | `forumPostAuthorHasUnreads` |

#### Gallery card (475290, chunk 302800)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `Kv` | `focusTarget__9a337` | `forumGridCardFocusTarget` |
| `X` | `obscuredTagContainer__9a337` | `forumGridCardObscuredTagContainer` |
| `yo` | `obscuredTag__9a337` | `forumGridCardObscuredTag` |
| `LW` | `thumbnailOverride__9a337` | `forumGridCardThumbnailOverride` |
| `rp` | `imageCover__9a337` | `forumGridCardImageCover` |
| `cd` | `obscured__9a337` | `forumGridCardObscured` |
| `xE` | `bullet__9a337` | `forumGridCardBullet` |
| `IW` | `typing__9a337` | `forumGridCardTyping` |
| `r$` | `dots__9a337` | `forumGridCardDots` |
| `mD` | `typingUsers__9a337` | `forumGridCardTypingUsers` |
| `vz` | `mediaIconsRow__9a337` | `forumGridCardMediaIconsRow` |
| `cU` | `mediaIcon__9a337` | `forumGridCardMediaIcon` |
| `v3` | `moreImagesPill__9a337` | `forumGridCardMoreImagesPill` |
| `In` | `moreImagesPillIcon__9a337` | `forumGridCardMoreImagesPillIcon` |
| `EY` | `moreImagesPillText__9a337` | `forumGridCardMoreImagesPillText` |
| `kL` | `container__9a337` | `forumGridCardContainer` |
| `EK` | `mosaicMediaContainer__9a337` | `forumGridCardMosaicMediaContainer` |
| `nT` | `isOpen__9a337` | `forumGridCardIsOpen` |
| `il` | `mediaContainer__9a337` | `forumGridCardMediaContainer` |
| `pV` | `bodyMedia__9a337` | `forumGridCardBodyMedia` |
| `UV` | `bodyMediaFrame__9a337` | `forumGridCardBodyMediaFrame` |
| `PU` | `postBody__9a337` | `forumGridCardPostBody` |
| `GA` | `tagsRow__9a337` | `forumGridCardTagsRow` |
| `wx` | `header__9a337` | `forumGridCardHeader` |
| `qr` | `footer__9a337` | `forumGridCardFooter` |
| `DD` | `title__9a337` | `forumGridCardTitle` |
| `GD` | `forumPostControls__9a337` | `forumGridCardForumPostControls` |
| `QW` | `controlsGroup__9a337` | `forumGridCardControlsGroup` |
| `Cv` | `contentPreview__9a337` | `forumGridCardContentPreview` |
| `Qs` | `content__9a337` | `forumGridCardContent` |
| `kh` | `textContentFooter__9a337` | `forumGridCardTextContentFooter` |
| `ZH` | `noTags__9a337` | `forumGridCardNoTags` |
| `Y6` | `authorRow__9a337` | `forumGridCardAuthorRow` |
| `wO` | `rowGroup__9a337` | `forumGridCardRowGroup` |
| `SD` | `postCreationTimestamp__9a337` | `forumGridCardPostCreationTimestamp` |
| `mz` | `messageCountContainer__9a337` | `forumGridCardMessageCountContainer` |
| `Ad` | `newBadge__9a337` | `forumGridCardNewBadge` |
| `kR` | `textContentUnread__9a337` | `forumGridCardTextContentUnread` |
| `b8` | `textContentRead__9a337` | `forumGridCardTextContentRead` |
| `EN` | `mediaPostContainer__9a337` | `forumGridCardMediaPostContainer` |
| `Rp` | `mediaPostThumbnail__9a337` | `forumGridCardMediaPostThumbnail` |
| `uU` | `tagPill__9a337` | `forumGridCardTagPill` |
| `Wv` | `blockedMessage__9a337` | `forumGridCardBlockedMessage` |

#### Tags row on a post (240103, chunk 599660, CSS `98e2bda00841b282.css`)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `_A` | `tags__08166` | `forumPostTagsTags` |
| `Ad` | `newBadge__08166` | `forumPostTagsNewBadge` |
| `Ne` | `pinIcon__08166` | `forumPostTagsPinIcon` |
| `At` | `tagFiltered__08166` | `forumPostTagsTagFiltered` |

#### Tag pill (715434, chunk 726399)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `pill` | `pill_a2c9e8` | `forumTagPillPill` |
| `clickable` | `clickable_a2c9e8` | `forumTagPillClickable` |
| `disabled` | `disabled_a2c9e8` | `forumTagPillDisabled` |
| `small` | `small_a2c9e8` | `forumTagPillSmall` |
| `selected` | `selected_a2c9e8` | `forumTagPillSelected` |
| `danger` | `danger_a2c9e8` | `forumTagPillDanger` |
| `success` | `success_a2c9e8` | `forumTagPillSuccess` |
| `warning` | `warning_a2c9e8` | `forumTagPillWarning` |
| `manaFilterTag` | `manaFilterTag_a2c9e8` | `forumTagPillManaFilterTag` |
| `emoji` | `emoji_a2c9e8` | `forumTagPillEmoji` |
| `closeCircle` | `closeCircle_a2c9e8 emoji_a2c9e8` | `forumTagPillCloseCircle` |
| `close` | `close_a2c9e8` | `forumTagPillClose` |
| `tooltipPill` | `tooltipPill_a2c9e8` | `forumTagPillTooltipPill` |

#### Tags wrap (959717, chunk 726399)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `_` | `tags_e5a45e` | `forumTagsWrapTags` |
| `L` | `wrap_e5a45e` | `forumTagsWrapWrap` |

#### Select Tags popout (287683, chunk 302800)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `kL` | `container__5808f` | `forumTagPopoutContainer` |
| `wx` | `header__5808f` | `forumTagPopoutHeader` |
| `LD` | `headerLeft__5808f` | `forumTagPopoutHeaderLeft` |
| `TK` | `headerText__5808f` | `forumTagPopoutHeaderText` |
| `d1` | `countContainer__5808f` | `forumTagPopoutCountContainer` |
| `lT` | `countText__5808f` | `forumTagPopoutCountText` |
| `I8` | `tagContainer__5808f` | `forumTagPopoutTagContainer` |
| `Tc` | `tag__5808f` | `forumTagPopoutTag` |
| `nM` | `row__5808f` | `forumTagPopoutRow` |
| `me` | `separator__5808f` | `forumTagPopoutSeparator` |

#### Sort & View popout wrapper (258268, chunk 302800)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `k` | `container_f8b2d2` | `forumSortPopoutContainer` |

#### Empty post list (922396, chunk 452880)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `k` | `container__93db4` | `forumEmptyContainer` |
| `w` | `header__93db4` | `forumEmptyHeader` |

#### Open post: starter message / action bar (950490, chunk 97585, CSS `97585.c5d9b4ece02fa77e.css`)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `TX` | `stickyMessage__31080` | `forumPostStarterStickyMessage` |
| `iU` | `message__31080` | `forumPostStarterMessage` |
| `iQ` | `nonMessageContent__31080` | `forumPostStarterNonMessageContent` |
| `GA` | `tagsRow__31080` | `forumPostStarterTagsRow` |
| `Jr` | `forumPostActionBar__31080` | `forumPostStarterForumPostActionBar` |
| `yF` | `divider__31080` | `forumPostStarterDivider` |
| `b1` | `dividerThin__31080 divider__31080` | `forumPostStarterDividerThin` |
| `ld` | `dividerThick__31080 divider__31080` | `forumPostStarterDividerThick` |

#### Message list spacers incl. emptyForum (33176, chunk 97585)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `Og` | `messagesWrapper__36d07` | `forumMessagesMessagesWrapper` |
| `gT` | `scrollerContent__36d07` | `forumMessagesScrollerContent` |
| `XG` | `scroller__36d07` | `forumMessagesScroller` |
| `bv` | `scrollerInner__36d07` | `forumMessagesScrollerInner` |
| `lB` | `scrollerSpacer__36d07` | `forumMessagesScrollerSpacer` |
| `Ie` | `empty__36d07` | `forumMessagesEmpty` |
| `Fb` | `emptyForum__36d07` | `forumMessagesEmptyForum` |
| `$4` | `navigationDescription__36d07` | `forumMessagesNavigationDescription` |
| `Mm` | `chatGradientBase__36d07` | `forumMessagesChatGradientBase` |
| `Zd` | `chatGradient__36d07 chatGradientBase__36d07` | `forumMessagesChatGradient` |
| `gA` | `chatTypingGradientAtBottom__36d07 chatGradientBase__36d07` | `forumMessagesChatTypingGradientAtBottom` |
| `ru` | `chatTypingGradientNotAtBottom__36d07 chatGradientBase__36d07` | `forumMessagesChatTypingGradientNotAtBottom` |
| `U6` | `gradientDefault__36d07` | `forumMessagesGradientDefault` |
| `XF` | `typingGradientNotAtBottom__36d07` | `forumMessagesTypingGradientNotAtBottom` |
| `cz` | `typingGradientAtBottom__36d07` | `forumMessagesTypingGradientAtBottom` |

#### Composer uploads (160589 / 793654 / 131360, chunk 207309, CSS `02667be3dbda1429.css`)

| JS export key | hashed class(es) | proposed manifest key |
|---|---|---|
| `EJ` | `uploadInput__94439` | `forumUploadUploadInput` |
| `T3` | `uploadIcon__94439` | `forumUploadUploadIcon` |
| `Fg` | `fileInput__94439` | `forumUploadFileInput` |
| `kL` | `container__94439` | `forumUploadContainer` |
| `fY` | `collapsedAttachment__94439` | `forumUploadCollapsedAttachment` |
| `jC` | `popoutContainer__94439` | `forumUploadPopoutContainer` |
| `SW` | `popout__94439` | `forumUploadPopout` |
| `p8` | `uploads__94439` | `forumUploadUploads` |
| `qS` | `badge__94439` | `forumUploadBadge` |

