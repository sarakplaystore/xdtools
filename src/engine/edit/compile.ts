/**
 * Edit compiler: turns "this line should now read …" into precise changes to
 * a page's content stream.
 *
 * The approach is surgical. Only the text-showing operators that draw changed
 * (or displaced) glyphs are rewritten; each rewritten operator restores the
 * text state it leaves behind, so every other byte of the page — graphics,
 * images, untouched text — stays exactly as it was. Unchanged glyphs keep
 * their original embedded font; only new text is shaped and drawn afresh.
 */
import type { LoadedFont } from '../font/hb';
import type { FontMatch } from '../font/match';
import type { Cluster, GlyphRef, Line } from '../model';
import type { PdfFont } from '../pdf/fonts';
import type { GlyphElem, MarkedSpan, RGB, Scope, ShowOp } from '../pdf/interp';
import { PDict, PName, serialize } from '../pdf/lexer';
import { Mat, apply, applyLinear, fmt, fmtMat, hex, invert, mul, translate, utf16beHex } from '../util';
import { CascadeItem, LayoutEnv, OutSegment, attachesBackward, joinsForward, layoutText } from './layout';

export interface LineStyle {
  /** New fill colour (0–1 RGB). */
  color?: RGB;
  /** Size multiplier relative to the original. */
  scale?: number;
  /** Draw the whole line with this font instead of the matched one. */
  font?: { font: LoadedFont; label: string };
}

export interface LineEdit {
  text: string;
  style?: LineStyle;
  /**
   * Which point of the line stays put when its length changes:
   * 0 = start (default), 0.5 = centre, 1 = end.
   */
  align?: number;
}

export interface TextBox {
  id: string;
  /** Baseline start in PDF user space. */
  x: number;
  y: number;
  /** Unit direction of the baseline in user space (handles rotated pages). */
  dir: [number, number];
  text: string;
  font: LoadedFont;
  fontLabel: string;
  size: number;
  color: RGB;
}

export interface CompileEnv extends LayoutEnv {
  matchOf(font: PdfFont): FontMatch | null;
  /** Pre-loaded last-resort fonts (Khmer first, then Latin). */
  fallbacks: { font: LoadedFont; label: string }[];
}

export interface LineOutcome {
  /** New pen length of the line. */
  length: number;
  /** How far the line's start moved along its baseline (non-zero for centred / end-anchored edits). */
  offset: number;
  /** How the new text was drawn. */
  via: OutSegment['via'][];
  fonts: string[];
  missing: string[];
}

export interface Replacement {
  start: number;
  end: number;
  text: string;
}

export interface PagePlan {
  /** Byte-range replacements, per content stream (page contents or a form it draws). */
  replacements: Map<Scope, Replacement[]>;
  /** Content appended after the page's own stream (added text boxes). */
  append: string;
  outcomes: Map<string, LineOutcome>;
  /** Font resource names each stream now needs. */
  fontsUsed: Map<Scope, Set<string>>;
  /** Fonts needed by `append`. */
  appendFonts: Set<string>;
}

type Status = 'remove' | { v: [number, number] } | undefined;

interface Injection {
  /** Element index in the show operator in front of which the new text goes. */
  at: number;
  /** Baseline start in user space. */
  point: [number, number];
  segments: OutSegment[];
  color?: RGB;
  scale: number;
}

const colorOps = (c: RGB) => `${fmt(c[0], 4)} ${fmt(c[1], 4)} ${fmt(c[2], 4)} rg`;

/** Emits one laid-out segment as TJ operators, with rise changes and ActualText spans. */
function emitSegment(seg: OutSegment, size: number, baseRise: number): string {
  let code = '';
  let items = '';
  let run = '';
  let vpen = 0;
  let pen = 0;
  let rise = 0;
  const flushRun = () => {
    if (run) {
      items += `<${run}>`;
      run = '';
    }
  };
  const flush = () => {
    flushRun();
    if (items) {
      code += `[${items}] TJ\n`;
      items = '';
    }
  };
  let si = 0;
  for (let i = 0; i < seg.glyphs.length; i++) {
    const g = seg.glyphs[i];
    if (si < seg.spans.length && seg.spans[si].from === i) {
      flush();
      code += `/Span <</ActualText <${utf16beHex(seg.spans[si].text, true)}>>> BDC\n`;
    }
    if (Math.abs(g.dy - rise) > 0.001) {
      flush();
      rise = g.dy;
      code += `${fmt(baseRise + (rise / 1000) * size, 4)} Ts\n`;
    }
    const target = pen + g.dx;
    const k = target - vpen;
    if (Math.abs(k) > 0.005) {
      flushRun();
      items += `${fmt(-k, 3)}`;
    }
    run += hex(g.bytes);
    vpen = target + g.nat;
    pen += g.adv;
    if (si < seg.spans.length && seg.spans[si].to === i + 1) {
      flush();
      code += 'EMC\n';
      si++;
    }
  }
  flush();
  if (Math.abs(rise) > 0.001) code += `${fmt(baseRise, 4)} Ts\n`;
  return code;
}

