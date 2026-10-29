# Retained T3 frontend source

Source: `pingdotgg/t3code`, revision `975b3dc56850d8a22dc90462219e53be95d8dcf7`, MIT, Copyright (c) 2026 T3 Tools Inc. The repository LICENSE applies to this retained and adapted code.

Copied from `apps/web/src/`:

- `components/T3Wordmark.tsx` and `textDirection.ts` — unchanged.
- `components/ui/button.tsx`, `input.tsx`, `textarea.tsx`, `badge.tsx`, `separator.tsx`, `label.tsx`, `kbd.tsx` — retained T3 primitives, with local import paths replacing aliases. No provider/account/runtime state was imported. The unused native-input/style-forwarding branch was removed from Input.
- `components/ui/dialog.tsx` — adapted T3 popup/header/footer/control composition to native HTML dialog with CSS-only scrolling. This preserves modal focus behavior without Base UI dialog/scroll-area injected style attributes, so the strict CSP need not permit inline styling.
- `lib/utils.ts` — retained the `cn` class merger only, without contracts, Effect, platform and composer-state imports.
- `index.css` — adapted its compact geometry, semantic theme mappings, light/dark zinc/black palette, composer treatment, font stacks and control variables into `src/styles.css`. Clerk, remote/mobile/preview themes and grain SVGs were excluded. Fonts use the system stack.

The new local composition keeps T3's grouped project/sidebar conversations, 52px workspace bar, centered 46rem chat column, compact controls, composer and local file/diff pane. It uses the retained primitives rather than copying the upstream environment/provider/cloud orchestration. `ChatView`, `Sidebar` and `ChatMarkdown` were not imported because their implementation couples to removed provider, hosted-account, PR, preview and asset services.

Message rendering accepts plain escaped text, headings, inline code and fenced code. It creates no HTML, image, media, CSS, external link or embed nodes from transcript content. File and diff content remains escaped selectable text. No URL preview, remote font, favicon, account UI, theme download, pricing lookup, update poll or background model call is implemented.

Original lock-resolved frontend versions: React/React DOM `19.3.0`, Base UI `1.5.0`, class-variance-authority `0.7.1`, tailwind-merge `3.6.0`, lucide-react `0.564.0`, Tailwind `4.3.3`. The maintained fork's root lockfile records its actual install graph.
