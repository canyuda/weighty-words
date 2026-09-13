/**
 * Serialized settings manager.
 *
 * Every mutation goes through a read-modify-write promise queue so concurrent
 * saves can never lose updates; reads are served from a cache invalidated on
 * write. Pure logic (load/save injected) for unit testing.
 */

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function createSettingsStore({ load, save }) {
  let cache = null;
  let queue = Promise.resolve();

  return {
    /** Cached read (loads on first access). */
    get() {
      if (cache === null) cache = load();
      return cache;
    },

    /**
     * Serialized read-modify-write. The mutator receives a deep clone and
     * returns the next state (or mutates in place and returns nothing/it).
     * A throwing mutator aborts THIS update only — the queue keeps running.
     */
    update(mutator) {
      // Chain the work as a thunk: it must not start until the queue settles
      const run = queue.then(async () => {
        const current = clone(this.get());
        const next = (await mutator(current)) || current;
        save(next);
        cache = next;
        return next;
      });
      queue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }
  };
}

module.exports = { createSettingsStore };