/** Rewrites one show operator: kept glyph groups, displaced groups, injected text, then state restore. */
function rewriteShow(S: ShowOp, status: Status[], injections: Injection[]): string {
  const inv = invert(S.ctm);
  let code = S.prefix ? S.prefix + '\n' : '';
  // Text state as currently emitted (starts as the operator's own state).
  let font = S.fontRes;
  let size = S.size;
  let tc = S.tc;
  let tw = S.tw;
  const setState = (f: string, sz: number, c: number, w: number) => {
    if (f !== font || sz !== size) code += `${serialize(new PName(f))} ${fmt(sz, 4)} Tf\n`;
    if (c !== tc) code += `${fmt(c, 4)} Tc\n`;
    if (w !== tw) code += `${fmt(w, 4)} Tw\n`;
    font = f;
    size = sz;
    tc = c;
    tw = w;
  };

  const emitGroup = (from: number, to: number, v: [number, number] | null) => {
    const first = S.elems[from] as GlyphElem;
    const m = mul(translate(first.x, 0), S.tm);
    if (v && inv) {
      const d = applyLinear(inv, v[0], v[1]);
      m[4] += d[0];
      m[5] += d[1];
    }
    setState(S.fontRes, S.size, S.tc, S.tw);
    let items = '';
    let run: number[] = [];
    const flushRun = () => {
      if (run.length) {
        items += `<${hex(run)}>`;
        run = [];
      }
    };
    for (let i = from; i < to; i++) {
      const e = S.elems[i];
      if (e.kind === 'g') for (const b of S.font.codeBytes(e.code)) run.push(b);
      else {
        flushRun();
        items += fmt(e.n, 4);
      }
    }
    flushRun();
    code += `${fmtMat(m)} Tm\n[${items}] TJ\n`;
  };

  const emitInjection = (inj: Injection) => {
    if (!inv) return;
    const o = apply(inv, inj.point[0], inj.point[1]);
    const sz = S.size * inj.scale;
    let x = 0;
    if (inj.color) code += colorOps(inj.color) + '\n';
    for (const seg of inj.segments) {
      const m: Mat = [S.tm[0], S.tm[1], S.tm[2], S.tm[3], o[0] + x * S.tm[0], o[1] + x * S.tm[1]];
      setState(seg.fontRes, sz, 0, 0);
      code += `${fmtMat(m)} Tm\n`;
      code += emitSegment(seg, sz, S.rise);
      x += (seg.width / 1000) * sz * S.th;
    }
    if (inj.color) code += S.fillSrc + '\n';
  };

  const pending = [...injections].sort((a, b) => a.at - b.at);
  let i = 0;
  const n = S.elems.length;
  while (i <= n) {
    while (pending.length && pending[0].at <= i) emitInjection(pending.shift()!);
    if (i >= n) break;
    const e = S.elems[i];
    if (e.kind !== 'g' || status[i] === 'remove') {
      i++;
      continue;
    }
    // Extend a group over glyphs with the same fate (adjustments in between stay inside).
    const st = status[i];
    const key = st && st !== 'remove' ? `${st.v[0]},${st.v[1]}` : '';
    let end = i + 1;
    let j = i + 1;
    while (j < n) {
      const ej = S.elems[j];
      if (ej.kind === 'g') {
        const sj = status[j];
        if (sj === 'remove') break;
        const kj = sj ? `${sj.v[0]},${sj.v[1]}` : '';
        if (kj !== key) break;
        if (pending.length && pending[0].at <= j) break;
        end = j + 1;
      }
      j++;
    }
    emitGroup(i, end, st && st !== 'remove' ? st.v : null);
    i = end;
  }
  setState(S.fontRes, S.size, S.tc, S.tw);
  // Leave the text matrices exactly as the original operator would have.
  code += `${fmtMat(S.tlm)} Tm`;
  const X = S.lineX + S.xEnd;
  const unit = S.size * S.th;
  if (Math.abs(X) > 1e-6 && Math.abs(unit) > 1e-9) code += ` [${fmt((-X * 1000) / unit, 4)}] TJ`;
  return code + '\n';
}

const isBlank = (s: string) => s.trim() === '';

interface LinePlanInput {
  line: Line;
  edit: LineEdit;
}

