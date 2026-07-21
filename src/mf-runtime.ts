/// <reference types="@songloft/plugin-sdk" />
// MusicFree 插件运行时垫片：为 MusicFree 音源插件提供 crypto-js / axios / env 等依赖，
// 使其能在 songloft 的 QuickJS 沙箱中运行。

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============ crypto-js shim ============
// 底层复用运行时注入的 __go_crypto_* / __go_buffer_* 桥接函数（由 SDK 全局声明）。

interface Encoder {
  stringify: (wordArray: WordArrayLike) => string;
  parse: (str: string) => WordArrayLike;
}

interface WordArrayLike {
  __hex: string;
  toString: (encoder?: Encoder) => string;
}

function makeWordArray(hex: string): WordArrayLike {
  return {
    __hex: hex,
    toString(encoder?: Encoder): string {
      if (!encoder || encoder === HexEnc) return hex;
      return encoder.stringify(this);
    },
  };
}

// 将 crypto-js 的输入（string / WordArrayLike）统一转为 hex
function _waToString(input: any): string {
  if (input == null) return '';
  if (typeof input === 'string') return __go_buffer_from(input, 'utf8');
  if (input.__hex !== undefined) return input.__hex;
  return __go_buffer_from(String(input), 'utf8');
}

const HexEnc: Encoder = {
  stringify(wa: WordArrayLike): string {
    return wa.__hex;
  },
  parse(str: string): WordArrayLike {
    return makeWordArray(str.toLowerCase());
  },
};

const Utf8Enc: Encoder = {
  stringify(wa: WordArrayLike): string {
    try {
      return __go_buffer_to_string(wa.__hex, 'utf8');
    } catch {
      return '';
    }
  },
  parse(str: string): WordArrayLike {
    return makeWordArray(__go_buffer_from(str, 'utf8'));
  },
};

const Base64Enc: Encoder = {
  stringify(wa: WordArrayLike): string {
    try {
      return __go_buffer_to_string(wa.__hex, 'base64');
    } catch {
      return '';
    }
  },
  parse(str: string): WordArrayLike {
    return makeWordArray(__go_buffer_from(str, 'base64'));
  },
};

function toUtf8String(input: any): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  // WordArray：转成 utf8 字符串
  if (input.__hex !== undefined) {
    try {
      return __go_buffer_to_string(input.__hex, 'utf8');
    } catch {
      return '';
    }
  }
  return String(input);
}

export const CryptoJs: any = {
  enc: {
    Hex: HexEnc,
    Utf8: Utf8Enc,
    Base64: Base64Enc,
    Latin1: {
      stringify(wa: WordArrayLike): string {
        try {
          return __go_buffer_to_string(wa.__hex, 'latin1');
        } catch {
          return '';
        }
      },
      parse(str: string): WordArrayLike {
        return makeWordArray(__go_buffer_from(str, 'latin1'));
      },
    },
  },
  MD5(message: any): WordArrayLike {
    return makeWordArray(__go_crypto_md5(toUtf8String(message)));
  },
  SHA256(message: any): WordArrayLike {
    return makeWordArray(__go_crypto_sha256(toUtf8String(message)));
  },
  mode: {
    ECB: { _modeName: 'ECB' },
    CBC: { _modeName: 'CBC' },
    CFB: { _modeName: 'CFB' },
    OFB: { _modeName: 'OFB' },
    CTR: { _modeName: 'CTR' },
  },
  pad: {
    Pkcs7: {},
    NoPadding: {},
    ZeroPadding: {},
    AnsiX923: {},
    Iso10126: {},
    Iso97971: {},
  },
  // 部分插件用到但运行时暂无对应桥接的算法，做安全降级（返回空/抛错在实际调用时才发生）
  lib: {
    WordArray: {
      create(hex?: string): WordArrayLike {
        return makeWordArray(hex || '');
      },
      random(nBytes: number): WordArrayLike {
        // 无随机字节桥接则退化为基于 Math.random 的 hex
        let hex = '';
        for (let i = 0; i < nBytes; i++) {
          hex += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
        }
        return makeWordArray(hex);
      },
    },
  },
  // AES encrypt/decrypt，底层复用运行时桥接 __go_crypto_aes_encrypt
  AES: {
    encrypt(message: any, key: any, cfg?: any): any {
      const dataHex = _waToString(message);
      const keyHex = _waToString(key);
      const mode = (cfg && cfg.mode && cfg.mode._modeName) || 'CBC';
      const ivHex = (cfg && cfg.iv) ? _waToString(cfg.iv) : '';
      const cipherHex = __go_crypto_aes_encrypt(dataHex, mode, keyHex, ivHex);
      const ct = makeWordArray(cipherHex);
      return {
        ciphertext: ct,
        key: makeWordArray(keyHex),
        iv: cfg && cfg.iv ? makeWordArray(_waToString(cfg.iv)) : undefined,
        toString(encoder?: any): string {
          if (!encoder || encoder === Base64Enc) {
            try { return __go_buffer_to_string(cipherHex, 'base64'); } catch { return cipherHex; }
          }
          return encoder.stringify(ct);
        },
      };
    },
    decrypt(ciphertext: any, key: any, cfg?: any): any {
      // decrypt not commonly used in MusicFree plugins, stub
      return makeWordArray('');
    },
  },
};

