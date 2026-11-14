// Test-only: loaded into the server through NODE_OPTIONS=--import. Replaces the openai package, so
// no network call can happen. Every request is appended to <OPENAI_STUB_DIR>/calls.jsonl, and the
// test picks the result by writing <OPENAI_STUB_DIR>/behavior.json: { outputText } or { error }.
import { register } from 'node:module';

const toDataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

const STUB_URL = toDataUrl(`
  import fs from 'node:fs';
  import path from 'node:path';

  const stubFile = (name) => path.join(process.env.OPENAI_STUB_DIR, name);

  export default class OpenAI {
    constructor({ timeout, maxRetries }) {
      fs.appendFileSync(stubFile('clients.jsonl'), JSON.stringify({ timeout, maxRetries }) + '\\n');
    }

    responses = {
      create: async (params) => {
        fs.appendFileSync(stubFile('calls.jsonl'), JSON.stringify(params) + '\\n');
        const { outputText, error } = JSON.parse(fs.readFileSync(stubFile('behavior.json'), 'utf8'));
        if (error) {
          // The SDK's errors differ by class, and their name property stays 'Error'.
          const { className = 'Error', ...fields } = error;
          const ErrorClass = { [className]: class extends Error {} }[className];
          throw Object.assign(new ErrorClass(fields.message), fields);
        }
        return { output_text: outputText };
      },
    };
  }
`);

if (process.env.NODE_ENV !== 'test') throw new Error('openai stub is test-only');

register(toDataUrl(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'openai') return { url: ${JSON.stringify(STUB_URL)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));