function cascadeFor(line: Line, anchor: ShowOp, env: CompileEnv, override?: LineStyle['font']): CascadeItem[] {
  const items: CascadeItem[] = [];
  if (override) items.push({ pdfFont: null, resName: null, match: null, full: override.font, label: override.label, substitute: false });
  else {
    // Resource names are only valid inside the stream that will receive the new text.
    const resOf = new Map<PdfFont, string>([[anchor.font, anchor.fontRes]]);
    for (const c of line.clusters) for (const g of c.glyphs) if (g.show.scope === anchor.scope && !resOf.has(g.show.font)) resOf.set(g.show.font, g.show.fontRes);
    const fonts = [anchor.font, ...line.fonts.filter((f) => f !== anchor.font)];
    for (const f of fonts) {
      const match = env.matchOf(f);
      const res = resOf.get(f);
      const label = match ? match.entry.family : f.cleanName;
      const substitute = !!match && match.quality === 'substitute';
      if (res) items.push({ pdfFont: f, resName: res, match, full: match ? match.font : null, label, substitute });
      else if (match) items.push({ pdfFont: null, resName: null, match: null, full: match.font, label, substitute });
    }
  }
  for (const fb of env.fallbacks) items.push({ pdfFont: null, resName: null, match: null, full: fb.font, label: fb.label, substitute: true });
  return items;
}

