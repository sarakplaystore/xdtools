/**
 * Content-stream interpreter for text.
 *
 * Walks the operators of a page, tracking the graphics and text state exactly
 * as a viewer would, and records every text-showing operator together with
 * the state it ran in. Nothing is rendered: the result is the precise
 * geometry and glyph codes of all text, tied to byte ranges in the stream.
 */
import { IDENTITY, Mat, decodePdfText, mul, translate } from '../util';
import { Op, PDict, PName, PObj, PStr, serialize } from './lexer';
import { PdfFont } from './fonts';

export interface GlyphElem {
  kind: 'g';
  code: number;
  /** Text-space x of the pen before this glyph, relative to the operator's start. */
  x: number;
  /** Text-space advance (glyph width, character/word spacing and horizontal scaling applied). */
  adv: number;
}
export interface AdjustElem {
  kind: 'k';
  /** The raw TJ number (thousandths of text space, positive moves left). */
  n: number;
}
export type Elem = GlyphElem | AdjustElem;

/** One content stream: a page's contents or a form XObject drawn by it. */
export interface Scope {
  id: string;
  kind: 'page' | 'form';
  data: Uint8Array;
  ops: Op[];
  /** How many times the whole document draws this stream (forms can be shared). */
  uses: number;
}

export interface MarkedSpan {
  scope: Scope;
  /** Byte range of the BDC operator inside its scope. */
  start: number;
  end: number;
  tag: string;
  props: PDict | null;
  actualText: string | null;
}

export type RGB = [number, number, number];

export interface ShowOp {
  /** Position in the page's list of show operators (drawing order). */
  index: number;
  /** The stream this operator lives in. */
  scope: Scope;
  opIndex: number;
  start: number;
  end: number;
  kind: 'Tj' | 'TJ' | "'" | '"';
  font: PdfFont;
  fontRes: string;
  size: number;
  tc: number;
  tw: number;
  th: number;
  rise: number;
  mode: number;
  ctm: Mat;
  /** Text matrix at the first glyph. */
  tm: Mat;
  /** Text line matrix once the operator has run. */
  tlm: Mat;
  /** Text-space x of `tm` relative to `tlm` (Tm = T(lineX, 0) × Tlm). */
  lineX: number;
  /** Total text-space advance of the operator. */
  xEnd: number;
  elems: Elem[];
  /** Innermost enclosing marked-content sequence that carries /ActualText. */
  span: MarkedSpan | null;
  fill: RGB | null;
  /** Operators that re-establish the fill colour in force at this point. */
  fillSrc: string;
  /** Text render mode 3/7: drawn invisibly (typical OCR layer). */
  invisible: boolean;
  /** Operator-specific prefix that must survive a rewrite (for ' and "). */
  prefix: string;
}

interface GState {
  ctm: Mat;
  font: PdfFont | null;
  fontRes: string;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  mode: number;
  fill: RGB | null;
  fillSrc: string;
  fillCs: string;
}

/**
 * A straight ruling drawn on the page (a table border, a column separator), as a segment in user
 * space. Only used to tell where one piece of text ends and the next begins.
 */
export type Rule = [x0: number, y0: number, x1: number, y1: number];

const MAX_RULES = 20000;

export interface InterpEnv {
  font(scope: Scope, resName: string): PdfFont | null;
  /** Resolves the XObject a `Do` draws; null unless it is a form. */
  form(scope: Scope, resName: string): { scope: Scope; matrix: Mat } | null;
}

const num = (o: PObj | undefined): number => (typeof o === 'number' ? o : 0);

function cmykToRgb(c: number, m: number, y: number, k: number): RGB {
  return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
}

