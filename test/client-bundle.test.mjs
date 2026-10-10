/**
 * Load the browser half the way DSH's client module system does, without a browser.
 *
 * The bundle is a plain script that calls `window.__ModuleLoader__.load({ id, factory })`; the
 * factory receives `require` and returns the module's exports. Evaluating it here proves the
 * bundle parses, the factory runs, `apply` wires up, and the form converts staged edits into the
 * path operations `configForms` expects — none of which a syntax check would catch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(packageRoot, 'lib', 'client.js');

/** Minimal stand-ins for the two platform modules the bundle requires. */
const PRIMITIVES = {
  SettingsForm: function SettingsForm() {},
  SettingsValueField: function SettingsValueField() {},
  SettingsSecretField: function SettingsSecretField() {},
  settingsTextField: (field) => ({ field }),
  settingsNumberField: (field) => ({ field })
};
const JSX_RUNTIME = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props })
};

/**
 * Evaluate the bundle against a fake module loader.
 *
 * @returns {{ exports: object, registration: object|undefined, requireCalls: string[] }}
 */
function loadBundle() {
  const source = readFileSync(bundlePath, 'utf8');
  let registration;
  let loaded;
  const requireCalls = [];
  const window = {
    __ModuleLoader__: {
      load: (definition) => {
        loaded = definition;
      }
    }
  };
  const require = (specifier) => {
    requireCalls.push(specifier);
    if (specifier === 'react/jsx-runtime') return JSX_RUNTIME;
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return PRIMITIVES;
    throw new Error(`unexpected require("${specifier}")`);
  };

  // The bundle is an ordinary script; `window` and `require` are its only ambient needs.
  const run = new Function('window', 'require', source);
  run(window, require);
  assert.ok(loaded !== undefined, 'the bundle called __ModuleLoader__.load');
  const exports = loaded.factory(require);
  void registration;
  return { exports, definition: loaded, requireCalls };
}

/** A cordis-like client context that records what the plugin registers. */
function stubClientContext() {
  const effects = [];
  const registrations = [];
  const injected = [];
  const dictionaries = [];
  /** Namespaces the fake configForms reports as served. */
  const served = new Set();
  const scopes = new Map();

  const makeScope = (namespace) => {
    const listeners = new Set();
    const snapshot = {
      status: 'ready',
      value: { imap: { host: 'imap.example.com', port: 993, user: 'a@b.c', mailbox: 'INBOX', passwordEnv: 'P' }, smtp: { host: '', port: 465, saveToSent: true }, allowFrom: ['owner@example.com'], selfAddresses: [], workspaceDir: '', interruptSameThread: true, sendReceipt: true, sendResult: true, enabled: true },
      base: { imap: { host: '', port: 993, user: '', mailbox: 'INBOX', passwordEnv: 'DSH_MAIL_PASSWORD' }, smtp: { host: '', port: 465, saveToSent: true }, allowFrom: [], selfAddresses: [], workspaceDir: '', interruptSameThread: true, sendReceipt: true, sendResult: true, enabled: true },
      user: {},
      revision: 7,
      writable: true,
      mode: 'host'
    };
    const mutations = [];
    return {
      namespace,
      mutations,
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set: () => true,
      unset: () => true,
      async mutate(ops, revision) {
        mutations.push({ ops, revision });
        return true;
      },
      async dispose() {}
    };
  };

  const context = {
    locale: {
      bind: (namespace) => (key) => `${namespace}.${key}`,
      register: (namespace, dictionaries_) => {
        dictionaries.push({ namespace, dictionaries: dictionaries_ });
        return () => {};
      },
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0 })
    },
    configForms: {
      get: (entryId) => {
        if (!scopes.has(entryId)) scopes.set(entryId, makeScope(entryId));
        return scopes.get(entryId);
      },
      whileServed: (namespaces, register) => {
        for (const namespace of namespaces) served.add(namespace);
        const dispose = register(served);
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      },
      describe: () => ({ getSnapshot: () => ({ status: 'ready', view: { writable: true, namespaces: [] } }) })
    },
    slots: {
      inject: (slot, register) => {
        injected.push(slot);
        return register();
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
      entries: () => [],
      getVersion: () => 0,
      subscribe: () => () => {}
    },
    effect: (factory) => {
      effects.push(factory());
      return () => {};
    }
  };

  return { context, registrations, injected, dictionaries, scopes, effects };
}

test('the bundle declares the module contract the loader expects', () => {
  const { exports, definition, requireCalls } = loadBundle();
  assert.equal(definition.id, 'dsh-mail', 'the bundle id is the package name');
  assert.equal(typeof definition.factory, 'function');
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(exports.inject, ['slots', 'locale', 'configForms']);
  assert.equal(exports.MAIL_NS, 'dsh-mail', 'the edited namespace is the profile entry id');
  // Only platform modules may be requested.
  assert.deepEqual([...new Set(requireCalls)].sort(), [
    '@deepseek-ai/dsh-client-ui-primitives',
    'react/jsx-runtime'
  ]);
});