export function compilePage(edits: LinePlanInput[], boxes: TextBox[], env: CompileEnv): PagePlan {
  const statusOf = new Map<ShowOp, Status[]>();
  const injOf = new Map<ShowOp, Injection[]>();
  const outcomes = new Map<string, LineOutcome>();
  const fontsUsed = new Map<Scope, Set<string>>();
  const appendFonts = new Set<string>();
  const deadSpans = new Set<MarkedSpan>();
  const useFont = (scope: Scope, res: string) => {
    let set = fontsUsed.get(scope);
    if (!set) fontsUsed.set(scope, (set = new Set()));
    set.add(res);
  };
  const touch = (s: ShowOp) => {
    let st = statusOf.get(s);
    if (!st) {
      st = new Array(s.elems.length);
      statusOf.set(s, st);
    }
    return st;
  };

  for (const { line, edit } of edits) {
    const cl = line.clusters;
    const n = cl.length;
    const text = edit.text;
    const restyle = !!edit.style && (edit.style.color !== undefined || edit.style.font !== undefined || (edit.style.scale !== undefined && Math.abs(edit.style.scale - 1) > 1e-6));
    // Longest run of leading / trailing clusters that the new text leaves untouched.
    let p = 0;
    let pos = 0;
    let q = 0;
    let end = text.length;
    if (!restyle) {
      while (p < n && cl[p].text !== '' && text.startsWith(cl[p].text, pos)) pos += cl[p++].text.length;
      while (q < n - p && cl[n - 1 - q].text !== '' && end - cl[n - 1 - q].text.length >= pos && text.startsWith(cl[n - 1 - q].text, end - cl[n - 1 - q].text.length)) {
        end -= cl[n - 1 - q].text.length;
        q++;
      }
      if (p + q === n && pos === end) continue; // nothing changed
      // Cuts must fall on cluster boundaries of the *new* text.
      const first = (s: string) => String.fromCodePoint(s.codePointAt(0)!);
      const lastCh = (s: string) => Array.from(s).pop() ?? '';
      for (;;) {
        const mid = text.slice(pos, end);
        const before = p > 0 ? cl[p - 1].text : '';
        if (p > 0 && ((mid && attachesBackward(first(mid))) || (before && joinsForward(lastCh(before))) || (!mid && q > 0 && attachesBackward(first(cl[n - q].text))))) {
          p--;
          pos -= cl[p].text.length;
          continue;
        }
        const after = q > 0 ? cl[n - q].text : '';
        if (q > 0 && ((after && attachesBackward(first(after))) || (mid && joinsForward(lastCh(mid))))) {
          end += cl[n - q].text.length;
          q--;
          continue;
        }
        break;
      }
    }
    const middle = text.slice(pos, end);
    const oldMid = cl.slice(p, n - q);
    const startS = p < n ? cl[p].s0 : line.length;
    const oldEndS = q > 0 ? cl[n - q].s0 : line.length;

    // Where the new text is injected and whose graphics state it inherits.
    let anchor: GlyphRef | undefined;
    let at = 0;
    for (const c of oldMid) {
      if (c.glyphs.length && !isBlank(c.text)) {
        anchor = c.glyphs[0];
        break;
      }
    }
    if (!anchor) for (const c of oldMid) if (c.glyphs.length) { anchor = c.glyphs[0]; break; }
    if (anchor) at = anchor.ei;
    else {
      const findBack = (): GlyphRef | undefined => {
        for (let i = p - 1; i >= 0; i--) if (cl[i].glyphs.length) return cl[i].glyphs[cl[i].glyphs.length - 1];
        return undefined;
      };
      const findFwd = (): GlyphRef | undefined => {
        for (let i = n - q; i < n; i++) if (cl[i].glyphs.length) return cl[i].glyphs[0];
        return undefined;
      };
      const back = findBack();
      if (back) {
        anchor = back;
        at = back.ei + 1;
      } else {
        anchor = findFwd();
        at = anchor ? anchor.ei : 0;
      }
    }
    if (!anchor) continue;
    const S = anchor.show;
    const scale = edit.style?.scale && edit.style.scale > 0 ? edit.style.scale : 1;

    const layout = layoutText(middle, cascadeFor(line, S, env, edit.style?.font), env);
    for (const seg of layout.segments) useFont(S.scope, seg.fontRes);
    const m = mul(S.tm, S.ctm);
    const unitLen = Math.hypot(...applyLinear(m, 1, 0));
    const newExtent = (layout.width / 1000) * Math.abs(S.size * scale * S.th) * unitLen;
    const delta = newExtent - (oldEndS - startS);

    for (const c of oldMid) {
      for (const g of c.glyphs) touch(g.show)[g.ei] = 'remove';
      if (c.span) deadSpans.add(c.span);
    }
    // Anchoring: the kept start of the line moves by `lead`, the kept end by `lead + delta`.
    const anchor01 = Math.min(1, Math.max(0, edit.align ?? 0));
    const lead = anchor01 > 0 ? -anchor01 * delta : 0;
    const shift = (from: number, to: number, by: number) => {
      if (Math.abs(by) <= 1e-4) return;
      const v: [number, number] = [line.dir[0] * by, line.dir[1] * by];
      for (let i = from; i < to; i++) for (const g of cl[i].glyphs) touch(g.show)[g.ei] = { v };
    };
    shift(0, p, lead);
    shift(n - q, n, lead + delta);
    touch(S);
    if (layout.segments.length) {
      const at0 = startS + lead;
      const point: [number, number] = [line.origin[0] + line.dir[0] * at0, line.origin[1] + line.dir[1] * at0];
      let list = injOf.get(S);
      if (!list) injOf.set(S, (list = []));
      list.push({ at, point, segments: layout.segments, color: edit.style?.color, scale });
    }
    outcomes.set(line.id, {
      length: line.length + delta, offset: lead, via: [...new Set(layout.segments.map((s) => s.via))],
      fonts: [...new Set(layout.segments.map((s) => s.fontLabel))], missing: layout.missing,
    });
  }

  const replacements: PagePlan['replacements'] = new Map();
  const replace = (scope: Scope, r: Replacement) => {
    let list = replacements.get(scope);
    if (!list) replacements.set(scope, (list = []));
    list.push(r);
  };
  for (const [show, status] of statusOf) {
    replace(show.scope, { start: show.start, end: show.end, text: rewriteShow(show, status, injOf.get(show) ?? []) });
  }
  // ActualText of spans whose glyphs were replaced no longer applies.
  for (const span of deadSpans) {
    if (!span.props) continue;
    const map = new Map(span.props.map);
    map.delete('ActualText');
    replace(span.scope, { start: span.start, end: span.end, text: `${serialize(new PName(span.tag))} ${serialize(new PDict(map))} BDC` });
  }
  for (const list of replacements.values()) list.sort((a, b) => a.start - b.start);

  let append = '';
  for (const box of boxes) {
    if (!box.text) continue;
    const cascade: CascadeItem[] = [
      { pdfFont: null, resName: null, match: null, full: box.font, label: box.fontLabel, substitute: false },
      ...env.fallbacks.map((fb) => ({ pdfFont: null, resName: null, match: null, full: fb.font, label: fb.label, substitute: true })),
    ];
    const layout = layoutText(box.text, cascade, env);
    let x = 0;
    append += `q\nBT\n${colorOps(box.color)}\n0 Tc 0 Tw 100 Tz 0 Ts 0 Tr\n`;
    for (const seg of layout.segments) {
      appendFonts.add(seg.fontRes);
      const mtx: Mat = [box.dir[0], box.dir[1], -box.dir[1], box.dir[0], box.x + box.dir[0] * x, box.y + box.dir[1] * x];
      append += `${serialize(new PName(seg.fontRes))} ${fmt(box.size, 4)} Tf\n${fmtMat(mtx)} Tm\n${emitSegment(seg, box.size, 0)}`;
      x += (seg.width / 1000) * box.size;
    }
    append += 'ET\nQ\n';
    outcomes.set(box.id, {
      length: x, offset: 0, via: [...new Set(layout.segments.map((s) => s.via))], fonts: [...new Set(layout.segments.map((s) => s.fontLabel))], missing: layout.missing,
    });
  }
  return { replacements, append, outcomes, fontsUsed, appendFonts };
}

/** Width a piece of text would take, without changing anything (for live UI feedback). */
export function measureText(text: string, font: LoadedFont, size: number): number {
  let w = 0;
  for (const g of font.shape(text)) w += g.ax;
  return (w / font.upem) * size;
}

export type { Cluster };