/** Interprets a page: its own content stream and, recursively, the forms it draws. */
export function interpret(root: Scope, env: InterpEnv, initialCtm: Mat = IDENTITY, rules?: Rule[]): ShowOp[] {
  const shows: ShowOp[] = [];
  const active = new Set<Scope>();
  const pt = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  const run = (scope: Scope, start: GState, depth: number): void => {
    const ops = scope.ops;
    let gs: GState = { ...start };
    const stack: GState[] = [];
    let tm: Mat = IDENTITY;
    let tlm: Mat = IDENTITY;
    let lineX = 0;
    /** Set after text in a font we cannot measure: positions are unknown until the next absolute move. */
    let uncertain = false;
    const mcStack: (MarkedSpan | null)[] = [];
    const fontCache = new Map<string, PdfFont | null>();

    // The path under construction, reduced to what rulings are made of: straight-edged subpaths.
    let subs: number[][] = [];
    let points = 0;
    const begin = (p: [number, number]) => {
      if (rules && points < 4 * MAX_RULES) {
        subs.push([p[0], p[1]]);
        points++;
      }
    };
    const lineTo = (p: [number, number]) => {
      const sp = subs[subs.length - 1];
      if (rules && sp && points < 4 * MAX_RULES) {
        sp.push(p[0], p[1]);
        points++;
      }
    };
    const paint = (stroke: boolean, fill: boolean) => {
      if (rules && rules.length < MAX_RULES) {
        for (const sp of subs) {
          const n = sp.length / 2;
          if (stroke) for (let k = 0; k + 3 < sp.length; k += 2) rules.push([sp[k], sp[k + 1], sp[k + 2], sp[k + 3]]);
          // A long, thin filled quadrilateral is a line too (how Word draws table borders): keep its centre line.
          const closed = n === 5 && Math.abs(sp[0] - sp[8]) < 1e-6 && Math.abs(sp[1] - sp[9]) < 1e-6;
          if (fill && (n === 4 || closed)) {
            const w = Math.hypot(sp[2] - sp[0], sp[3] - sp[1]);
            const h = Math.hypot(sp[4] - sp[2], sp[5] - sp[3]);
            const mid = (i: number, j: number): [number, number] => [(sp[i * 2] + sp[j * 2]) / 2, (sp[i * 2 + 1] + sp[j * 2 + 1]) / 2];
            if (h <= 3 && w >= 3 * h && w >= 2) rules.push([...mid(0, 3), ...mid(1, 2)]);
            else if (w <= 3 && h >= 3 * w && h >= 2) rules.push([...mid(0, 1), ...mid(3, 2)]);
          }
        }
      }
      subs = [];
      points = 0;
    };
    const closePath = () => {
      const sp = subs[subs.length - 1];
      if (sp && sp.length >= 4 && (sp[0] !== sp[sp.length - 2] || sp[1] !== sp[sp.length - 1])) lineTo([sp[0], sp[1]]);
    };

    const newLine = (m: Mat) => {
      tlm = m;
      tm = m;
      lineX = 0;
      uncertain = false;
    };

    const show = (i: number, kind: ShowOp['kind'], items: PObj[], prefix: string) => {
      const font = gs.font;
      if (!font || !font.supported) {
        uncertain = true;
        return;
      }
      const elems: Elem[] = [];
      let x = 0;
      for (const item of items) {
        if (typeof item === 'number') {
          elems.push({ kind: 'k', n: item });
          x -= (item / 1000) * gs.size * gs.th;
        } else if (item instanceof PStr) {
          for (const code of font.decode(item.bytes)) {
            const adv = ((font.width(code) / 1000) * gs.size + gs.tc + (font.isWordSpace(code) ? gs.tw : 0)) * gs.th;
            elems.push({ kind: 'g', code, x, adv });
            x += adv;
            font.used.add(code);
          }
        }
      }
      if (!uncertain) {
        let span: MarkedSpan | null = null;
        for (let k = mcStack.length - 1; k >= 0; k--) {
          const sp = mcStack[k];
          if (sp && sp.actualText !== null) {
            span = sp;
            break;
          }
        }
        shows.push({
          index: shows.length, scope, opIndex: i, start: ops[i].start, end: ops[i].end, kind,
          font, fontRes: gs.fontRes, size: gs.size, tc: gs.tc, tw: gs.tw, th: gs.th, rise: gs.rise, mode: gs.mode,
          ctm: gs.ctm, tm, tlm, lineX, xEnd: x, elems, span,
          fill: gs.fill, fillSrc: gs.fillSrc, invisible: gs.mode === 3 || gs.mode === 7, prefix,
        });
      }
      tm = mul(translate(x, 0), tm);
      lineX += x;
    };

    for (let i = 0; i < ops.length; i++) {
      const { op, args } = ops[i];
      switch (op) {
        case 'q':
          stack.push({ ...gs });
          break;
        case 'Q':
          if (stack.length) gs = stack.pop()!;
          break;
        case 'cm':
          if (args.length >= 6) gs.ctm = mul([num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), num(args[5])], gs.ctm);
          break;
        case 'Do': {
          const nm = args[0] instanceof PName ? args[0].name : '';
          const form = depth < 6 ? env.form(scope, nm) : null;
          if (form && !active.has(form.scope)) {
            form.scope.uses++;
            active.add(form.scope);
            run(form.scope, { ...gs, ctm: mul(form.matrix, gs.ctm) }, depth + 1);
            active.delete(form.scope);
          }
          break;
        }
        case 'm':
          begin(pt(gs.ctm, num(args[0]), num(args[1])));
          break;
        case 'l':
          lineTo(pt(gs.ctm, num(args[0]), num(args[1])));
          break;
        case 'c':
          begin(pt(gs.ctm, num(args[4]), num(args[5]))); // curves are not rulings: start afresh after one
          break;
        case 'v':
        case 'y':
          begin(pt(gs.ctm, num(args[2]), num(args[3])));
          break;
        case 'h':
          closePath();
          break;
        case 're': {
          const [x, y, w, h] = [num(args[0]), num(args[1]), num(args[2]), num(args[3])];
          begin(pt(gs.ctm, x, y));
          lineTo(pt(gs.ctm, x + w, y));
          lineTo(pt(gs.ctm, x + w, y + h));
          lineTo(pt(gs.ctm, x, y + h));
          lineTo(pt(gs.ctm, x, y));
          break;
        }
        case 'S':
          paint(true, false);
          break;
        case 's':
          closePath();
          paint(true, false);
          break;
        case 'f':
        case 'F':
        case 'f*':
          paint(false, true);
          break;
        case 'b':
        case 'b*':
          closePath();
          paint(true, true);
          break;
        case 'B':
        case 'B*':
          paint(true, true);
          break;
        case 'n':
          paint(false, false);
          break;
        case 'BT':
          newLine(IDENTITY);
          break;
        case 'Tf': {
          const nm = args[0] instanceof PName ? args[0].name : '';
          let f = fontCache.get(nm);
          if (f === undefined) {
            f = env.font(scope, nm);
            fontCache.set(nm, f);
          }
          gs.fontRes = nm;
          gs.font = f;
          gs.size = num(args[1]);
          break;
        }
        case 'Tc': gs.tc = num(args[0]); break;
        case 'Tw': gs.tw = num(args[0]); break;
        case 'Tz': gs.th = num(args[0]) / 100; break;
        case 'TL': gs.tl = num(args[0]); break;
        case 'Tr': gs.mode = num(args[0]); break;
        case 'Ts': gs.rise = num(args[0]); break;
        case 'Td':
          newLine(mul(translate(num(args[0]), num(args[1])), tlm));
          break;
        case 'TD':
          gs.tl = -num(args[1]);
          newLine(mul(translate(num(args[0]), num(args[1])), tlm));
          break;
        case 'Tm':
          if (args.length >= 6) newLine([num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), num(args[5])]);
          break;
        case 'T*':
          newLine(mul(translate(0, -gs.tl), tlm));
          break;
        case 'Tj':
          show(i, 'Tj', args.slice(0, 1), '');
          break;
        case 'TJ':
          show(i, 'TJ', Array.isArray(args[0]) ? args[0] : [], '');
          break;
        case "'":
          newLine(mul(translate(0, -gs.tl), tlm));
          show(i, "'", args.slice(0, 1), 'T*');
          break;
        case '"':
          gs.tw = num(args[0]);
          gs.tc = num(args[1]);
          newLine(mul(translate(0, -gs.tl), tlm));
          show(i, '"', args.slice(2, 3), `${serialize(num(args[0]))} Tw ${serialize(num(args[1]))} Tc T*`);
          break;
        case 'BMC':
          mcStack.push(null);
          break;
        case 'BDC': {
          const tag = args[0] instanceof PName ? args[0].name : '';
          const props = args[1] instanceof PDict ? args[1] : null;
          let actualText: string | null = null;
          const at = props?.map.get('ActualText');
          if (at instanceof PStr) actualText = decodePdfText(at.bytes);
          mcStack.push({ scope, start: ops[i].start, end: ops[i].end, tag, props, actualText });
          break;
        }
        case 'EMC':
          mcStack.pop();
          break;
        case 'g':
          gs.fill = [num(args[0]), num(args[0]), num(args[0])];
          gs.fillSrc = `${serialize(num(args[0]))} g`;
          gs.fillCs = 'DeviceGray';
          break;
        case 'rg':
          gs.fill = [num(args[0]), num(args[1]), num(args[2])];
          gs.fillSrc = `${args.slice(0, 3).map(serialize).join(' ')} rg`;
          gs.fillCs = 'DeviceRGB';
          break;
        case 'k':
          gs.fill = cmykToRgb(num(args[0]), num(args[1]), num(args[2]), num(args[3]));
          gs.fillSrc = `${args.slice(0, 4).map(serialize).join(' ')} k`;
          gs.fillCs = 'DeviceCMYK';
          break;
        case 'cs': {
          const nm = args[0] instanceof PName ? args[0].name : 'DeviceGray';
          gs.fillCs = nm;
          gs.fillSrc = `${serialize(new PName(nm))} cs`;
          gs.fill = nm === 'Pattern' ? null : [0, 0, 0];
          break;
        }
        case 'sc':
        case 'scn': {
          const nums = args.filter((a) => typeof a === 'number') as number[];
          const hasName = args.some((a) => a instanceof PName);
          if (hasName) gs.fill = null;
          else if (nums.length === 1) gs.fill = [nums[0], nums[0], nums[0]];
          else if (nums.length === 3) gs.fill = [nums[0], nums[1], nums[2]];
          else if (nums.length === 4) gs.fill = cmykToRgb(nums[0], nums[1], nums[2], nums[3]);
          else gs.fill = null;
          gs.fillSrc = `${serialize(new PName(gs.fillCs))} cs ${args.map(serialize).join(' ')} ${op}`;
          break;
        }
        default:
          break;
      }
    }
  };

  root.uses++;
  run(
    root,
    { ctm: initialCtm, font: null, fontRes: '', size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, mode: 0, fill: [0, 0, 0], fillSrc: '0 g', fillCs: 'DeviceGray' },
    0,
  );
  return shows;
}