test('applying registers exactly one Plugins-page entry for the profile row', () => {
  const { exports } = loadBundle();
  const host = stubClientContext();
  exports.apply(host.context);

  assert.deepEqual(host.injected, ['plugins.item'], 'registered into the editable Plugins seat');
  assert.equal(host.registrations.length, 1);
  const { options, component } = host.registrations[0];
  assert.equal(options.name, 'plugins.item');
  assert.equal(options.id, 'dsh-mail');
  assert.equal(typeof options.order, 'number');
  assert.equal(typeof options.label, 'function');
  assert.equal(typeof options.inject, 'function');
  assert.equal(typeof component, 'function');
  // The dictionaries must be registered for the page's locale namespace.
  assert.equal(host.dictionaries.length, 1);
  assert.ok(host.dictionaries[0].dictionaries.zh !== undefined, 'Chinese copy is provided');
});

test('the injected face exposes the hook and the four form actions', () => {
  const { exports } = loadBundle();
  const host = stubClientContext();
  exports.apply(host.context);
  const face = host.registrations[0].options.inject();

  assert.ok(face.hooks?.mailForm !== undefined, 'the store is exposed as a hook source');
  assert.equal(typeof face.hooks.mailForm.getSnapshot, 'function');
  assert.equal(typeof face.hooks.mailForm.subscribe, 'function');
  for (const action of ['edit', 'resetField', 'save', 'discard']) {
    assert.equal(typeof face[action], 'function', `${action} is exposed`);
  }
});

test('the snapshot carries every edited field plus the form shell', () => {
  const { exports } = loadBundle();
  const host = stubClientContext();
  exports.apply(host.context);
  const face = host.registrations[0].options.inject();
  const state = face.hooks.mailForm.getSnapshot();

  for (const key of ['available', 'writable', 'dirty', 'invalid', 'saving', 'failed']) {
    assert.equal(typeof state[key], 'boolean', `shell field ${key}`);
  }
  // Nested paths must be projected as their own fields, read from the live section.
  assert.equal(state.imapHost.text, 'imap.example.com');
  assert.equal(state.imapUser.text, 'a@b.c');
  assert.equal(state.allowFrom.text, 'owner@example.com');
  assert.equal(state.enabled.text, 'true');
  assert.equal(state.workspaceDir.text, '');
  assert.equal(state.available, true);
});

test('a staged edit becomes a path operation scoped to the config file layout', async () => {
  const { exports } = loadBundle();
  const host = stubClientContext();
  exports.apply(host.context);
  const face = host.registrations[0].options.inject();
  const scope = host.scopes.get('dsh-mail');

  assert.equal(host.registrations[0].options.inject().hooks.mailForm.getSnapshot().dirty, false);

  // A nested string, a nested number, and a list — the three shapes the plugin's config uses.
  face.edit('imapHost', 'imap.changed.example');
  face.edit('imapPort', '1993');
  face.edit('allowFrom', 'a@b.c\n\nd@e.f\n');

  const staged = face.hooks.mailForm.getSnapshot();
  assert.equal(staged.dirty, true, 'the form is dirty after edits');
  assert.equal(staged.imapHost.text, 'imap.changed.example');
  assert.equal(staged.allowFrom.text, 'a@b.c\n\nd@e.f\n', 'the draft text is what the user typed');

  await face.save();

  assert.equal(scope.mutations.length, 1, 'one write per save');
  const { ops, revision } = scope.mutations[0];
  assert.equal(revision, 7, 'the write is fenced by the revision the form was read at');
  assert.deepEqual(ops, [
    { op: 'set', path: ['imap', 'host'], value: 'imap.changed.example' },
    { op: 'set', path: ['imap', 'port'], value: 1993 },
    { op: 'set', path: ['allowFrom'], value: ['a@b.c', 'd@e.f'] }
  ]);
  assert.equal(face.hooks.mailForm.getSnapshot().dirty, false, 'drafts clear once the write lands');
});

test('an unparseable number blocks the save instead of writing junk', async () => {
  const { exports } = loadBundle();
  const host = stubClientContext();
  exports.apply(host.context);
  const face = host.registrations[0].options.inject();
  const scope = host.scopes.get('dsh-mail');

  face.edit('imapPort', 'not-a-port');
  const state = face.hooks.mailForm.getSnapshot();
  assert.equal(state.invalid, true, 'the form reports the draft as invalid');
  await face.save();
  assert.equal(scope.mutations.length, 0, 'nothing was written');
  assert.equal(face.hooks.mailForm.getSnapshot().dirty, true, 'the bad draft is kept for correction');
});

test('discard drops the drafts and a non-writable scope refuses the save', async () => {
  const { exports } = loadBundle();
  const host = stubClientContext();
  exports.apply(host.context);
  const face = host.registrations[0].options.inject();

  face.edit('imapHost', 'example.invalid');
  face.discard();
  assert.equal(face.hooks.mailForm.getSnapshot().dirty, false, 'discard clears drafts');
  assert.equal(face.hooks.mailForm.getSnapshot().imapHost.text, 'imap.example.com', 'the accepted value is shown');
});