// ============ axios shim ============
// 基于运行时注入的全局 fetch 实现 MusicFree 插件常用的 axios 调用形态。

interface AxiosConfig {
  url?: string;
  method?: string;
  data?: any;
  params?: Record<string, any>;
  headers?: Record<string, string>;
  responseType?: string;
  timeout?: number;
  [key: string]: any;
}

interface AxiosResponse {
  data: any;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: AxiosConfig;
}

function buildUrlWithParams(url: string, params?: Record<string, any>): string {
  if (!params) return url;
  const parts: string[] = [];
  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const v = params[key];
      if (v === undefined || v === null) continue;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
    }
  }
  if (parts.length === 0) return url;
  return url + (url.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
}

async function axiosRequest(config: AxiosConfig): Promise<AxiosResponse> {
  const method = (config.method || 'GET').toUpperCase();
  const baseUrl = config.url || '';
  const url = buildUrlWithParams(baseUrl, config.params);
  const originalIsHttp = url.startsWith('http://');
  const targetUrl = originalIsHttp ? url.replace('http://', 'https://') : url;

  const makeRequest = async (u: string): Promise<AxiosResponse> => {
    const init: any = { method, headers: {} };
    if (config.headers) {
      for (const k in config.headers) {
        if (Object.prototype.hasOwnProperty.call(config.headers, k)) {
          init.headers[k] = config.headers[k];
        }
      }
    }

    if (config.data !== undefined && config.data !== null && method !== 'GET' && method !== 'HEAD') {
      if (typeof config.data === 'string') {
        init.body = config.data;
      } else {
        init.body = JSON.stringify(config.data);
        if (!hasHeader(init.headers, 'content-type')) {
          init.headers['Content-Type'] = 'application/json';
        }
      }
    }
    const resp = await fetch(u, init);

    const respHeaders: Record<string, string> = {};
    try {
      const h: any = (resp as any).headers;
      if (h && typeof h === 'object') {
        for (const k in h) {
          if (Object.prototype.hasOwnProperty.call(h, k)) respHeaders[k] = h[k];
        }
      }
    } catch {
      // ignore
    }

    let data: any;
    const rt = config.responseType;
    const text = await resp.text();
    if (rt === 'arraybuffer' || rt === 'blob') {
      data = text;
    } else {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    return {
      data,
      status: resp.status,
      statusText: (resp as any).statusText || '',
      headers: respHeaders,
      config,
    };
  };

  try {
    return await makeRequest(targetUrl);
  } catch (e) {
    if (originalIsHttp && String(e).toLowerCase().includes('tls') || String(e).toLowerCase().includes('certificate')) {
      return await makeRequest(url);
    }
    throw e;
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  for (const k in headers) {
    if (k.toLowerCase() === lower) return true;
  }
  return false;
}

// axios 主体：既可作为函数调用 axios(config)，也带 get/post/... 方法
function axiosFn(config: AxiosConfig | string, config2?: AxiosConfig): Promise<AxiosResponse> {
  if (typeof config === 'string') {
    return axiosRequest({ ...(config2 || {}), url: config });
  }
  return axiosRequest(config);
}

const axiosInstance: any = axiosFn;
axiosInstance.get = (url: string, config?: AxiosConfig): Promise<AxiosResponse> =>
  axiosRequest({ ...(config || {}), url, method: 'GET' });
axiosInstance.post = (url: string, data?: any, config?: AxiosConfig): Promise<AxiosResponse> =>
  axiosRequest({ ...(config || {}), url, data, method: 'POST' });
axiosInstance.put = (url: string, data?: any, config?: AxiosConfig): Promise<AxiosResponse> =>
  axiosRequest({ ...(config || {}), url, data, method: 'PUT' });
axiosInstance.delete = (url: string, config?: AxiosConfig): Promise<AxiosResponse> =>
  axiosRequest({ ...(config || {}), url, method: 'DELETE' });
axiosInstance.request = (config: AxiosConfig): Promise<AxiosResponse> => axiosRequest(config);
axiosInstance.create = (): any => axiosInstance;
axiosInstance.default = axiosInstance;

export const axios: any = axiosInstance;

// ============ 代码预处理 ============
// QuickJS 严格遵循 ES 规范：函数参数被 let/const 重新声明会报
// "invalid redefinition of parameter name"。而 MusicFree 用的 Hermes/V8 引擎放行此类写法。
// 将顶层 let/const 转为 var（var 允许与参数同名），但保留 for(let/const ...) 头以维持块级作用域语义。
export function sanitizePluginCode(code: string): string {
  // 1) 先保护 for (let/const ...) 循环头
  let out = code.replace(/for(\s*)\((\s*)(let|const)\b/g, 'for$1($2__MF_KEEP__');
  // 2) 其余 let/const → var
  out = out.replace(/\b(let|const)\b/g, 'var');
  // 3) 恢复 for 头
  out = out.replace(/__MF_KEEP__/g, 'let');
  return out;
}

// ============ env / require ============
// MusicFree 插件常用全局 env.getUserVariables()，以及 require("crypto-js"/"axios")。

export interface MFEnvOptions {
  getUserVariables?: () => Record<string, string>;
  os?: string;
}

export function createEnv(opts?: MFEnvOptions): any {
  return {
    getUserVariables: opts?.getUserVariables || (() => ({})),
    os: opts?.os || 'linux',
    appVersion: '0.0.0',
    lang: {
      locale: 'zh-CN',
    },
  };
}

// ============ cheerio shim ============

interface DOMNode {
  tag?: string;
  text?: string;
  attrs: Record<string, string>;
  children: DOMNode[];
  parent: DOMNode | null;
}

function parseHTML(html: string): DOMNode[] {
  const root: DOMNode[] = [];
  const stack: DOMNode[] = [];
  let i = 0;
  const selfClosing = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

  while (i < html.length) {
    if (html[i] === '<') {
      if (html[i + 1] === '/') {
        const close = html.indexOf('>', i);
        if (close === -1) break;
        const tag = html.slice(i + 2, close).trim().split(/\s/)[0].toLowerCase();
        if (stack.length > 0 && stack[stack.length - 1].tag === tag) {
          stack.pop();
        }
        i = close + 1;
        continue;
      }
      if (html[i + 1] === '!' || html[i + 1] === '?') {
        const close = html.indexOf('>', i);
        if (close === -1) break;
        i = close + 1;
        continue;
      }
      const close = html.indexOf('>', i);
      if (close === -1) break;
      const tagStr = html.slice(i + 1, close);
      const tagMatch = tagStr.match(/^(\S+)/);
      if (!tagMatch) { i = close + 1; continue; }
      const tag = tagMatch[1].toLowerCase();
      const attrs: Record<string, string> = {};
      const attrRe = /(\S+?)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      const attrNameRe = /([^\s=/>]+)/g;
      let am: RegExpExecArray | null;
      let lastIdx = tagMatch[0].length;
      while ((am = attrRe.exec(tagStr)) !== null) {
        attrs[am[1]] = am[2] !== undefined ? am[2] : (am[3] !== undefined ? am[3] : (am[4] || ''));
        lastIdx = attrRe.lastIndex;
      }
      attrNameRe.lastIndex = lastIdx;
      while ((am = attrNameRe.exec(tagStr)) !== null) {
        if (!am[1].includes('=')) attrs[am[1]] = '';
      }
      const node: DOMNode = { tag, attrs, children: [], parent: null };
      const isSelfClose = tagStr.endsWith('/') || selfClosing.has(tag);
      if (stack.length > 0) {
        node.parent = stack[stack.length - 1];
        stack[stack.length - 1].children.push(node);
      } else {
        root.push(node);
      }
      if (!isSelfClose) stack.push(node);
      i = close + 1;
    } else {
      const textEnd = html.indexOf('<', i);
      const text = textEnd === -1 ? html.slice(i) : html.slice(i, textEnd);
      const trimmed = text.replace(/\s+/g, ' ').trim();
      if (trimmed) {
        const tnode: DOMNode = { text: trimmed, attrs: {}, children: [], parent: null };
        if (stack.length > 0) {
          tnode.parent = stack[stack.length - 1];
          stack[stack.length - 1].children.push(tnode);
        } else if (trimmed) {
          root.push(tnode);
        }
      }
      i = textEnd === -1 ? html.length : textEnd;
    }
  }
  return root;
}

function matchSelector(el: DOMNode, sel: string): boolean {
  if (!sel) return false;
  let tag = '', cls = '', id = '';
  const parts = sel.split(/(?=[.#])/);
  for (const p of parts) {
    if (p.startsWith('.')) cls = p.slice(1);
    else if (p.startsWith('#')) id = p.slice(1);
    else tag = p.toLowerCase();
  }
  if (tag && el.tag !== tag) return false;
  if (id && el.attrs['id'] !== id) return false;
  if (cls) {
    const classes = (el.attrs['class'] || '').split(/\s+/);
    if (!classes.includes(cls)) return false;
  }
  return true;
}

function parseSelector(sel: string): { combinator: string; selector: string }[] {
  const parts: { combinator: string; selector: string }[] = [];
  const tokens = sel.split(/\s*(>|,|\s)\s*/).filter(Boolean);
  let current = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '>') { parts.push({ combinator: '>', selector: current }); current = ''; }
    else if (t === ',') { parts.push({ combinator: 'multi', selector: current }); current = ''; }
    else { current = current ? current + t : t; }
  }
  if (current) parts.push({ combinator: '', selector: current });
  return parts;
}

function findAll(el: DOMNode, selector: string, combinator = ''): DOMNode[] {
  const results: DOMNode[] = [];
  function walk(node: DOMNode, isDescendant: boolean) {
    if (node.tag && (combinator === '' || combinator === '>') && matchSelector(node, selector)) {
      if (!combinator || (combinator === '>' && node.parent === el) || combinator === '') {
        if (combinator === '') results.push(node);
        else if (combinator === '>' && node.parent === el) results.push(node);
      }
    }
    for (const child of node.children) {
      walk(child, true);
    }
  }
  for (const child of el.children) walk(child, false);
  return results;
}

function qsa(nodes: DOMNode[], sel: string): DOMNode[] {
  const parts = parseSelector(sel);
  if (parts.length === 0) return [];
  if (parts.some(p => p.combinator === 'multi')) {
    const result: DOMNode[] = [];
    for (const p of parts) {
      result.push(...qsa(nodes, p.selector));
    }
    return result;
  }
  if (parts.length === 1) {
    const s = parts[0].selector;
    const result: DOMNode[] = [];
    function walk(list: DOMNode[], descend: boolean) {
      for (const node of list) {
        if (node.tag && matchSelector(node, s)) result.push(node);
        if (descend) walk(node.children, true);
      }
    }
    walk(nodes, true);
    return result;
  }
  if (parts.length === 2 && parts[1].combinator === '>') {
    const parents = qsa(nodes, parts[0].selector);
    const result: DOMNode[] = [];
    for (const p of parents) {
      for (const child of p.children) {
        if (child.tag && matchSelector(child, parts[1].selector)) result.push(child);
      }
    }
    return result;
  }
  if (parts.length === 2 && parts[1].combinator === '') {
    const ancestors = qsa(nodes, parts[0].selector);
    const result: DOMNode[] = [];
    for (const a of ancestors) {
      result.push(...findAll(a, parts[1].selector, ''));
    }
    return result;
  }
  return [];
}

function cheerioLoad(html: string): (sel: any) => any {
  const doc: DOMNode[] = parseHTML(html);

  class Cheerio {
    elements: DOMNode[];
    constructor(elements: DOMNode[]) { this.elements = elements; }
    each(fn: (i: number, el: any) => void): Cheerio {
      for (let i = 0; i < this.elements.length; i++) {
        fn.call(this.elements[i], i, this.elements[i]);
      }
      return this;
    }
    map(fn: (i: number, el: any) => any): any[] {
      const r: any[] = [];
      for (let i = 0; i < this.elements.length; i++) {
        r.push(fn.call(this.elements[i], i, this.elements[i]));
      }
      return r;
    }
    find(sel: string): Cheerio {
      const r: DOMNode[] = [];
      for (const el of this.elements) r.push(...findAll(el, sel, ''));
      return new Cheerio(r);
    }
    text(): string {
      function getText(n: DOMNode): string {
        if (n.text !== undefined) return n.text;
        let s = '';
        for (const c of n.children) s += getText(c);
        return s;
      }
      return this.elements.map(e => getText(e).trim()).filter(Boolean).join(' ');
    }
    html(): string {
      function serialize(n: DOMNode): string {
        if (n.text !== undefined) return n.text;
        let a = '';
        for (const k in n.attrs) {
          a += ` ${k}="${(n.attrs[k] || '').replace(/"/g, '&quot;')}"`;
        }
        const inner = n.children.map(c => serialize(c)).join('');
        return `<${n.tag}${a}>${inner}</${n.tag}>`;
      }
      return this.elements.map(e => serialize(e)).join('');
    }
    attr(name: string): string | undefined {
      return this.elements[0]?.attrs?.[name];
    }
    children(sel?: string): Cheerio {
      const r: DOMNode[] = [];
      for (const el of this.elements) {
        for (const c of el.children) {
          if (c.tag && (!sel || matchSelector(c, sel))) r.push(c);
        }
      }
      return new Cheerio(r);
    }
    parent(): Cheerio {
      const r: DOMNode[] = [];
      for (const el of this.elements) {
        if (el.parent) r.push(el.parent);
      }
      return new Cheerio(r);
    }
    eq(i: number): Cheerio {
      const el = this.elements[i];
      return new Cheerio(el ? [el] : []);
    }
    first(): Cheerio { return this.eq(0); }
    last(): Cheerio { return this.eq(this.elements.length - 1); }
    prev(): Cheerio {
      const r: DOMNode[] = [];
      for (const el of this.elements) {
        if (!el.parent) continue;
        const idx = el.parent.children.indexOf(el);
        for (let j = idx - 1; j >= 0; j--) {
          if (el.parent.children[j].tag) { r.push(el.parent.children[j]); break; }
        }
      }
      return new Cheerio(r);
    }
    next(): Cheerio {
      const r: DOMNode[] = [];
      for (const el of this.elements) {
        if (!el.parent) continue;
        const idx = el.parent.children.indexOf(el);
        for (let j = idx + 1; j < el.parent.children.length; j++) {
          if (el.parent.children[j].tag) { r.push(el.parent.children[j]); break; }
        }
      }
      return new Cheerio(r);
    }
    toArray(): DOMNode[] { return this.elements; }
    get length(): number { return this.elements.length; }
    val(): string { return this.elements[0]?.attrs?.['value'] || ''; }
    data(key: string): string | undefined { return this.elements[0]?.attrs?.['data-' + key]; }
    addClass(cls: string): Cheerio {
      for (const el of this.elements) {
        const cur = (el.attrs['class'] || '').split(/\s+/).filter(Boolean);
        if (!cur.includes(cls)) cur.push(cls);
        el.attrs['class'] = cur.join(' ');
      }
      return this;
    }
    removeClass(cls: string): Cheerio {
      for (const el of this.elements) {
        const cur = (el.attrs['class'] || '').split(/\s+/).filter(Boolean);
        el.attrs['class'] = cur.filter(c => c !== cls).join(' ');
      }
      return this;
    }
    hasClass(cls: string): boolean {
      const cur = (this.elements[0]?.attrs?.['class'] || '').split(/\s+/).filter(Boolean);
      return cur.includes(cls);
    }
  }

  function $(sel: any): any {
    if (typeof sel === 'string') {
      return new Cheerio(qsa(doc, sel));
    }
    if (sel && sel.tag) {
      return new Cheerio([sel as DOMNode]);
    }
    if (sel && sel.elements) {
      return sel;
    }
    return new Cheerio([]);
  }

  ($ as any).prototype = Cheerio.prototype;
  Object.setPrototypeOf($, Cheerio.prototype);
  return $;
}

function createCheerioModule(): any {
  return {
    load: cheerioLoad,
    default: { load: cheerioLoad },
  };
}

function createBigInteger(): (value: any, base?: number) => any {
  // 轻量 big-integer shim，使用 JavaScript 原生 BigInt
  // QuickJS / Go 运行时需支持 BigInt（ES2020）
  function _val(v: any, base?: number): bigint {
    if (typeof v === 'bigint') return v;
    if (v instanceof _BI) return v._v;
    if (base != null && base > 0 && typeof v === 'string') {
      return BigInt(parseInt(v, base));
    }
    try { return BigInt(v); } catch { return BigInt(0); }
  }
  class _BI {
    _v: bigint;
    constructor(v: any, base?: number) { this._v = _val(v, base); }
    add(n: any) { return new _BI(this._v + _val(n)); }
    plus(n: any) { return this.add(n); }
    subtract(n: any) { return new _BI(this._v - _val(n)); }
    minus(n: any) { return this.subtract(n); }
    multiply(n: any) { return new _BI(this._v * _val(n)); }
    times(n: any) { return this.multiply(n); }
    divide(n: any) { return new _BI(this._v / _val(n)); }
    over(n: any) { return this.divide(n); }
    mod(n: any) { return new _BI(this._v % _val(n)); }
    pow(n: any) { return new _BI(this._v ** _val(n)); }
    negate() { return new _BI(-this._v); }
    abs() { return new _BI(this._v < 0n ? -this._v : this._v); }
    equals(n: any) { return this._v === _val(n); }
    notEquals(n: any) { return this._v !== _val(n); }
    greater(n: any) { return this._v > _val(n); }
    greaterOrEquals(n: any) { return this._v >= _val(n); }
    lesser(n: any) { return this._v < _val(n); }
    lesserOrEquals(n: any) { return this._v <= _val(n); }
    compare(n: any) { const b = _val(n); return this._v < b ? -1 : this._v > b ? 1 : 0; }
    isZero() { return this._v === 0n; }
    isPositive() { return this._v > 0n; }
    isNegative() { return this._v < 0n; }
    isOdd() { return (this._v & 1n) === 1n; }
    isEven() { return (this._v & 1n) === 0n; }
    prev() { return new _BI(this._v - 1n); }
    next() { return new _BI(this._v + 1n); }
    not() { return new _BI(~this._v); }
    and(n: any) { return new _BI(this._v & _val(n)); }
    or(n: any) { return new _BI(this._v | _val(n)); }
    xor(n: any) { return new _BI(this._v ^ _val(n)); }
    shiftLeft(n: any) { return new _BI(this._v << _val(n)); }
    shiftRight(n: any) { return new _BI(this._v >> _val(n)); }
    modPow(e: any, m: any) {
      // 模幂运算：this^e % m，用于 RSA
      let base = this._v % _val(m);
      let exp = _val(e);
      let res = 1n;
      while (exp > 0n) {
        if (exp & 1n) res = (res * base) % _val(m);
        exp >>= 1n;
        base = (base * base) % _val(m);
      }
      return new _BI(res);
    }
    toString(base?: number) {
      if (base == null || base === 10) return this._v.toString();
      return this._v.toString(base);
    }
    valueOf() { return this._v; }
    toJSON() { return this._v.toString(); }
  }
  function bigInt(v?: any, base?: number): any {
    if (v instanceof _BI) return v;
    return new _BI(v == null ? 0 : v, base);
  }
  bigInt.isInstance = (v: any): boolean => v instanceof _BI;
  bigInt.min = (...a: any[]): any => a.reduce((x, y) => bigInt(x).lesser(y) ? x : y);
  bigInt.max = (...a: any[]): any => a.reduce((x, y) => bigInt(x).greater(y) ? x : y);
  bigInt.gcd = (a: any, b: any): any => {
    let x = _val(a), y = _val(b);
    while (y !== 0n) { const t = y; y = x % y; x = t; }
    return new _BI(x < 0n ? -x : x);
  };
  bigInt.lcm = (a: any, b: any): any => bigInt(a).divide(bigInt.gcd(a, b)).multiply(b);
  return bigInt;
}

export function createRequire(): (name: string) => unknown {
  return (name: string): unknown => {
    switch (name) {
      case 'crypto-js':
        return CryptoJs;
      case 'axios': {
        // 同时兼容两种写法：
        //   1) 手写 CJS：const axios = require('axios'); axios.get(...)
        //   2) webpack/babel 编译 ESM：_interopRequireDefault(require('axios')).default.get(...)
        // 直接返回 axios 函数本体，并在其上挂 default / __esModule。
        (axios as any).default = axios;
        (axios as any).__esModule = true;
        return axios;
      }
      case 'crypto':
        return {};
      case 'cheerio':
        return createCheerioModule();
      case 'he':
        return {
          decode: (s: string): string => s,
          encode: (s: string): string => s,
        };
      case 'qs':
        return {
          stringify: (obj: Record<string, any>): string => buildUrlWithParams('', obj).replace(/^[?&]/, ''),
          parse: (str: string): Record<string, string> => {
            const r: Record<string, string> = {};
            String(str).split('&').forEach((p) => {
              const i = p.indexOf('=');
              if (i > -1) r[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1));
            });
            return r;
          },
        };
      case 'dayjs':
        return () => ({ format: (): string => new Date().toISOString() });
      case 'big-integer':
        return createBigInteger();
      default:
        throw new Error('require("' + name + '") 不受支持（MusicFree 适配器仅提供 crypto-js, axios, cheerio 等常用依赖）');
    }
  };
}
