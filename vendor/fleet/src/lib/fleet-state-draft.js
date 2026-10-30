'use strict';

// Copy only edited branches of Fleet's JSON control state. Frozen committed
// records can be shared and serialized once by the transactional tree store.
// Drafts never escape as committed data; a thrown edit leaves the base intact.
const immutable = new WeakSet();
const isImmutable = value => value !== null && typeof value === 'object' && immutable.has(value);
const keyShapes = new WeakMap();
// Weak ancestry must not retain every historical version of a growing list.
// A collected/interrupted lineage simply falls back to a complete traversal.
const edits = new WeakMap();
function changedKeys(value, base) {
  if (!isImmutable(value) || !isImmutable(base)) return null;
  const keys = new Set();
  while (value !== base) {
    const edit = edits.get(value);
    if (!edit) return null;
    for (const key of edit.keys) keys.add(key);
    value = edit.base.deref();
    if (!value) return null;
  }
  return keys;
}
function orderedKeys(value) {
  if (!isImmutable(value)) return Object.keys(value);
  if (!keyShapes.has(value)) {
    const keys = Object.freeze(Object.keys(value));
    immutable.add(keys); keyShapes.set(value, keys);
  }
  return keyShapes.get(value);
}
function produce(base, edit) {
  const drafts = new WeakMap();
  let closed = false;
  const object = value => value !== null && typeof value === 'object';
  function draft(value) {
    const state = { base: value, copy: null, children: new Map(), touched: new Set() };
    const current = () => state.copy || state.base;
    const mutable = () => {
      if (closed) throw new Error('A committed Fleet state draft cannot be edited.');
      return state.copy ||= Array.isArray(value) ? value.slice() : { ...value };
    };
    const proxy = new Proxy(Array.isArray(value) ? [] : {}, {
      get(_target, key) {
        const item = Reflect.get(current(), key);
        if (!object(item)) return item;
        if (drafts.has(item)) return item;
        let child = state.children.get(key);
        if (!child || child.base !== item) { child = { base: item, proxy: draft(item) }; state.children.set(key, child); }
        return child.proxy;
      },
      set(_target, key, item) {
        if (closed) mutable();
        if (!Object.is(current()[key], item) || !Object.hasOwn(current(), key)) {
          const previousLength = Array.isArray(value) && key === 'length' ? current().length : null;
          Object.defineProperty(mutable(), key, { value: item, enumerable: key !== 'length', configurable: key !== 'length', writable: true });
          if (previousLength !== null) for (let n = current().length; n < previousLength; n++) {
            state.touched.add(String(n)); state.children.delete(String(n));
          }
          state.touched.add(key);
          state.children.delete(key);
        }
        return true;
      },
      deleteProperty(_target, key) { if (closed) mutable(); if (Object.hasOwn(current(), key)) { delete mutable()[key]; state.children.delete(key); state.touched.add(key); } return true; },
      ownKeys: () => Reflect.ownKeys(current()),
      has: (_target, key) => key in current(),
      getOwnPropertyDescriptor(_target, key) {
        const descriptor = Object.getOwnPropertyDescriptor(current(), key);
        return descriptor && { value: current()[key], enumerable: descriptor.enumerable, configurable: key !== 'length', writable: true };
      },
      setPrototypeOf() { throw new Error('Fleet state contains JSON records, not prototype changes.'); },
      defineProperty() { throw new Error('Use ordinary JSON property assignment in Fleet state edits.'); }
    });
    drafts.set(proxy, state);
    return proxy;
  }
  const finalized = new WeakMap();
  const visiting = new WeakSet();
  function finish(value) {
    if (!object(value)) return value;
    if (visiting.has(value)) throw new Error('Fleet state must not contain cycles.');
    if (finalized.has(value)) return finalized.get(value);
    const state = drafts.get(value);
    if (state) {
      let result = state.copy || state.base;
      for (const [key, child] of state.children) {
        const next = finish(child.proxy);
        if (next !== result[key]) {
          if (result === state.base) result = Array.isArray(result) ? result.slice() : { ...result };
          Object.defineProperty(result, key, { value: next, enumerable: true, configurable: true, writable: true });
          state.touched.add(key);
        }
      }
      let output;
      if (result !== state.base && Array.isArray(result) && isImmutable(state.base)) {
        // Untouched entries came from our own deeply immutable base. Rewalking
        // all retained history for one append adds quadratic work over a run.
        // New/replaced entries may contain drafts or external mutable values,
        // so finalize each touched entry before marking the array immutable.
        visiting.add(value); visiting.add(result);
        for (const key of state.touched) if (key !== 'length' && Object.hasOwn(result, key)) {
          const next = finish(result[key]);
          if (next !== result[key]) Object.defineProperty(result, key, { value: next, enumerable: true, configurable: true, writable: true });
        }
        visiting.delete(value); visiting.delete(result);
        Object.freeze(result); immutable.add(result); finalized.set(result, result);
        output = result;
      } else output = finish(result);
      if (output !== state.base && Array.isArray(output) && isImmutable(state.base)) edits.set(output, { base: new WeakRef(state.base), keys: state.touched });
      // A value edit does not change map membership or insertion order. Retain
      // its immutable key vector so persistence need not serialize every ID.
      if (output !== state.base && !Array.isArray(output) && keyShapes.has(state.base)) {
        const oldKeys = orderedKeys(state.base), nextKeys = orderedKeys(output);
        if (oldKeys.length === nextKeys.length && oldKeys.every((key, index) => key === nextKeys[index])) keyShapes.set(output, oldKeys);
      }
      finalized.set(value, output);
      return output;
    }
    if (isImmutable(value)) return value;
    visiting.add(value);
    let result = value;
    for (const key of Object.keys(value)) {
      const next = finish(value[key]);
      if (next !== value[key]) {
        if (result === value) result = Array.isArray(value) ? value.slice() : { ...value };
        Object.defineProperty(result, key, { value: next, enumerable: true, configurable: true, writable: true });
      }
    }
    visiting.delete(value);
    Object.freeze(result); immutable.add(result); finalized.set(value, result);
    return result;
  }
  const root = draft(base);
  try { edit(root); return finish(root); }
  finally { closed = true; }
}
module.exports = { produce, isImmutable, orderedKeys, changedKeys };
