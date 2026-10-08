// The dev tools and the end-to-end tests. The client has its own configuration, in client/, which
// ESLint uses for the files under it instead of this one.
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['client', 'server', 'e2e/test-results', 'e2e/playwright-report']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
])
