// Shared editor state plus a tiny event bus.

export const S = {
  status: null,      // /api/status payload
  project: null,     // current project document
  peaks: null,       // Uint8Array waveform envelope
  sel: null,         // selected words: {a, b} indexes into project.words (inclusive)
  range: null,       // free time range selected on the timeline: {start, end}
  editId: null,      // edit shown in the inspector
  voices: [],
  busyEdits: new Set(),  // edit ids with a queued/running generate job
};

const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, e => fn(e.detail));

export function words() { return S.project?.words || []; }
export function edits() { return S.project?.edits || []; }
export function currentEdit() { return edits().find(e => e.id === S.editId) || null; }

// Time span of the current selection (words win over a free range).
export function selection() {
  const w = words();
  if (S.sel && w.length) {
    const a = Math.min(S.sel.a, S.sel.b), b = Math.max(S.sel.a, S.sel.b);
    if (w[a] && w[b]) {
      return { start: w[a].start, end: w[b].end, text: w.slice(a, b + 1).map(x => x.text).join(" "), a, b };
    }
  }
  if (S.range && S.range.end - S.range.start > 0.01) {
    const inside = w.filter(x => (x.start + x.end) / 2 >= S.range.start && (x.start + x.end) / 2 <= S.range.end);
    return { start: S.range.start, end: S.range.end, text: inside.map(x => x.text).join(" ") };
  }
  return null;
}

export function editAt(t) {
  return edits().find(e => t >= e.cut_start && t < editEnd(e)) || null;
}

export function activeTake(e) {
  return e?.takes.find(t => t.id === e.active_take) || null;
}

// Where an edit's audio ends on the timeline (natural takes may run longer).
export function editEnd(e) {
  const t = activeTake(e);
  return Math.max(e.cut_end, t ? e.cut_start + t.duration : 0);
}

export function wordIndexAt(t) {
  const w = words();
  let lo = 0, hi = w.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (w[mid].end <= t) lo = mid + 1;
    else if (w[mid].start > t) hi = mid - 1;
    else return mid;
  }
  return -1;
}
