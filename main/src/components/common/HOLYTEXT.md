# HolyText family — DOM/attribute obfuscation variants

These components keep "protected" strings out of the **shipped HTML** and the
**live DOM's naive text accessors**, so crawlers, copy-of-source and naive
scrapers don't get them. They render dash placeholders in the static markup,
then on mount decrypt the real string (same key/registry/decrypt path as the
original `HolyText`) and move it into a shadow root or reconstruct it in place.

> **This is obfuscation, not secrecy.** The browser still receives everything it
> renders. A real user, the accessibility tree, and automation that reads the
> live DOM after JS runs can all see the text. The shipped JS **bundle** is
> separately shield-encrypted, so string literals never ship in plaintext
> regardless — these variants only concern the live DOM and attributes. Raising
> cost, not creating a secret.

All variants share `src/lib/holy-render.ts`:
- `cipherFor(content, encrypted?)` — explicit `encrypted` wins, else the
  build-time registry (`window.__ABULXT_STRINGS__` / local), else `undefined`
  (⇒ unobfuscated fallback: the plaintext is rendered as-is).
- `resolveHoly(content, cipher, opts?)` — one gate for every variant:
  likely bot ⇒ keep dashes; registered string whose decrypt fails ⇒ keep dashes
  (never blank); otherwise reveal.
- `makeDashPlaceholder(text)` — dashes every non-whitespace code point,
  preserves whitespace and length (keeps word shape / wrapping).

The mechanism inherited from the original: text revealed into a **closed shadow
root** is hidden from naive `host.textContent` / `host.outerHTML`. **Inherited**
CSS (color, font, `white-space` via inheritance) crosses the boundary;
**non-inherited** properties, descendant selectors, pseudo-elements and
`text-decoration` do **not**.

---

## 1. `<HolyText>` — single static string (UNCHANGED public API)

`src/components/common/HolyText.tsx`. The existing API is preserved exactly;
only an opt-in `ellipsis` prop was added.

```tsx
<HolyText text="Tabs" />
<HolyText as="span" className="tab-item-title" text={title} />
<HolyText>King</HolyText>                 // string children still supported
<HolyText text={label} encrypted={cipher} /> // explicit ciphertext
```

Signature (additions in **bold**):
```ts
interface HolyTextProps extends React.HTMLAttributes<HTMLElement> {
  text?: string
  children?: React.ReactNode   // string children supported
  encrypted?: string
  as?: React.ElementType       // default 'span'
  ellipsis?: boolean           // NEW, default false — see §3
}
```
Mechanism: renders `makeDashPlaceholder(content)`, then on mount reveals into a
**closed** shadow root (`replaceChildren`). Re-reveals when `text` changes.

---

## 2. `<HolyRich>` — static runs interleaved with children / dynamic values

`src/components/common/HolyRich.tsx`. For labels and sentences that mix static
text with icons, inline `<a>`/`<strong>`, and `{dynamic}` values.

```tsx
<HolyRich as="p">
  Read our <HolyLink href="/tos" text="Terms" /> before you continue.
</HolyRich>

<HolyRich className="tab-item-title">
  <Icon size={14} /> New message from <HolyDynamic>{username}</HolyDynamic>
</HolyRich>
```

Signature:
```ts
interface HolyRichProps extends React.HTMLAttributes<HTMLElement> {
  as?: React.ElementType   // default 'span'
  children?: React.ReactNode
}
const HolyDynamic: React.FC<React.HTMLAttributes<HTMLSpanElement>>
```

**Contract** — React cannot tell a literal `"Hi"` from `{value}` that is `"Hi"`
at runtime, so the distinction is structural:
- A **bare string** child is a static run ⇒ moved into its own closed shadow
  root (one `<HolyText>` span each).
- Anything **wrapped in an element** passes through untouched and in position —
  that's how icons, links and dynamic values stay in the light DOM.
- A **dynamic value you want kept visible/queryable must be wrapped** — e.g.
  `<span>{v}</span>` or the self-documenting `<HolyDynamic>{v}</HolyDynamic>`.
  (A bare `{v}` string child would be obfuscated into a shadow span. Still
  visible to the user, but no longer in `textContent` — usually not what you
  want for dynamic data.)
- **Whitespace-only** string children (the spaces JSX inserts between elements)
  render as plain text nodes, so inline/flex spacing is preserved exactly.

Mechanism: closed shadow root per static run; inline `<span>` hosts keep the
surrounding inline/flex flow.

---

## 3. Ellipsis-safe mode — `HolyText ellipsis`

`text-overflow`, `white-space` and `overflow` are **non-inherited**, so they do
not cross the shadow boundary from the host. `ellipsis` handles this on **both**
sides:
- A `<style>` carrying `ELLIPSIS_SHADOW_CSS` is injected into the shadow root and
  the text is wrapped in a `.holy-ellipsis` span, so the shadow-internal box
  truncates.
- The host box (which is the block that clips the inline content) also gets the
  truncation props applied via its `style`.

```tsx
<HolyText text={longTitle} ellipsis style={{ maxWidth: 180 }} />
```
Opt-in; default off, so no existing caller's layout changes. Pass a width
constraint (`maxWidth`, or a sized flex/grid cell) as usual — ellipsis needs a
bounded box.

---

## 4. `useHolyAttr` / `<HolyInput>` — attribute obfuscation

