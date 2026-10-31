// URBANO Gaming — Halloween Community Voting: the public display's rotation.
//
// The display exists for EXPOSURE: every approved contestant is shown once per pass, in a fresh random order, and the rotation
// carries nothing but an opaque number and a picture. It receives no count, rank or total from the server, so it could not show
// standing even by mistake.

const CommunityVotingSlideshow = (() => {
  function shuffle(list, random) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function createRotation(randomSource) {
    const random = typeof randomSource === "function" ? randomSource : Math.random;
    let loaded = [];
    let queue = [];
    let shown = new Set();
    let passSize = 0;
    let lastShown = null;

    function startPass() {
      if (loaded.length === 0) {
        queue = [];
        shown = new Set();
        passSize = 0;
        return;
      }
      queue = shuffle(loaded, random);
      // never show the picture that closed the previous pass first in the next one
      if (queue.length > 1 && queue[0].alias === lastShown) {
        const last = queue.length - 1;
        [queue[0], queue[last]] = [queue[last], queue[0]];
      }
      shown = new Set();
      passSize = loaded.length;
    }

    return {
      /**
       * Replaces the list of approved contestants. Mid-pass, a contestant who is no longer listed (withdrawn) is dropped from the
       * pending queue at once and a newly approved one is added to it; between passes the new list simply starts the next pass.
       */
      load(items) {
        loaded = Array.isArray(items) ? items.filter((i) => i && typeof i.alias === "string") : [];
        const listed = new Set(loaded.map((i) => i.alias));
        if (queue.length === 0) {
          startPass();
          return;
        }
        queue = queue.filter((q) => listed.has(q.alias));
        const queued = new Set(queue.map((q) => q.alias));
        for (const item of loaded) {
          if (!shown.has(item.alias) && !queued.has(item.alias)) queue.splice(Math.floor(random() * (queue.length + 1)), 0, item);
        }
        passSize = loaded.length;
      },
      next() {
        if (queue.length === 0) startPass();
        const item = queue.shift() || null;
        if (item) {
          lastShown = item.alias;
          shown.add(item.alias);
        }
        return item;
      },
      peek: () => queue[0] || null,
      /** True when the current pass is finished: the page should fetch the list again (and keeps cycling the last list if that fails). */
      needsRefresh: () => queue.length === 0 && loaded.length > 0,
      passSize: () => passSize,
    };
  }

  return { createRotation };
})();
