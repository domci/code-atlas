// Worker: dot products of rows start, start+step, … against all later rows of a shared unit-vector matrix.
declare const self: Worker;

export type Job = { flat: SharedArrayBuffer; n: number; dim: number; start: number; step: number; min: number };

self.onmessage = (e: MessageEvent<Job>) => {
  const { flat, n, dim, start, step, min } = e.data;
  const m = new Float32Array(flat);
  const out: number[] = [];
  for (let i = start; i < n; i += step) {
    const a = i * dim;
    for (let j = i + 1; j < n; j++) {
      const b = j * dim;
      let s = 0;
      for (let k = 0; k < dim; k++) s += m[a + k]! * m[b + k]!;
      if (s >= min) out.push(i, j, s);
    }
  }
  self.postMessage(out);
};