The hook `useHolyAttr` lives in `src/lib/holy-attr.ts`; the `<HolyInput>`
wrapper (and the re-exported types) in `src/components/common/HolyAttr.tsx`. A
shadow root holds nodes, not attribute strings, so `aria-label` / `title` /
`placeholder` / `alt` / `aria-description` are handled by shipping
dash-placeholder attributes and setting the real value on mount.

```tsx
import { useHolyAttr } from '../../lib/holy-attr'
import { HolyInput } from '../common/HolyAttr'

// Hook — for any element
const { ref, placeholder } = useHolyAttr({
  'aria-label': 'Close dialog',
  title: 'Close',
})
return <button ref={ref} {...placeholder} onClick={...}>×</button>

// Convenience wrapper — input/textarea obfuscate placeholder/aria-label/title
<HolyInput placeholder="Search games" aria-label="Search" value={q} onChange={...} />
<HolyInput as="textarea" placeholder="Message" />
```

Signatures:
```ts
type HolyAttrName = 'aria-label' | 'aria-description' | 'title' | 'placeholder' | 'alt'
function useHolyAttr(
  values: Partial<Record<HolyAttrName, string>>,
  opts?: { revealForBots?: boolean },
): { ref: React.RefCallback<HTMLElement>; placeholder: Record<string, string> }

interface HolyInputProps extends Omit<React.InputHTMLAttributes<…>, 'ref'> {
  as?: 'input' | 'textarea'   // default 'input'
}
const HolyInput: forwardRef  // placeholder / aria-label / title auto-obfuscated
```

Mechanism: `placeholder` (dash attrs) is spread onto the element at render, so
the real text is never in the shipped HTML. A **layout effect** (synchronous
after mount, before paint) decrypts and `setAttribute`s the real value.

> ### ⚠️ Accessibility tradeoff — read before using on a control
> During the pre-JS / pre-hydration window a **screen reader sees the dash
> placeholder, not the real label.** Reveal runs in a layout effect to keep that
> window as short as possible, but it is non-zero. For decorative/supplementary
> attributes this is fine. For a control whose **only** accessible name is an
> obfuscated attribute, weigh the cost — an unobfuscated label is often the
> right call. Prefer obfuscating `placeholder`/`title` over the sole
> `aria-label` of an interactive control.

**Failure behaviour:** likely bots and decrypt failures **keep the dashes**
(never reveal, never blank). `revealForBots: true` overrides the bot gate.

---

## 5. `<HolyProse>` — selectable / copyable legal prose

`src/components/common/HolyProse.tsx`. For ToS / Privacy text that must stay
**user-selectable and copyable**. A closed shadow root would block selection, so
this variant never uses one.

```tsx
<HolyProse as="p" text={clauseText} />            {/* light mode (default) */}
<HolyProse as="p" text={clauseText} mode="shadow" />
```

Signature:
```ts
interface HolyProseProps extends React.HTMLAttributes<HTMLElement> {
  text?: string
  children?: string
  encrypted?: string
  as?: React.ElementType          // default 'span'
  mode?: 'light' | 'shadow'       // default 'light'
}
```

| mode | mechanism | selectable/copyable | hidden from `host.textContent` after JS? |
|------|-----------|---------------------|------------------------------------------|
| `light` (default) | reconstruct real text in the **light DOM** (`host.textContent = plaintext`) | yes, natively | **no** — reconstructed text is a normal node |
| `shadow` | reveal into an **open** shadow root | yes in-browser; copy reliability across the shadow boundary varies by browser | **yes** — host's own `textContent`/`outerHTML` stay empty of it |

**Protection (honest).** In both modes the real text is absent from the shipped
static HTML (dashes) and from the shipped JS (shield-encrypted bundle); it is
reconstructed only at runtime. This defeats naive HTML scrapers and
copy-paste-of-source. It does **not** hide the text from a real browser, the
user, the accessibility tree, or automation that reads the live DOM after JS
runs. `shadow` mode additionally defeats a post-hydration `host.textContent`
read on the host, at the cost of less reliable copy on some browsers — prefer
`light` for long prose where copy must always work.

---

## Which to use when

| You have… | Use |
|-----------|-----|
| One static label / string | `<HolyText text=… />` (unchanged) |
| A single-line label that must truncate with `…` | `<HolyText text=… ellipsis />` (§3) |
| Static text mixed with icons, inline links, or `{dynamic}` values | `<HolyRich>…</HolyRich>`, wrapping dynamics in `<HolyDynamic>`/an element (§2) |
| Text in `aria-label` / `title` / `placeholder` / `alt` | `useHolyAttr(...)`, or `<HolyInput>` for inputs (§4) — mind the a11y tradeoff |
| Legal prose that must stay selectable/copyable | `<HolyProse text=… />` (`light`), or `mode="shadow"` to also hide from `textContent` (§5) |

Notes for the page-application wave:
- Per-string ciphertext is unchanged: register strings as today; unregistered
  strings fall back to plaintext-in-shadow/-light-DOM.
- `HolyRich`: wrap every dynamic value you want to remain in `textContent`.
- `useHolyAttr` / `HolyInput`: do not obfuscate the only accessible name of an
  interactive control unless you've accepted the pre-hydration a11y gap.
- `HolyProse`: default to `light`; reach for `shadow` only when a
  `textContent`-reading scraper is in scope and copy reliability is secondary.

## Tests

Pure-logic tests for the shared primitives live in
`src/lib/holy-render.test.mjs` (written as `.mjs` so `tsc --noEmit` does not pull
in `node:test` types). Run:

```sh
cd main && node_modules/.bin/tsx --test src/lib/holy-render.test.mjs
```
