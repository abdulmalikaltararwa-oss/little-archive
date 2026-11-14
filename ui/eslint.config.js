import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'test-results', 'playwright-report'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2023, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        // Text from a saved post is untrusted. It is only ever rendered as text.
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Render untrusted text as text. Raw HTML is never inserted.' },
      ],
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Go through the data layer (src/data) so the request reaches the right backend.' }],
    },
  },
  {
    // The three backends are the only code that may name a network primitive.
    files: ['src/data/backends/**', 'src/**/*.test.{ts,tsx}', 'e2e/**', 'vite.config.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // The provider and the hooks that read it belong together.
    files: ['src/app/archive-context.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    // Vendored component sources keep their upstream shape.
    files: ['src/components/ui/**', 'src/components/fx/**'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
);
