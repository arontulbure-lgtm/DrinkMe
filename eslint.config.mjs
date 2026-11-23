import { FlatCompat } from '@eslint/eslintrc';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: false,
  allConfig: false,
});

export default [
  {
    ignores: ['server/**'],
  },
  ...compat.config({
    extends: ['expo'],
  }),
  {
    // eslint-config-expo 56 turns on the React Compiler rules of eslint-plugin-react-hooks 7 as errors. The app
    // does not use the React Compiler, and these spots are valid React (form reset when a modal opens, a
    // ref read for an animation value). Warnings keep them visible; refactor post-launch (docs/DEPENDENCY_PLAN.md).
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
];
