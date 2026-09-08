import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

function deepMerge(base, over) {
  if (Array.isArray(over)) return over;
  if (over && typeof over === 'object') {
    const out = { ...(base || {}) };
    for (const k of Object.keys(over)) out[k] = deepMerge(base ? base[k] : undefined, over[k]);
    return out;
  }
  return over === undefined ? base : over;
}

function load() {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const file = process.env.QUALITY_CONFIG || path.join(ROOT, 'config.json');
  let user = {};
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = deepMerge(example, user);
  cfg._file = file;

  // env overrides for secrets
  if (process.env.GATEWAY_API_KEY) cfg.gateway.api_key = process.env.GATEWAY_API_KEY;
  if (process.env.STT_API_KEY) cfg.stt.api_key = process.env.STT_API_KEY;
  if (process.env.LLM_API_KEY) cfg.llm.api_key = process.env.LLM_API_KEY;
  if (process.env.ANTHROPIC_API_KEY && !cfg.llm.api_key) cfg.llm.api_key = process.env.ANTHROPIC_API_KEY;
  if (process.env.PORT) cfg.server.port = Number(process.env.PORT);

  cfg.db.path = path.resolve(ROOT, cfg.db.path);
  if (cfg.gateway.ca_file) cfg.gateway.ca_file = path.resolve(ROOT, cfg.gateway.ca_file);
  return cfg;
}

export const config = load();

export function saveConfigPatch(patch) {
  // persist a partial update into config.json (used by the admin UI for provider settings)
  const file = config._file;
  let user = {};
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'));
  const merged = deepMerge(user, patch);
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
  Object.assign(config, deepMerge(config, patch));
}
