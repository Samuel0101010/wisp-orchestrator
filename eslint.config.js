import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.vite/**',
      '**/build/**',
      '**/coverage/**',
      '.claude/skills/**',
      '.claude/worktrees/**',
      '**/*.cjs',
      'audit-artifacts/**',
      'marketing/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // One-off screenshot capture script: the `page.addInitScript` callback
    // body runs inside the browser context (window/document/localStorage),
    // so it needs the browser globals alongside the node ones.
    files: ['scripts/capture-screenshots.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  prettier,
];
