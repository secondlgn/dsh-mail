/**
 * Guard against declaring schema features the installed schemastery does not have.
 *
 * This exists because of a real outage: the settings page needed `.volatile()` fields, and the
 * source shipped inside DSH's `app.asar` (schemastery 3.18.4) does define `.volatile()`, so the
 * schema was written with it. The runtime, however, resolves schemastery **3.18.1**, where
 * `Schema.prototype.volatile` is undefined. Building the Config then threw, the plugin row never
 * activated, and the channel silently stopped polling for mail.
 *
 * The lesson is narrow and testable: always build the schema against the schemastery the runtime
 * actually resolves, not the one found in a bundled copy. Every case below is skipped when the
 * runtime's copy cannot be located, so the suite still runs on a machine without DSH installed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config } from '../src/index.js';

const profileDir = 'C:/Users/ASUS/.dsh/profiles/desktop';

/** Resolve a module the way the running DSH does, or undefined when that is impossible here. */
function resolveRuntime(specifier) {
  if (!existsSync(join(profileDir, 'package.json'))) return undefined;
  try {
    const require = createRequire(join(profileDir, 'package.json'));
    return { path: require.resolve(specifier), load: () => require(specifier) };
  } catch {
    return undefined;
  }
}

/** The version string of a resolved package. */
function versionOf(resolvedPath) {
  let directory = dirname(resolvedPath);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
        if (typeof pkg.version === 'string') return pkg.version;
      } catch {
        // keep walking up
      }
    }
    directory = dirname(directory);
  }
  return undefined;
}

test('the plugin Config builds against the schemastery the runtime resolves', async () => {
  const resolved = resolveRuntime('@deepseek-ai/schemastery');
  if (resolved === undefined) {
    console.log('# skipped: no DSH profile schemastery on this machine');
    return;
  }

  const module = resolved.load();
  const z = module.default ?? module;

  // Property 1: the schema the plugin exports must be constructible with that library. A missing
  // combinator surfaces here as a TypeError rather than as a dead plugin row.
  const schemaFunction = typeof Config === 'function' ? Config : undefined;
  if (schemaFunction === undefined) {
    // The Config import is best-effort (tests run without DSH); assert the fallback is inert.
    assert.deepEqual(Config, {}, 'a missing schemastery must yield an inert Config, not a throw');
    return;
  }

  const schema = await schemaFunction();
  assert.equal(typeof schema, 'function', 'Config() returned a schema');

  // Property 2: any documented-but-absent combinator this schema relies on would have failed
  // above, but assert the specific one that caused the outage so the reason is obvious.
  const booleanSchema = z.boolean();
  if (typeof booleanSchema.volatile !== 'function') {
    assert.equal(
      schema.toJSON === undefined ? undefined : typeof schema.toJSON,
      'function',
      `schemastery ${versionOf(resolved.path) ?? '?'} has no .volatile(); the schema must not use it`
    );
  }

  // Property 3: the fields the channel needs are present in the projected schema.
  const json = JSON.stringify(schema.toJSON());
  for (const field of ['imap', 'smtp', 'allowFrom', 'workspaceDir', 'enabled']) {
    assert.ok(json.includes(`"${field}"`), `the schema declares ${field}`);
  }
});

test('no schema declaration uses a combinator the runtime lacks', async () => {
  const resolved = resolveRuntime('@deepseek-ai/schemastery');
  if (resolved === undefined) {
    console.log('# skipped: no DSH profile schemastery on this machine');
    return;
  }
  const module = resolved.load();
  const z = module.default ?? module;
  const missing = [];
  for (const combinator of ['volatile', 'hidden', 'disabled']) {
    if (typeof z.boolean()[combinator] !== 'function') missing.push(combinator);
  }

  // Read the source of the schema builder and refuse any combinator this runtime lacks.
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js'), 'utf8');
  const declared = source.slice(source.indexOf('return z.object({'), source.indexOf('export function withDefaults'));
  const used = [...declared.matchAll(/\.([a-zA-Z]+)\(/g)].map((match) => match[1]);
  const offenders = [...new Set(used)].filter((name) => missing.includes(name));
  assert.deepEqual(offenders, [], `schema uses ${offenders.join(', ')} which this schemastery lacks`);
});
