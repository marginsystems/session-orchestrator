import js from '@eslint/js';
import globals from 'globals';

const DIRECTIVE = /^\s*(?:eslint-disable|eslint-enable|eslint(?:\s|$)|global\s|globals\s|exported\s|@ts-check|@ts-nocheck|@ts-expect-error|@ts-ignore)/;

const noComments = {
  meta: { type: 'problem', schema: [], messages: { comment: 'Comments are not allowed; use names, types and tests.' } },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          if (comment.type === 'Shebang') continue;
          if (DIRECTIVE.test(comment.value)) continue;
          context.report({ loc: comment.loc, messageId: 'comment' });
        }
      },
    };
  },
};

const local = { rules: { 'no-comments': noComments } };

const sharedRules = {
  eqeqeq: 'error',
  'no-var': 'error',
  'prefer-const': 'error',
  'no-unused-vars': 'error',
  'no-shadow': 'error',
  'no-implicit-globals': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  curly: 'off',
};

export default [
  { ignores: ['node_modules/**', 'index.html'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
    rules: sharedRules,
  },
  {
    files: ['scan.mjs', 'lib/**/*.mjs', 'test/**/*.mjs', 'scripts/**/*.mjs', 'eslint.config.js'],
    plugins: { local },
    rules: { 'local/no-comments': 'error' },
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['scan.mjs', 'lib/**/*.mjs', 'scripts/**/*.mjs'],
    rules: { 'max-lines': ['error', { max: 800, skipBlankLines: true }] },
  },
];
