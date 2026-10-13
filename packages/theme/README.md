# @opsidian/theme

Obsidian's default light and dark palette, named after the shadcn/ui token convention.

- `tokens.css`: plain CSS variables on `:root` and `.dark`. No Tailwind needed; the mobile editor bundle uses this.
- `theme.css`: Tailwind v4 entry point. It imports the tokens and maps them into `@theme`, so `bg-background`, `text-muted-foreground`, `border-border` and shadcn/ui components resolve to them.
- `index.ts`: the same values for code that cannot read CSS, such as React Native and the Electron window background.

```css
@import 'tailwindcss';
@import '@opsidian/theme/theme.css';
```

Dark mode is the `dark` class on `<html>`. Beyond the shadcn set there are four extra tokens: `link`, `faint`, `success` and `selection`. `tests/theme.test.ts` fails if the CSS and TypeScript values drift apart.
