import test from 'node:test';
import assert from 'node:assert/strict';
import { localModelEnvironment } from './environment.mjs';

test('browser harness enables no model unless explicitly opted into loopback inference', () => {
  assert.deepEqual(localModelEnvironment({ LA_OLLAMA_URL: 'https://external.example', LA_OLLAMA_MODEL: 'ignored' }), { LA_OLLAMA_URL: '', LA_OLLAMA_MODEL: '' });
  assert.deepEqual(localModelEnvironment({ LA_E2E_OLLAMA_URL: 'http://127.0.0.1:11434/', LA_E2E_OLLAMA_MODEL: 'qwen3:0.6b' }), { LA_OLLAMA_URL: 'http://127.0.0.1:11434', LA_OLLAMA_MODEL: 'qwen3:0.6b' });
  assert.deepEqual(localModelEnvironment({ LA_E2E_OLLAMA_URL: 'http://[::1]:11434', LA_E2E_OLLAMA_MODEL: 'model' }), { LA_OLLAMA_URL: 'http://[::1]:11434', LA_OLLAMA_MODEL: 'model' });
});

test('browser harness rejects external or credentialed model origins and partial configuration', () => {
  for (const url of ['https://external.example', 'http://localhost.evil.example', 'http://user:pass@localhost:11434', 'http://127.0.0.1:11434/api', 'http://localhost:11434?key=value', 'http://localhost:11434#secret', 'file:///model']) {
    assert.throws(() => localModelEnvironment({ LA_E2E_OLLAMA_URL: url, LA_E2E_OLLAMA_MODEL: 'model' }), /loopback/);
  }
  assert.throws(() => localModelEnvironment({ LA_E2E_OLLAMA_MODEL: 'model' }), /both/);
  assert.throws(() => localModelEnvironment({ LA_E2E_OLLAMA_URL: 'http://localhost:11434' }), /both/);
});
