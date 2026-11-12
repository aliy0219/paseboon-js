/**
 * Exclusive task queue: one task at a time, in order. Used for the camera so
 * watcher checks, enrolment, "Test camera" and intruder photos never hold it
 * together. A caller may bound how long it waits for its turn (`waitMs`); if
 * the queue is still busy then, it gets `busyValue` and its task never runs.
 */
export function createExclusiveQueue() {
  let tail = Promise.resolve();
  return function enqueue(task, { waitMs = Infinity, busyValue } = {}) {
    let started = false;
    let gaveUp = false;
    const run = async () => {
      if (gaveUp) return busyValue;
      started = true;
      return task();
    };
    const result = tail.then(run, run);
    tail = result.catch(() => {});
    if (!Number.isFinite(waitMs)) return result;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!started) {
          gaveUp = true;
          resolve(busyValue);
        }
      }, waitMs);
      result.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
  };
}
