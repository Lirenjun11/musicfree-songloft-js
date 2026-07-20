/// <reference types="@songloft/plugin-sdk" />
import { jsonResponse, createRouter, parseQuery, type HTTPRequest, type HTTPResponse } from '@songloft/plugin-sdk';
import { CryptoJs, axios, sanitizePluginCode, createEnv, createRequire } from './mf-runtime';

const PLUGIN_TIMEOUT = 30000;
const QUALITY_ORDER = ['super', 'high', 'standard', 'low'];

function normalizeDuration(d: any): number {
  if (d == null) return 0;
  if (typeof d === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(d.trim())) {
    const parts = d.trim().split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  let n = typeof d === 'number' ? d : parseFloat(String(d));
  if (isNaN(n) || n <= 0) return 0;
  if (n > 600) n = n / 1000;
  return Math.round(n);
}

interface MusicItem {
  id: string;
  title: string;
  artist: string | string[];
  album: string;
  duration: number;
  artwork: string;
  url: string;
  platform: string;
}

interface MediaSource {
  url: string;
  headers?: Record<string, string>;
  userAgent?: string;
  quality?: string;
  _fallback?: string[];
}

interface LyricResult {
  rawLrc?: string;
  translation?: string;
}

interface SearchResult {
  isEnd: boolean;
  data: MusicItem[];
}

interface MusicSheetItem {
  id: string;
  title: string;
  description?: string;
  coverImg?: string;
  platform?: string;
  [key: string]: any;
}

interface TopListGroup {
  title?: string;
  data: MusicSheetItem[];
}

interface TopListDetailResult {
  isEnd: boolean;
  musicList: MusicItem[];
  sheetItem?: Partial<MusicSheetItem>;
}

interface MusicSheetInfoResult {
  isEnd?: boolean;
  musicList: MusicItem[];
  sheetItem?: Partial<MusicSheetItem>;
  [key: string]: any;
}

interface MusicFreePlugin {
  platform: string;
  version: string;
  srcUrl?: string;
  search?: (query: string, page: number, type: string) => Promise<SearchResult>;
  getMediaSource?: (musicItem: MusicItem, quality: string) => Promise<MediaSource | null>;
  getLyric?: (musicItem: MusicItem) => Promise<LyricResult | null>;
  getAlbumInfo?: (albumItem: { id: string; title?: string; artist?: string }, page: number) => Promise<unknown>;
  getArtistWorks?: (artistItem: { id: string; name: string }, page: number, type: string) => Promise<SearchResult>;
  importMusicSheet?: (url: string) => Promise<MusicItem[] | null>;
  getMusicInfo?: (musicBase: { id: string; platform?: string }) => Promise<Partial<MusicItem> | null>;
  getTopLists?: () => Promise<TopListGroup[]>;
  getTopListDetail?: (topListItem: MusicSheetItem, page: number) => Promise<TopListDetailResult>;
  getRecommendSheetTags?: () => Promise<any>;
  getRecommendSheetsByTag?: (tag: any, page: number) => Promise<SearchResult>;
  getMusicSheetInfo?: (sheetItem: MusicSheetItem, page: number) => Promise<MusicSheetInfoResult>;
}

const installedPlugins: Map<string, MusicFreePlugin> = new Map();
// 被停用的插件 URL 集合（停用后不参与搜索/播放/歌词，但仍保留安装）
const disabledPlugins: Set<string> = new Set();

function uint8ArrayToString(arr: Uint8Array): string {
  let result = '';
  for (let i = 0; i < arr.length; i++) {
    result += String.fromCharCode(arr[i]);
  }
  return result;
}

async function parseBody(req: HTTPRequest): Promise<any> {
  if (!req.body) return {};
  const str = typeof req.body === 'string' ? req.body : uint8ArrayToString(req.body as Uint8Array);
  return JSON.parse(str);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function resolveMediaSourceWithFallback(plugin: MusicFreePlugin, musicItem: MusicItem, quality: string, platform: string): Promise<MediaSource | null> {
  const startIdx = QUALITY_ORDER.indexOf(quality);
  if (startIdx === -1) return null;
  for (let i = startIdx; i < QUALITY_ORDER.length; i++) {
    const q = QUALITY_ORDER[i];
    try {
      const source = await withTimeout(plugin.getMediaSource!(musicItem, q), PLUGIN_TIMEOUT, `getMediaSource[${platform}][${q}]`);
      if (source && source.url) {
        // 校验返回的 URL 实际音质是否匹配请求的音质
        const urlQuality = detectUrlQuality(source.url);
        if (urlQuality && QUALITY_ORDER.indexOf(urlQuality) > i) {
          // URL 实际音质低于请求音质，继续尝试更低质量
          songloft.log.warn(`getMediaSource[${platform}][${q}] returned lower quality URL (detected: ${urlQuality}), trying lower quality`);
          continue;
        }
        return { ...source, quality: q, _fallback: i > startIdx ? QUALITY_ORDER.slice(startIdx, i) : undefined };
      }
    } catch (error) {
      songloft.log.warn(`getMediaSource[${platform}][${q}] failed: ${error}, trying lower quality`);
    }
  }
  return null;
}

// 根据 URL 推断实际音质等级
function detectUrlQuality(url: string): string | null {
  const lower = url.toLowerCase();
  if (/\.flac(\?|$)/i.test(lower)) return 'high';
  if (/\.mp3(\?|$)/i.test(lower)) return 'standard';
  if (/\.wav(\?|$)/i.test(lower)) return 'super';
  if (/\.ogg(\?|$)/i.test(lower)) return 'standard';
  // 酷狗 URL 中的音质标识
  if (/qu128|_128\./i.test(lower)) return 'low';
  if (/qu320|_320\./i.test(lower)) return 'standard';
  if (/quflac|_flac\./i.test(lower)) return 'high';
  return null;
}

interface LoadResult {
  plugin: MusicFreePlugin | null;
  code?: string;
  error?: string;
}

// 从 JS 源码字符串解析并实例化 MusicFree 插件
function loadPluginFromCode(code: string, url: string): LoadResult {
  try {
    if (!code || code.trim().length === 0) {
      return { plugin: null, error: '插件代码为空' };
    }

    // 检测是否返回了 HTML 而非 JS（常见于 URL 错误或 SPA 回退）
    const trimmed = code.trimStart();
    if (trimmed.startsWith('<') || trimmed.startsWith('<!--')) {
      return { plugin: null, error: 'URL 返回的是 HTML 而非 JavaScript 插件代码。请确认 URL 指向的是 MusicFree 插件 .js 文件' };
    }

    // 兼容 ES Module 格式：将 "export default" 转为 CommonJS
    let processedCode = code;
    const exportDefaultMatch = code.match(/export\s+default\s+/);
    if (exportDefaultMatch) {
      processedCode = code.replace(/export\s+default\s+/, 'module.exports = ');
    }
    // 移除可能的 import 语句（不支持）
    if (/^\s*import\s/m.test(processedCode)) {
      return { plugin: null, error: '不支持 ES Module import 语法，请使用 CommonJS 格式插件' };
    }

    // 预处理：修复 QuickJS 严格的"参数重定义"语法（let/const→var，保留 for 头）
    processedCode = sanitizePluginCode(processedCode);

    // 补丁：给格式化函数添加 duration 字段（某些插件如 元力KW 的 mapper 会丢弃 duration）
    // 匹配 'formats':VAR[...] 或者以 'artistId':VAR[...]} 结尾的对象
    processedCode = processedCode.replace(
      /'formats':(\w+)\[/g,
      "'duration':$1['duration']||0,'formats':$1["
    );
    processedCode = processedCode.replace(
      /'artistId':(\w+)(\[[^\]]*\])\}(?=[\)\}])/g,
      "'artistId':$1$2,'duration':$1['duration']||0}"
    );

    // 补丁：移除 元力KW 插件的多余歌单函数导出（仅移除 importMusicSheet / getRecommendSheetTags / getMusicSheetInfo，保留 getRecommendSheetsByTag）
    processedCode = processedCode.replace(/,'importMusicSheet':importMusicSheet/g, '');
    processedCode = processedCode.replace(/,'getRecommendSheetTags':getRecommendSheetTags/g, '');
    processedCode = processedCode.replace(/,'getMusicSheetInfo':getMusicSheetInfo/g, '');

    // 构建 MusicFree 运行时依赖
    const moduleObj = { exports: {} as any };
    const requireFn = createRequire();
    const env = createEnv({
      getUserVariables: () => {
        // 从 storage 读取用户为该插件配置的变量（JSON 字符串）
        try {
          const raw = songloft.storage.get(pluginStorageKey(url));
          if (raw) return JSON.parse(String(raw));
        } catch {
          // ignore
        }
        return {};
      },
    });

    // 关键：把插件代码放入普通函数体执行，注入 module/exports/require/env/CryptoJs/axios 等。
    // 通过参数传递而非模板字符串插值，避免插件代码中的 ${} 和反引号破坏包裹层。
    const pluginWrapper = new Function(
      'module',
      'exports',
      'require',
      'env',
      'CryptoJs',
      'axios',
      processedCode + '\n;return module.exports;'
    );
    const rawExports = pluginWrapper(moduleObj, moduleObj.exports, requireFn, env, CryptoJs, axios);

    // MusicFree 插件可能通过 module.exports = {...} 或 module.exports.default = {...} 导出
    let plugin = (rawExports && rawExports.default ? rawExports.default : rawExports) as MusicFreePlugin;
    if (!plugin || (!plugin.platform && moduleObj.exports && moduleObj.exports.platform)) {
      plugin = moduleObj.exports as MusicFreePlugin;
    }

    if (!plugin || !plugin.platform) {
      const preview = code.substring(0, 150).replace(/\n/g, ' ');
      return { plugin: null, error: '无效的插件: 缺少 platform 字段。代码预览: ' + preview };
    }
    if (!plugin.version) {
      plugin.version = '0.0.0';
    }

    songloft.log.info('Loaded plugin: ' + plugin.platform + ' v' + plugin.version);
    return { plugin, code };
  } catch (error) {
    const msg = String(error);
    if (msg.indexOf('SyntaxError') >= 0) {
      const preview = code.substring(0, 200).replace(/\n/g, ' ');
      return { plugin: null, error: '插件代码语法错误: ' + msg + '。代码预览: ' + preview };
    }
    return { plugin: null, error: '加载插件异常: ' + msg };
  }
}

// 从 URL 下载并解析插件
async function loadPluginFromUrl(url: string): Promise<LoadResult> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { plugin: null, error: `下载插件失败: HTTP ${response.status}` };
    }
    const code = await response.text();
    return loadPluginFromCode(code, url);
  } catch (error) {
    return { plugin: null, error: '加载插件异常: ' + String(error) };
  }
}

// 为插件 URL 生成稳定的本地文件名（用于把源码存到 data 目录）
function pluginFileName(url: string): string {
  return 'plugins/' + CryptoJs.MD5(url).toString() + '.js';
}

function pluginStorageKey(url: string): string {
  return 'uservars:' + CryptoJs.MD5(url).toString();
}

// 把插件源码写入 data 目录（data/jsplugins_data/musicfree-adapter/plugins/*.js）
async function savePluginCode(url: string, code: string): Promise<void> {
  try {
    await songloft.fs.mkdir('plugins', { recursive: true });
    await songloft.fs.writeFile(pluginFileName(url), code, { encoding: 'utf8' });
  } catch (error) {
    songloft.log.warn('保存插件源码失败 ' + url + ': ' + String(error));
  }
}

// 从 data 目录读取已保存的插件源码，不存在则返回 null
async function readPluginCode(url: string): Promise<string | null> {
  try {
    const path = pluginFileName(url);
    if (await songloft.fs.exists(path)) {
      return await songloft.fs.readFile(path, { encoding: 'utf8' });
    }
  } catch (error) {
    songloft.log.warn('读取插件源码失败 ' + url + ': ' + String(error));
  }
  return null;
}

// 删除 data 目录中的插件源码文件
async function deletePluginCode(url: string): Promise<void> {
  try {
    const path = pluginFileName(url);
    if (await songloft.fs.exists(path)) {
      await songloft.fs.unlink(path);
    }
  } catch (error) {
    songloft.log.warn('删除插件源码失败 ' + url + ': ' + String(error));
  }
}

async function savePlugins(): Promise<void> {
  const pluginList = Array.from(installedPlugins.entries()).map(([url, plugin]) => ({
    url,
    platform: plugin.platform,
    version: plugin.version,
    enabled: !disabledPlugins.has(url)
  }));
  await songloft.storage.set('musicfree_plugins', JSON.stringify(pluginList));
}

async function loadSavedPlugins(): Promise<void> {
  try {
    const saved = await songloft.storage.get('musicfree_plugins');
    if (!saved) return;
    const pluginList = JSON.parse(String(saved)) as Array<{ url: string; platform: string; version: string; enabled?: boolean }>;
    for (const item of pluginList) {
      // 恢复停用状态（缺省视为启用）
      if (item.enabled === false) {
        disabledPlugins.add(item.url);
      }
      // 优先读本地已保存的源码（离线可用、避免 URL 失效导致插件丢失）
      let result: LoadResult;
      const localCode = await readPluginCode(item.url);
      if (localCode) {
        result = loadPluginFromCode(localCode, item.url);
      } else {
        // 本地无缓存则从 URL 重新下载并补写到 data 目录
        result = await loadPluginFromUrl(item.url);
        if (result.plugin && result.code) {
          await savePluginCode(item.url, result.code);
        }
      }
      if (result.plugin) {
        installedPlugins.set(item.url, result.plugin);
      } else {
        songloft.log.warn('Failed to reload plugin ' + item.url + ': ' + (result.error || 'unknown'));
      }
    }
  } catch (error) {
    songloft.log.error('Error loading saved plugins: ' + String(error));
  }
}

const router = createRouter();

router.get('/plugins', () => {
  const plugins = Array.from(installedPlugins.entries()).map(([url, plugin]) => ({
    url,
    platform: plugin.platform,
    version: plugin.version,
    srcUrl: (plugin as any).srcUrl || '',
    enabled: !disabledPlugins.has(url),
    capabilities: {
      search: typeof plugin.search === 'function',
      getMediaSource: typeof plugin.getMediaSource === 'function',
      getLyric: typeof plugin.getLyric === 'function',
      getAlbumInfo: typeof plugin.getAlbumInfo === 'function',
      getArtistWorks: typeof plugin.getArtistWorks === 'function',
      importMusicSheet: typeof plugin.importMusicSheet === 'function',
      getMusicInfo: typeof plugin.getMusicInfo === 'function',
      getRecommendSheetTags: typeof plugin.getRecommendSheetTags === 'function',
      getRecommendSheetsByTag: typeof plugin.getRecommendSheetsByTag === 'function',
    }
  }));
  return jsonResponse({ plugins });
});

router.post('/plugins', async (req) => {
  try {
    const body = await parseBody(req);
    const url = body.url;
    const code = body.code;
    const force = body.force === true;

    // 本地上传：直接传入插件代码字符串
    if (code) {
      // 用内容 hash 生成稳定的本地标识，作为 url
      const hash = CryptoJs.MD5(code).toString();
      const localUrl = 'upload://' + hash + '.js';

      if (installedPlugins.has(localUrl)) {
        if (!force) {
          return jsonResponse({ error: 'Plugin already installed', useForce: true }, 409);
        }
        installedPlugins.delete(localUrl);
        await deletePluginCode(localUrl);
        disabledPlugins.delete(localUrl);
      }

      const result = loadPluginFromCode(code, localUrl);
      if (!result.plugin) {
        return jsonResponse({ error: result.error || 'Failed to load plugin' }, 500);
      }

      await savePluginCode(localUrl, code);
      installedPlugins.set(localUrl, result.plugin);
      await savePlugins();

      return jsonResponse({
        success: true,
        url: localUrl,
        platform: result.plugin.platform,
        version: result.plugin.version
      });
    }

    if (!url) {
      return jsonResponse({ error: 'URL or code is required' }, 400);
    }

    if (installedPlugins.has(url)) {
      if (!force) {
        return jsonResponse({ error: 'Plugin already installed', useForce: true }, 409);
      }
      installedPlugins.delete(url);
      await deletePluginCode(url);
      disabledPlugins.delete(url);
    }

    const result = await loadPluginFromUrl(url);
    if (!result.plugin) {
      return jsonResponse({ error: result.error || 'Failed to load plugin' }, 500);
    }

    if (result.code) {
      await savePluginCode(url, result.code);
    }

    installedPlugins.set(url, result.plugin);
    await savePlugins();

    return jsonResponse({
      success: true,
      platform: result.plugin.platform,
      version: result.plugin.version
    });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

router.delete('/plugins', async (req) => {
  try {
    const body = await parseBody(req);
    const url = body.url;

    if (!url) {
      return jsonResponse({ error: 'URL is required' }, 400);
    }

    if (!installedPlugins.has(url)) {
      return jsonResponse({ error: 'Plugin not found' }, 404);
    }

    installedPlugins.delete(url);
    await deletePluginCode(url);
    disabledPlugins.delete(url);
    await savePlugins();

    return jsonResponse({ success: true });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

router.put('/plugins', async (req) => {
  try {
    const body = await parseBody(req);
    const url = body.url;
    const enabled = body.enabled;

    if (!url) {
      return jsonResponse({ error: 'URL is required' }, 400);
    }
    if (!installedPlugins.has(url)) {
      return jsonResponse({ error: 'Plugin not found' }, 404);
    }

    if (enabled === false) {
      disabledPlugins.add(url);
    } else {
      disabledPlugins.delete(url);
    }
    await savePlugins();

    return jsonResponse({ success: true, enabled: !disabledPlugins.has(url) });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

// 更新插件
router.put('/plugins/update', async (req) => {
  try {
    const body = await parseBody(req);
    const url = body.url;

    if (!url) {
      return jsonResponse({ error: 'URL is required' }, 400);
    }
    if (!installedPlugins.has(url)) {
      return jsonResponse({ error: 'Plugin not found' }, 404);
    }

    const oldPlugin = installedPlugins.get(url)!;
    const srcUrl = (oldPlugin as any).srcUrl;
    if (!srcUrl) {
      return jsonResponse({ error: '插件没有配置更新地址 (srcUrl)' }, 400);
    }

    // 下载并加载新版本
    const result = await loadPluginFromUrl(srcUrl);
    if (!result.plugin) {
      return jsonResponse({ error: result.error || '下载更新失败' }, 500);
    }

    // 比较版本号
    if (compareVersion(result.plugin.version, oldPlugin.version) <= 0) {
      return jsonResponse({ error: '当前已是最新版本', current: oldPlugin.version, latest: result.plugin.version }, 400);
    }

    // 保存新版本（用原来的 url 覆盖）
    if (result.code) {
      await savePluginCode(url, result.code);
    }
    installedPlugins.set(url, result.plugin);
    await savePlugins();

    return jsonResponse({
      success: true,
      platform: result.plugin.platform,
      oldVersion: oldPlugin.version,
      newVersion: result.plugin.version,
    });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

router.get('/search', async (req) => {
  try {
    const queryParams = parseQuery(req.query || '');
    const query = queryParams['q'];
    const pageStr = queryParams['page'] || '1';
    const type = queryParams['type'] || 'music';
    const platformFilter = queryParams['platform'];

    if (!query) {
      return jsonResponse({ error: 'Query is required' }, 400);
    }

    const page = Math.max(1, parseInt(pageStr, 10) || 1);
    const SEARCH_TIMEOUT = 15000;

    const tasks = Array.from(installedPlugins)
      .filter(([url, plugin]) => {
        if (disabledPlugins.has(url)) return false;
        if (platformFilter && plugin.platform !== platformFilter) return false;
        return typeof plugin.search === 'function';
      })
      .map(async ([, plugin]) => {
        try {
          const result = await withTimeout(plugin.search!(query, page, type), SEARCH_TIMEOUT, `Search[${plugin.platform}]`);
          if (result && result.data) {
            return result.data.map(item => ({ ...item, platform: plugin.platform, duration: normalizeDuration(item.duration) }));
          }
        } catch (error) {
          songloft.log.warn(`Search[${plugin.platform}] failed: ${error}`);
        }
        return [] as MusicItem[];
      });

    // 全局超时：如果超时则返回已收集到的结果
    let nested: MusicItem[][];
    try {
      nested = await withTimeout(Promise.all(tasks), SEARCH_TIMEOUT + 2000, 'SearchAll');
    } catch {
      songloft.log.warn(`Search global timeout, returning partial results`);
      nested = await Promise.allSettled(tasks).then(results =>
        results.map(r => (r.status === 'fulfilled' ? r.value : []))
      );
    }
    const results = nested.flat();

    // 对时长为 0 的条目尝试通过 getMusicInfo 补充时长
    const enrichTasks: Promise<void>[] = [];
    for (const item of results) {
      if (item.duration > 0) continue;
      const plugin = Array.from(installedPlugins.values()).find(p => p.platform === item.platform);
      if (!plugin || typeof plugin.getMusicInfo !== 'function') continue;
      enrichTasks.push(
        (async () => {
          try {
            const info = await withTimeout(plugin.getMusicInfo!({ id: item.id, platform: item.platform }), PLUGIN_TIMEOUT, `getMusicInfo[${item.platform}]`);
            if (info && info.duration) {
              item.duration = normalizeDuration(info.duration);
            }
          } catch { /* ignore */ }
        })()
      );
      // 最多并行补 3 条，避免雪崩
      if (enrichTasks.length >= 3) break;
    }
    if (enrichTasks.length > 0) {
      await Promise.allSettled(enrichTasks);
    }

    return jsonResponse({ isEnd: results.length === 0, data: results });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

// 获取播放源：POST 接收完整 musicItem（含 qualities/hash 等插件所需字段）
router.post('/source', async (req) => {
  try {
    const body = await parseBody(req);
    const musicItem = body.musicItem;
    const quality = body.quality || 'standard';

    if (!musicItem || typeof musicItem !== 'object') {
      return jsonResponse({ error: 'musicItem is required' }, 400);
    }

    const platform = musicItem.platform;
    if (!platform) {
      return jsonResponse({ error: 'musicItem.platform is required' }, 400);
    }

    const plugin = Array.from(installedPlugins.values()).find(p => p.platform === platform);
    if (!plugin) {
      return jsonResponse({ error: 'Plugin not found' }, 404);
    }

    if (typeof plugin.getMediaSource !== 'function') {
      return jsonResponse({ error: 'Plugin does not support getMediaSource' }, 400);
    }

    const source = await resolveMediaSourceWithFallback(plugin, musicItem as MusicItem, quality, platform);
    if (!source) return jsonResponse({ error: 'source_not_available' }, 404);
    return jsonResponse(source);
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

// Songloft 播放远程歌曲时回调插件解析播放地址（GET 或 POST）
async function handleMusicUrl(req: HTTPRequest): Promise<HTTPResponse> {
  try {
    let sourceData: string | undefined;
    let quality = 'standard';
    if (req.method === 'POST') {
      const body = await parseBody(req);
      sourceData = body.source_data || body.musicItem;
      quality = body.quality || 'standard';
    } else {
      const qp = parseQuery(req.query || '');
      sourceData = qp['source_data'];
      quality = qp['quality'] || 'standard';
    }
    if (!sourceData) {
      return jsonResponse({ error: 'source_data is required' }, 400);
    }
    let musicItem: any;
    try { musicItem = typeof sourceData === 'string' ? JSON.parse(sourceData) : sourceData; } catch { return jsonResponse({ error: 'invalid source_data' }, 400); }
    const platform = musicItem.platform;
    if (!platform) {
      return jsonResponse({ error: 'platform is required in source_data' }, 400);
    }
    // 使用插件设置的默认音质
    if (quality === 'standard') {
      try {
        const rawSettings = await songloft.storage.get('adapter_settings');
        if (rawSettings) {
          const settings = JSON.parse(String(rawSettings));
          if (settings.defaultQuality && QUALITY_ORDER.indexOf(settings.defaultQuality) !== -1) {
            quality = settings.defaultQuality;
          }
        }
      } catch (e) { /* ignore, use passed quality */ }
    }
    const plugin = Array.from(installedPlugins.values()).find(p => p.platform === platform);
    if (!plugin || typeof plugin.getMediaSource !== 'function') {
      return jsonResponse({ error: 'plugin not found or no getMediaSource' }, 404);
    }
    const source = await resolveMediaSourceWithFallback(plugin, musicItem as MusicItem, quality, platform);
    if (!source) return jsonResponse({ error: 'source_not_available' }, 404);
    return jsonResponse(source);
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
}
router.get('/api/music/url', handleMusicUrl);
router.post('/api/music/url', handleMusicUrl);

router.post('/lyric', async (req) => {
  try {
    const body = await parseBody(req);
    const musicItem = body.musicItem;
    if (!musicItem || typeof musicItem !== 'object') {
      return jsonResponse({ error: 'musicItem is required' }, 400);
    }

    const platform = musicItem.platform;
    if (!platform) {
      return jsonResponse({ error: 'musicItem.platform is required' }, 400);
    }

    const plugins = Array.from(installedPlugins.entries())
      .filter(([url, p]) => p.platform === platform && !disabledPlugins.has(url) && typeof p.getLyric === 'function')
      .map(([url, p]) => p);

    if (plugins.length === 0) {
      return jsonResponse({ error: 'No plugin supports getLyric for this platform' }, 400);
    }

    for (const plugin of plugins) {
      try {
        const lyric = await withTimeout(plugin.getLyric!(musicItem as MusicItem), PLUGIN_TIMEOUT, `getLyric[${platform}]`);
        if (lyric && (lyric.rawLrc || lyric.translation)) {
          return jsonResponse(lyric);
        }
      } catch (error) {
        songloft.log.warn(`getLyric[${platform}] failed: ${error}, trying next plugin`);
      }
    }

    return jsonResponse({ rawLrc: '' });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

router.get('/playlist/import', async (req) => {
  try {
    const queryParams = parseQuery(req.query || '');
    const url = queryParams['url'];

    if (!url) {
      return jsonResponse({ error: 'URL is required' }, 400);
    }

    const tasks = Array.from(installedPlugins)
      .filter(([, plugin]) => typeof plugin.importMusicSheet === 'function')
      .map(async ([, plugin]) => {
        try {
          const songs = await withTimeout(plugin.importMusicSheet!(url), PLUGIN_TIMEOUT, `importMusicSheet[${plugin.platform}]`);
          if (songs) {
            return songs.map(item => ({ ...item, platform: plugin.platform }));
          }
        } catch (error) {
          songloft.log.error(`Import failed for ${plugin.platform}: ${error}`);
        }
        return [] as MusicItem[];
      });

    const nested = await Promise.all(tasks);
    const results = nested.flat();

    if (results.length === 0) {
      return jsonResponse({ error: 'No plugin could import this playlist' }, 400);
    }

    return jsonResponse({ success: true, count: results.length, songs: results });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

router.get('/settings', async () => {
  try {
    const raw = await songloft.storage.get('adapter_settings');
    const settings = raw ? JSON.parse(String(raw)) : {};
    return jsonResponse({ defaultQuality: settings.defaultQuality || 'standard' });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

router.put('/settings', async (req) => {
  try {
    const body = await parseBody(req);
    const quality = body.defaultQuality;
    if (quality && !['low', 'standard', 'high', 'super'].includes(quality)) {
      return jsonResponse({ error: 'Invalid quality' }, 400);
    }
    const raw = await songloft.storage.get('adapter_settings');
    const settings = raw ? JSON.parse(String(raw)) : {};
    settings.defaultQuality = quality || 'standard';
    await songloft.storage.set('adapter_settings', JSON.stringify(settings));
    return jsonResponse({ success: true, defaultQuality: settings.defaultQuality });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

router.get('/top-lists', async () => {
  try {
    const groups: { platform: string; title: string; items: MusicSheetItem[] }[] = [];
    const debug: any[] = [];
    for (const [url, plugin] of installedPlugins) {
      const hasTopLists = typeof plugin.getTopLists === 'function';
      debug.push({ platform: plugin.platform, hasTopLists, enabled: !disabledPlugins.has(url) });
      if (disabledPlugins.has(url) || !hasTopLists) continue;
      try {
        const listGroups = await withTimeout(plugin.getTopLists!(), PLUGIN_TIMEOUT, `getTopLists[${plugin.platform}]`);
        if (Array.isArray(listGroups)) {
          for (const g of listGroups) {
            if (!Array.isArray(g.data)) continue;
            const items = g.data.map(item => ({ ...item, platform: plugin.platform }));
            groups.push({
              platform: plugin.platform,
              title: g.title || plugin.platform,
              items,
            });
          }
        }
      } catch (error) {
        songloft.log.error(`getTopLists failed for ${plugin.platform}: ${error}`);
        debug.push({ platform: plugin.platform, error: String(error) });
      }
    }
    return jsonResponse({ groups, _debug: debug });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

router.get('/top-list-detail', async (req) => {
  try {
    const queryParams = parseQuery(req.query || '');
    const platform = queryParams['platform'];
    const id = queryParams['id'];
    const page = Math.max(1, parseInt(queryParams['page'] || '1', 10));

    if (!platform || !id) {
      return jsonResponse({ error: 'platform and id are required' }, 400);
    }

    const plugin = Array.from(installedPlugins.values()).find(p => p.platform === platform);
    if (!plugin) {
      return jsonResponse({ error: 'Plugin not found' }, 404);
    }
    if (typeof plugin.getTopListDetail !== 'function') {
      return jsonResponse({ error: 'Plugin does not support getTopListDetail' }, 400);
    }

    const topListItem: MusicSheetItem = { id, title: '', platform };
    for (const key in queryParams) {
      if (key !== 'platform' && key !== 'id' && key !== 'page') {
        (topListItem as any)[key] = queryParams[key];
      }
    }

    const result = await withTimeout(plugin.getTopListDetail!(topListItem, page), PLUGIN_TIMEOUT, `getTopListDetail[${platform}]`);
    if (!result) {
      return jsonResponse({ error: 'Failed to get top list detail' }, 500);
    }

    return jsonResponse({
      isEnd: result.isEnd !== false,
      songs: (result.musicList || []).map((s: any) => ({ ...s, platform })),
      sheetItem: result.sheetItem,
    });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

// === 热门歌单 ===
// 获取所有启用插件的热门歌单（与 /top-lists 逻辑一致，一次性返回所有平台）
router.get('/recommend-sheets', async () => {
  try {
    const groups: { platform: string; title: string; items: MusicSheetItem[] }[] = [];
    for (const [url, plugin] of installedPlugins) {
      if (disabledPlugins.has(url) || typeof plugin.getRecommendSheetsByTag !== 'function') continue;
      try {
        // 先试 null tag，失败则试 {}（兼容不同插件的参数期待）
        let result: any;
        try {
          result = await withTimeout(plugin.getRecommendSheetsByTag!(null, 1), PLUGIN_TIMEOUT, `getRecommendSheetsByTag[${plugin.platform}]`);
        } catch {
          result = await withTimeout(plugin.getRecommendSheetsByTag!({} as any, 1), PLUGIN_TIMEOUT, `getRecommendSheetsByTag[${plugin.platform}]`);
        }
        if (result && Array.isArray(result.data)) {
          const items = result.data.map((item: any) => ({ ...item, platform: plugin.platform }));
          groups.push({
            platform: plugin.platform,
            title: plugin.platform,
            items,
          });
        }
      } catch (error) {
        songloft.log.error(`getRecommendSheetsByTag failed for ${plugin.platform}: ${error}`);
      }
    }
    return jsonResponse({ groups });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

router.get('/recommend-sheets/tags', async () => {
  try {
    const tagsByPlatform: { platform: string; tags: string[] }[] = [];
    for (const [url, plugin] of installedPlugins) {
      if (disabledPlugins.has(url) || typeof plugin.getRecommendSheetTags !== 'function') continue;
      try {
        const tags = await withTimeout(plugin.getRecommendSheetTags!(), PLUGIN_TIMEOUT, `getRecommendSheetTags[${plugin.platform}]`);
        // 部分插件返回嵌套对象而非 string[]，尝试提取
        let normalizedTags: string[] = [];
        if (Array.isArray(tags)) {
          // 已经是 string[]，直接保留
          normalizedTags = tags.filter((t: any) => typeof t === 'string');
        } else if (tags && typeof tags === 'object') {
          // 可能是 { data: [{ title, data: [{ title }] }], pinned: [{ title }] }
          const extract = (list: any[]): string[] =>
            (list || []).map((item: any) => item.title || item.name || item.id || String(item)).filter(Boolean);
          if (Array.isArray(tags.data) || Array.isArray(tags.pinned)) {
            // 提取 pinned
            if (Array.isArray(tags.pinned)) normalizedTags.push(...extract(tags.pinned));
            // 提取 data 中每个子组的 title
            if (Array.isArray(tags.data)) {
              for (const group of tags.data) {
                if (Array.isArray(group.data)) normalizedTags.push(...extract(group.data));
                else normalizedTags.push(...extract([group]));
              }
            }
          } else {
            songloft.log.warn(`getRecommendSheetTags[${plugin.platform}] returned unknown object: ${JSON.stringify(tags).substring(0, 200)}`);
          }
        } else {
          songloft.log.warn(`getRecommendSheetTags[${plugin.platform}] returned unexpected type=${typeof tags}`);
        }
        // 去重并过滤空值
        normalizedTags = [...new Set(normalizedTags.filter(Boolean))];
        if (normalizedTags.length > 0) {
          tagsByPlatform.push({ platform: plugin.platform, tags: normalizedTags });
        }
      } catch (error) {
        songloft.log.warn(`getRecommendSheetTags failed for ${plugin.platform}: ${error}`);
      }
    }
    return jsonResponse({ tagsByPlatform });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

router.get('/recommend-sheets/list', async (req) => {
  try {
    const queryParams = parseQuery(req.query || '');
    const platform = queryParams['platform'];
    const tag = queryParams['tag'];
    const pageStr = queryParams['page'] || '1';
    const pageSize = Math.min(50, Math.max(1, parseInt(queryParams['pageSize'] || '50', 10) || 50));

    if (!platform || !tag) {
      return jsonResponse({ error: 'platform and tag are required' }, 400);
    }

    const page = Math.max(1, parseInt(pageStr, 10) || 1);
    const plugin = Array.from(installedPlugins.values()).find(p => p.platform === platform);
    if (!plugin) {
      return jsonResponse({ error: 'Plugin not found' }, 404);
    }
    if (typeof plugin.getRecommendSheetsByTag !== 'function') {
      return jsonResponse({ error: 'Plugin does not support getRecommendSheetsByTag' }, 400);
    }

    const result = await withTimeout(plugin.getRecommendSheetsByTag(tag, page), PLUGIN_TIMEOUT, `getRecommendSheetsByTag[${platform}]`);
    if (!result || !Array.isArray(result.data)) {
      return jsonResponse({ isEnd: true, sheets: [] });
    }

    const allSheets = result.data;
    const hasMore = allSheets.length > pageSize;
    const sheets = allSheets.slice(0, pageSize).map((item: any) => ({ ...item, platform }));

    return jsonResponse({
      isEnd: hasMore ? false : (result.isEnd !== false),
      sheets,
    });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

// 简化版热门歌单：跳过 tags 步骤，直接调用 getRecommendSheetsByTag(null, 1) 获取默认推荐
router.get('/recommend-sheets/by-platform', async (req) => {
  try {
    const queryParams = parseQuery(req.query || '');
    const platform = queryParams['platform'];
    if (!platform) {
      return jsonResponse({ error: 'platform is required' }, 400);
    }
    const plugin = Array.from(installedPlugins.values()).find(p => p.platform === platform);
    if (!plugin) {
      return jsonResponse({ error: 'Plugin not found' }, 404);
    }
    if (typeof plugin.getRecommendSheetsByTag !== 'function') {
      return jsonResponse({ error: 'Plugin does not support getRecommendSheetsByTag' }, 400);
    }
    // 先试 null tag，失败则试 {}（兼容不同插件的参数期待）
    let result;
    try {
      result = await withTimeout(plugin.getRecommendSheetsByTag(null, 1), PLUGIN_TIMEOUT, `getRecommendSheetsByTag[${platform}]`);
    } catch {
      result = await withTimeout(plugin.getRecommendSheetsByTag({}, 1), PLUGIN_TIMEOUT, `getRecommendSheetsByTag[${platform}]`);
    }
    if (!result || !Array.isArray(result.data)) {
      return jsonResponse({ sheets: [] });
    }
    const sheets = result.data.map((item: any) => ({ ...item, platform }));
    return jsonResponse({ sheets, isEnd: result.isEnd !== false });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

router.get('/recommend-sheets/detail', async (req) => {
  try {
    const queryParams = parseQuery(req.query || '');
    const platform = queryParams['platform'];
    const id = queryParams['id'];
    const pageStr = queryParams['page'] || '1';
    const pageSize = Math.min(50, Math.max(1, parseInt(queryParams['pageSize'] || '50', 10) || 50));

    if (!platform || !id) {
      return jsonResponse({ error: 'platform and id are required' }, 400);
    }

    const page = Math.max(1, parseInt(pageStr, 10) || 1);
    const plugin = Array.from(installedPlugins.values()).find(p => p.platform === platform);
    if (!plugin) {
      return jsonResponse({ error: 'Plugin not found' }, 404);
    }
    if (typeof plugin.getMusicSheetInfo !== 'function') {
      return jsonResponse({ error: 'Plugin does not support getMusicSheetInfo' }, 400);
    }

    const sheet: MusicSheetItem = { id, title: '', platform };
    // 传递所有额外参数，和 top-list-detail 逻辑一致
    for (const key in queryParams) {
      if (key !== 'platform' && key !== 'id' && key !== 'page' && key !== 'pageSize') {
        (sheet as any)[key] = queryParams[key];
      }
    }

    const result = await withTimeout(plugin.getMusicSheetInfo(sheet, page), PLUGIN_TIMEOUT, `getMusicSheetInfo[${platform}]`);
    if (!result || !Array.isArray(result.musicList)) {
      return jsonResponse({ isEnd: true, songs: [] });
    }

    const allSongs = result.musicList;
    const hasMore = allSongs.length > pageSize;
    const songs = allSongs.slice(0, pageSize).map((item: any) => ({ ...item, platform }));

    return jsonResponse({
      isEnd: hasMore ? false : (result.isEnd !== false),
      songs,
    });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

router.get('/plugin-vars', async (req) => {
  try {
    const queryParams = parseQuery(req.query || '');
    const url = queryParams['url'];
    if (!url) {
      return jsonResponse({ error: 'URL is required' }, 400);
    }
    if (!installedPlugins.has(url)) {
      return jsonResponse({ error: 'Plugin not found' }, 404);
    }
    const raw = await songloft.storage.get(pluginStorageKey(url));
    return jsonResponse({ url, variables: raw ? JSON.parse(String(raw)) : {} });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

router.put('/plugin-vars', async (req) => {
  try {
    const body = await parseBody(req);
    const url = body.url;
    const variables = body.variables || {};
    if (!url) {
      return jsonResponse({ error: 'URL is required' }, 400);
    }
    if (!installedPlugins.has(url)) {
      return jsonResponse({ error: 'Plugin not found' }, 404);
    }
    await songloft.storage.set(pluginStorageKey(url), JSON.stringify(variables));
    return jsonResponse({ success: true });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

// === 外部搜索接口：给外部调用的标准化接口 ===
router.post('/external/search', async (req) => {
  try {
    const body = await parseBody(req);
    const keyword = body.keyword;
    const hint = body.hint || {};
    const requestQuality = body.quality || '320k';

    if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
      return jsonResponse({ code: 400, msg: 'keyword 参数错误', data: null });
    }

    const qualityMap: Record<string, string> = {
      '128k': 'low', 'low': 'low',
      '320k': 'standard', 'standard': 'standard',
      'flac': 'high', 'high': 'high',
      'flac24': 'super', 'super': 'super',
    };
    const quality = qualityMap[requestQuality] || 'standard';

    // 并行搜索所有启用的插件
    const tasks = Array.from(installedPlugins)
      .filter(([url, plugin]) => {
        if (disabledPlugins.has(url)) return false;
        return typeof plugin.search === 'function';
      })
      .map(async ([, plugin]) => {
        try {
          const result = await withTimeout(plugin.search!(keyword.trim(), 1, 'music'), PLUGIN_TIMEOUT, `Search[${plugin.platform}]`);
          if (result && result.data) {
            return result.data.map(item => ({ ...item, platform: plugin.platform, duration: normalizeDuration(item.duration) }));
          }
        } catch (error) {
          songloft.log.warn(`External search[${plugin.platform}] failed: ${error}`);
        }
        return [] as MusicItem[];
      });

    const nested = await Promise.all(tasks);
    const allResults = nested.flat();

    if (allResults.length === 0) {
      return jsonResponse({ code: 404, msg: '未找到歌曲', data: null });
    }

    // 使用 hint 信息匹配最佳结果
    function scoreMatch(item: MusicItem): number {
      let score = 0;
      const title = String(item.title || '').toLowerCase();
      const artist = String(item.artist || '').toLowerCase();
      const itemDuration = item.duration || 0;

      if (hint.title && title === String(hint.title).toLowerCase()) {
        score += 100;
      } else if (hint.title && title.indexOf(String(hint.title).toLowerCase()) !== -1) {
        score += 50;
      }
      if (hint.artist && artist === String(hint.artist).toLowerCase()) {
        score += 80;
      } else if (hint.artist && artist.indexOf(String(hint.artist).toLowerCase()) !== -1) {
        score += 40;
      }
      if (hint.duration && itemDuration > 0) {
        const diff = Math.abs(itemDuration - hint.duration);
        if (diff <= 5) score += 60;
        else if (diff <= 15) score += 30;
        else if (diff <= 30) score += 10;
      }
      // 标题包含关键词的基础分
      if (title.indexOf(keyword.trim().toLowerCase()) !== -1) {
        score += 20;
      }
      return score;
    }

    allResults.sort((a, b) => scoreMatch(b) - scoreMatch(a));
    const bestMatch = allResults[0];

    // 尝试获取完整歌曲信息（包含 types 等字段，插件 getMediaSource 需要这些来判断可用音质）
    let fullMusicItem: MusicItem = bestMatch;
    const matchPlugin = Array.from(installedPlugins.values()).find(p => p.platform === bestMatch.platform);
    if (matchPlugin && typeof matchPlugin.getMusicInfo === 'function') {
      try {
        const fullInfo = await withTimeout(
          matchPlugin.getMusicInfo({ id: bestMatch.id, platform: bestMatch.platform }),
          PLUGIN_TIMEOUT,
          `getMusicInfo[${bestMatch.platform}]`
        );
        if (fullInfo) {
          fullMusicItem = { ...bestMatch, ...fullInfo } as MusicItem;
          fullMusicItem.duration = normalizeDuration(fullMusicItem.duration);
        }
      } catch (e) {
        songloft.log.warn(`getMusicInfo failed for external search: ${e}`);
      }
    }

    // 获取播放地址：忽略请求中的 quality，使用设置中的默认音质并依次降级尝试
    let songUrl = '';
    let matchedQuality = '';
    // 从设置读取默认音质（与 /settings 返回值一致）
    let startQuality = 'standard';
    try {
      const rawSettings = await songloft.storage.get('adapter_settings');
      if (rawSettings) {
        const settings = JSON.parse(String(rawSettings));
        if (settings.defaultQuality && QUALITY_ORDER.indexOf(settings.defaultQuality) !== -1) {
          startQuality = settings.defaultQuality;
        }
      }
    } catch (e) { /* ignore, use default */ }

    const plugin = Array.from(installedPlugins.values()).find(p => p.platform === bestMatch.platform);
    if (plugin && typeof plugin.getMediaSource === 'function') {
      try {
        const source = await resolveMediaSourceWithFallback(plugin, fullMusicItem, startQuality, bestMatch.platform);
        if (source && source.url) {
          songUrl = source.url;
          matchedQuality = source.quality || startQuality;
        }
      } catch (error) {
        songloft.log.error(`getMediaSource failed for external search: ${error}`);
      }
    }

    if (!songUrl) {
      return jsonResponse({ code: 404, msg: '未找到可用的播放地址', data: null });
    }

    const artistStr = Array.isArray(bestMatch.artist) ? bestMatch.artist.join(' / ') : (bestMatch.artist || '');
    const finalDuration = fullMusicItem.duration || bestMatch.duration || 0;

    // 构建 source_data（完整的 musicItem 信息，供后续使用）
    const sourceData: Record<string, any> = {
      platform: bestMatch.platform,
      quality: matchedQuality,
    };
    // 保留原始 musicItem 中的关键字段
    const songInfo: Record<string, any> = {};
    if (bestMatch.id) songInfo.id = bestMatch.id;
    if ((bestMatch as any).musicId) songInfo.musicId = (bestMatch as any).musicId;
    if ((bestMatch as any).songmid) songInfo.songmid = (bestMatch as any).songmid;
    if ((bestMatch as any).hash) songInfo.hash = (bestMatch as any).hash;
    if ((bestMatch as any).copyrightId) songInfo.copyrightId = (bestMatch as any).copyrightId;
    if ((bestMatch as any).types) songInfo.types = (bestMatch as any).types;
    sourceData.songInfo = songInfo;

    return jsonResponse({
      code: 0,
      msg: 'success',
      data: {
        title: bestMatch.title || '',
        artist: artistStr,
        album: bestMatch.album || '',
        duration: finalDuration,
        cover_url: bestMatch.artwork || '',
        url: songUrl,
        source_data: sourceData,
        dedup_key: bestMatch.platform + ':' + (bestMatch.id || ''),
        plugin_entry_path: 'musicfree-adapter',
      },
    });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

// 全部更新插件（批量检查更新）
router.post('/plugins/update-all', async () => {
  try {
    const plugins = Array.from(installedPlugins.entries())
      .filter(([url, plugin]) => {
        if (disabledPlugins.has(url)) return false;
        return !!(plugin as any).srcUrl;
      })
      .map(([url, plugin]) => ({
        url,
        platform: plugin.platform,
        version: plugin.version,
        srcUrl: (plugin as any).srcUrl,
      }));

    const total = plugins.length;
    if (total === 0) {
      return jsonResponse({ total: 0, updated: 0, failed: 0, results: [] });
    }

    const results: { platform: string; oldVersion: string; newVersion?: string; error?: string }[] = [];
    let updated = 0;
    let failed = 0;

    for (let i = 0; i < total; i++) {
      const p = plugins[i];
      try {
        const result = await loadPluginFromUrl(p.srcUrl);
        if (!result.plugin) {
          failed++;
          results.push({ platform: p.platform, oldVersion: p.version, error: result.error || '下载失败' });
          continue;
        }
        if (compareVersion(result.plugin.version, p.version) <= 0) {
          results.push({ platform: p.platform, oldVersion: p.version, newVersion: result.plugin.version });
          continue;
        }
        if (result.code) {
          await savePluginCode(p.url, result.code);
        }
        installedPlugins.set(p.url, result.plugin);
        updated++;
        results.push({ platform: p.platform, oldVersion: p.version, newVersion: result.plugin.version });
      } catch (e) {
        failed++;
        results.push({ platform: p.platform, oldVersion: p.version, error: String(e) });
      }
    }

    await savePlugins();
    return jsonResponse({ total, updated, failed, results });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

// 版本比较辅助函数
function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

// 获取外部接口基础地址（供前端显示）
router.get('/external/endpoint', async (req) => {
  try {
    // 获取请求的 origin（协议+主机）
    const origin = req.headers?.origin || req.headers?.['x-forwarded-origin'] || '';
    const path = 'http://songloftserver/api/v1/jsplugin/musicfree-adapter/external/search';
    return jsonResponse({
      endpoint: origin ? origin + path : path,
      method: 'POST',
      path: path,
    });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

// ===== 订阅管理（服务端持久化） =====
interface Subscription {
  url: string;
  updatedAt: number;
  pluginCount: number;
}

async function loadSubscriptions(): Promise<Subscription[]> {
  try {
    const raw = await songloft.storage.get('musicfree_subscriptions');
    return raw ? JSON.parse(String(raw)) : [];
  } catch {
    return [];
  }
}

async function saveSubscriptions(list: Subscription[]): Promise<void> {
  await songloft.storage.set('musicfree_subscriptions', JSON.stringify(list));
}

// 获取订阅列表
router.get('/subscriptions', async () => {
  try {
    const list = await loadSubscriptions();
    return jsonResponse({ subscriptions: list });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

// 添加订阅
router.post('/subscriptions', async (req) => {
  try {
    const body = await parseBody(req);
    const url = body.url;
    if (!url) {
      return jsonResponse({ error: 'URL is required' }, 400);
    }
    const list = await loadSubscriptions();
    if (list.some(s => s.url === url)) {
      return jsonResponse({ error: '订阅已存在' }, 409);
    }
    const sub: Subscription = { url, updatedAt: Date.now(), pluginCount: 0 };
    list.push(sub);
    await saveSubscriptions(list);
    return jsonResponse({ success: true, subscription: sub });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

// 删除订阅
router.delete('/subscriptions', async (req) => {
  try {
    const body = await parseBody(req);
    const url = body.url;
    if (!url) {
      return jsonResponse({ error: 'URL is required' }, 400);
    }
    const list = await loadSubscriptions();
    const idx = list.findIndex(s => s.url === url);
    if (idx === -1) {
      return jsonResponse({ error: '订阅不存在' }, 404);
    }
    list.splice(idx, 1);
    await saveSubscriptions(list);
    return jsonResponse({ success: true });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

// 更新订阅（可修改 URL，或记录插件数量和更新时间）
router.put('/subscriptions', async (req) => {
  try {
    const body = await parseBody(req);
    const url = body.url;
    const newUrl = body.newUrl;
    const pluginCount = typeof body.pluginCount === 'number' ? body.pluginCount : 0;
    if (!url) {
      return jsonResponse({ error: 'URL is required' }, 400);
    }
    const list = await loadSubscriptions();
    const sub = list.find(s => s.url === url);
    if (!sub) {
      return jsonResponse({ error: '订阅不存在' }, 404);
    }
    // 修改订阅地址
    if (newUrl && newUrl !== url) {
      if (list.some(s => s.url === newUrl)) {
        return jsonResponse({ error: '订阅地址已存在' }, 409);
      }
      sub.url = newUrl;
    }
    sub.updatedAt = Date.now();
    sub.pluginCount = pluginCount;
    await saveSubscriptions(list);
    return jsonResponse({ success: true, subscription: sub });
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
});

// ===== 三方歌单导入：酷狗歌单解析 =====

interface KugouPlaylistParams {
  global_collection_id: string;
  specialid: string;
  platform?: 'concept' | 'standard' | 'kucode';
  kucode?: string;
}

function extractKugouParams(text: string): KugouPlaylistParams {
  const params: KugouPlaylistParams = { global_collection_id: '', specialid: '0' };
  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch {}
  try { decoded = decodeURIComponent(decoded); } catch {}
  const searchText = decoded + ' ' + text;
  const trimmed = text.trim();
  if (/^\d{7,12}$/.test(trimmed)) { params.kucode = trimmed; params.platform = 'kucode'; return params; }
  const kucodeMatch = searchText.match(/酷狗码[：: ]\s*(\d{7,12})/);
  if (kucodeMatch) { params.kucode = kucodeMatch[1]; params.platform = 'kucode'; return params; }
  const gcidMatch = searchText.match(/global_specialid[=:]([^&\s"']+)/);
  if (gcidMatch) { params.global_collection_id = gcidMatch[1]; params.platform = 'concept'; }
  if (!params.global_collection_id) {
    const pathGcidMatch = searchText.match(/[/_]gcid_([^/?&\s"']+)/);
    if (pathGcidMatch) { params.global_collection_id = pathGcidMatch[1]; params.platform = 'standard'; }
  }
  if (!params.global_collection_id) {
    const srcCidMatch = searchText.match(/src_cid[=:]([^&\s"']+)/);
    if (srcCidMatch) { params.global_collection_id = srcCidMatch[1]; params.platform = 'standard'; }
  }
  const specialidMatch = searchText.match(/[?&]specialid[=:](\d+)/);
  if (specialidMatch) params.specialid = specialidMatch[1];
  return params;
}

function md5Hex(input: string): string {
  function rh(n: number): number { return (n >>> 0); }
  function rl(n: number, c: number): number { return rh((n << c) | (n >>> (32 - c))); }
  function ad(x: number, y: number): number { return rh(x + y); }
  function cmn(q: number, a: number, b: number, x: number, s: number, t: number): number { a = ad(ad(a, q), ad(x, t)); return ad(rl(a, s), b); }
  function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function toUTF8(str: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 128) out.push(c);
      else if (c < 2048) { out.push(192 | (c >> 6)); out.push(128 | (c & 63)); }
      else if (c < 55296 || c >= 57344) { out.push(224 | (c >> 12)); out.push(128 | ((c >> 6) & 63)); out.push(128 | (c & 63)); }
      else { i++; c = 65536 + (((c & 1023) << 10) | (str.charCodeAt(i) & 1023)); out.push(240 | (c >> 18)); out.push(128 | ((c >> 12) & 63)); out.push(128 | ((c >> 6) & 63)); out.push(128 | (c & 63)); }
    }
    return out;
  }
  const bytes = toUTF8(input);
  const n = bytes.length, msgLen = n * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const lenLow = msgLen >>> 0;
  for (let i = 0; i < 4; i++) bytes.push((lenLow >>> (i * 8)) & 0xff);
  for (let i = 0; i < 4; i++) bytes.push(0);
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < bytes.length; i += 64) {
    const x: number[] = [];
    for (let j = 0; j < 16; j++) {
      const off = i + j * 4;
      x[j] = (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
    }
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[0], 7, -680876936); d = ff(d, a, b, c, x[1], 12, -389564586);
    c = ff(c, d, a, b, x[2], 17, 606105819); b = ff(b, c, d, a, x[3], 22, -1044525330);
    a = ff(a, b, c, d, x[4], 7, -176418897); d = ff(d, a, b, c, x[5], 12, 1200080426);
    c = ff(c, d, a, b, x[6], 17, -1473231341); b = ff(b, c, d, a, x[7], 22, -45705983);
    a = ff(a, b, c, d, x[8], 7, 1770035416); d = ff(d, a, b, c, x[9], 12, -1958414417);
    c = ff(c, d, a, b, x[10], 17, -42063); b = ff(b, c, d, a, x[11], 22, -1990404162);
    a = ff(a, b, c, d, x[12], 7, 1804603682); d = ff(d, a, b, c, x[13], 12, -40341101);
    c = ff(c, d, a, b, x[14], 17, -1502002290); b = ff(b, c, d, a, x[15], 22, 1236535329);
    a = gg(a, b, c, d, x[1], 5, -165796510); d = gg(d, a, b, c, x[6], 9, -1069501632);
    c = gg(c, d, a, b, x[11], 14, 643717713); b = gg(b, c, d, a, x[0], 20, -373897302);
    a = gg(a, b, c, d, x[5], 5, -701558691); d = gg(d, a, b, c, x[10], 9, 38016083);
    c = gg(c, d, a, b, x[15], 14, -660478335); b = gg(b, c, d, a, x[4], 20, -405537848);
    a = gg(a, b, c, d, x[9], 5, 568446438); d = gg(d, a, b, c, x[14], 9, -1019803690);
    c = gg(c, d, a, b, x[3], 14, -187363961); b = gg(b, c, d, a, x[8], 20, 1163531501);
    a = gg(a, b, c, d, x[13], 5, -1444681467); d = gg(d, a, b, c, x[2], 9, -51403784);
    c = gg(c, d, a, b, x[7], 14, 1735328473); b = gg(b, c, d, a, x[12], 20, -1926607734);
    a = hh(a, b, c, d, x[5], 4, -378558); d = hh(d, a, b, c, x[8], 11, -2022574463);
    c = hh(c, d, a, b, x[11], 16, 1839030562); b = hh(b, c, d, a, x[14], 23, -35309556);
    a = hh(a, b, c, d, x[1], 4, -1530992060); d = hh(d, a, b, c, x[4], 11, 1272893353);
    c = hh(c, d, a, b, x[7], 16, -155497632); b = hh(b, c, d, a, x[10], 23, -1094730640);
    a = hh(a, b, c, d, x[13], 4, 681279174); d = hh(d, a, b, c, x[0], 11, -358537222);
    c = hh(c, d, a, b, x[3], 16, -722521979); b = hh(b, c, d, a, x[6], 23, 76029189);
    a = hh(a, b, c, d, x[9], 4, -640364487); d = hh(d, a, b, c, x[12], 11, -421815835);
    c = hh(c, d, a, b, x[15], 16, 530742520); b = hh(b, c, d, a, x[2], 23, -995338651);
    a = ii(a, b, c, d, x[0], 6, -198630844); d = ii(d, a, b, c, x[7], 10, 1126891415);
    c = ii(c, d, a, b, x[14], 15, -1416354905); b = ii(b, c, d, a, x[5], 21, -57434055);
    a = ii(a, b, c, d, x[12], 6, 1700485571); d = ii(d, a, b, c, x[3], 10, -1894986606);
    c = ii(c, d, a, b, x[10], 15, -1051523); b = ii(b, c, d, a, x[1], 21, -2054922799);
    a = ii(a, b, c, d, x[8], 6, 1873313359); d = ii(d, a, b, c, x[15], 10, -30611744);
    c = ii(c, d, a, b, x[6], 15, -1560198380); b = ii(b, c, d, a, x[13], 21, 1309151649);
    a = ii(a, b, c, d, x[4], 6, -145523070); d = ii(d, a, b, c, x[11], 10, -1120210379);
    c = ii(c, d, a, b, x[2], 15, 718787259); b = ii(b, c, d, a, x[9], 21, -343485551);
    a = rh(a + oa); b = rh(b + ob); c = rh(c + oc); d = rh(d + od);
  }
  const toHex = (n: number): string => { let s = ''; for (let i = 0; i < 4; i++) { s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0'); } return s; };
  return toHex(a) + toHex(b) + toHex(c) + toHex(d);
}

function kugouSign(globalCollectionId: string, specialid: string): string {
  const data = `OIlwieks28dk2k092lksi2UIkpappid=1005area_code=1clientver=12309global_collection_id=${globalCollectionId}mode=1module=CloudMusicneed_sort=1page=1pagesize=300specialid=${specialid}type=0userid=0OIlwieks28dk2k092lksi2UIkp`;
  return md5Hex(data);
}

type TPSong = { name: string; singer: string; hash: string; album_id: string; albumName: string; duration: number; cover?: string };

// 从酷狗歌曲对象中尝试提取封面 URL
function extractKugouCover(song: Record<string, unknown>): string {
  const info = (song.info || {}) as Record<string, unknown>;
  const transParam = (song.trans_param || {}) as Record<string, unknown>;
  const albuminfo = (song.albuminfo || {}) as Record<string, unknown>;
  const singerinfo = (song.singerinfo || []) as Array<Record<string, unknown>>;
  const candidates = [
    // get_res_privilege/lite 返回
    info.image, union_cover_of(song), transParam.union_cover,
    // 标准歌单/概念歌单返回字段
    albuminfo.imgurl, albuminfo.pic, albuminfo.cover, albuminfo.img,
    song.album_img, song.imgurl, song.pic, song.cover, song.coverUrl, song.cover_url,
    song.album_logo, song.albumpic, song.albumpic_small, song.albumpic_big,
    // 歌手头像兜底
    singerinfo[0]?.imgurl, singerinfo[0]?.avatar, singerinfo[0]?.pic,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c && /^https?:\/\//i.test(c)) {
      return c.replace('{size}', '400').replace('http://', 'https://');
    }
  }
  return '';
}

// union_cover 字段可能在顶层
function union_cover_of(song: Record<string, unknown>): unknown {
  for (const k of Object.keys(song)) {
    if (k.toLowerCase() === 'union_cover') return (song as any)[k];
  }
  return undefined;
}

// 通过 get_res_privilege/lite 批量补齐歌曲封面（与酷狗码 step3 使用同一接口）
async function fillKugouCoversByHash(songs: TPSong[]): Promise<void> {
  const missing = songs.filter(s => !s.cover && s.hash);
  if (missing.length === 0) return;
  // 分批，每批最多 100 首
  const BATCH = 100;
  const kugouHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36',
    'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9', 'Content-Type': 'application/json',
  };
  const hashToCover = new Map<string, string>();
  for (let bi = 0; bi < missing.length; bi += BATCH) {
    const batch = missing.slice(bi, bi + BATCH);
    const resource = batch.map(s => ({
      album_audio_id: 0, album_id: s.album_id || '0', hash: s.hash, id: 0,
      name: `${s.singer} - ${s.name}`, page_id: 0, type: 'audio',
    }));
    const postData = {
      appid: 1001, area_code: '1', behavior: 'play', clientver: '10112',
      dfid: '2O3jKa20Gdks0LWojP3ly7ck', mid: '70a02aad1ce4648e7dca77f2afa7b182',
      need_hash_offset: 1, relate: 1, resource, token: '', userid: '0', vip: 0,
    };
    try {
      const resp = await fetch('https://gateway.kugou.com/v2/get_res_privilege/lite?appid=1001&clienttime=1668883879&clientver=10112&dfid=2O3jKa20Gdks0LWojP3ly7ck&mid=70a02aad1ce4648e7dca77f2afa7b182&userid=390523108&uuid=92691C6246F86F28B149BAA1FD370DF1', {
        method: 'POST', headers: { ...kugouHeaders, 'x-router': 'media.store.kugou.com' },
        body: JSON.stringify(postData),
      });
      if (!resp.ok) continue;
      const d = await resp.json() as Record<string, unknown>;
      const list = (d.data || []) as Array<Record<string, unknown>>;
      list.forEach(item => {
        const h = String(item.hash || '');
        const info = (item.info || {}) as Record<string, unknown>;
        const cover = String(info.image || (item as any).union_cover || '');
        if (h && cover && /^https?:\/\//i.test(cover)) {
          hashToCover.set(h, cover.replace('{size}', '400').replace('http://', 'https://'));
        }
      });
    } catch { /* ignore batch error */ }
  }
  // 回填封面
  songs.forEach(s => {
    if (!s.cover && s.hash && hashToCover.has(s.hash)) {
      s.cover = hashToCover.get(s.hash)!;
    }
  });
}

async function fetchKugouKucodePlaylist(kucode: string): Promise<{ name: string; count: number; songs: TPSong[] }> {
  const kugouHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36',
    'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9', 'Content-Type': 'application/json',
  };
  const step1Resp = await fetch('http://t.kugou.com/command/', {
    method: 'POST', headers: kugouHeaders,
    body: JSON.stringify({ appid: 1001, clientver: 9020, mid: '21511157a05844bd085308bc76ef3343', clienttime: 640612895, key: '36164c4015e704673c588ee202b9ecb8', data: kucode }),
  });
  if (!step1Resp.ok) throw new Error(`酷狗码解析失败（步骤1）: HTTP ${step1Resp.status}`);
  const step1Data = await step1Resp.json() as Record<string, unknown>;
  if (step1Data.status !== 1) throw new Error('酷狗码无效或已过期');
  const info = ((step1Data as Record<string, unknown>).data as Record<string, unknown>)?.info as Record<string, unknown>;
  if (!info) throw new Error('无法获取酷狗码信息');
  const shareId = String(info.id || ''); const userId = String(info.userid || '0');
  const collectType = Number(info.collect_type || 3); const songCount = Number(info.count || 0);
  const playlistName = String(info.special_name || info.name || '酷狗歌单');
  if (!shareId) throw new Error('酷狗码返回数据无效');

  const step2Resp = await fetch('http://www2.kugou.kugou.com/apps/kucodeAndShare/app/', {
    method: 'POST', headers: kugouHeaders,
    body: JSON.stringify({ appid: 1001, clientver: 10112, mid: '70a02aad1ce4648e7dca77f2afa7b182', clienttime: 722219501, key: '381d7062030e8a5a94cfbe50bfe65433', data: { id: shareId, type: 3, userid: userId, collect_type: collectType, page: 1, pagesize: songCount || 300 } }),
  });
  if (!step2Resp.ok) throw new Error(`获取酷狗码歌单失败（步骤2）: HTTP ${step2Resp.status}`);
  const step2Data = await step2Resp.json() as Record<string, unknown>;
  if (step2Data.status !== 1) throw new Error('获取酷狗码歌曲列表失败');
  const songList = (step2Data.data || []) as Array<Record<string, unknown>>;
  if (songList.length === 0) throw new Error('酷狗码歌单为空或已失效');

  const resource = songList.map((s: Record<string, unknown>) => ({ album_audio_id: 0, album_id: '0', hash: String(s.hash || ''), id: 0, name: String(s.filename || s.name || '').replace('.mp3', ''), page_id: 0, type: 'audio' }));
  const postData = { appid: 1001, area_code: '1', behavior: 'play', clientver: '10112', dfid: '2O3jKa20Gdks0LWojP3ly7ck', mid: '70a02aad1ce4648e7dca77f2afa7b182', need_hash_offset: 1, relate: 1, resource, token: '', userid: '0', vip: 0 };
  const step3Resp = await fetch('https://gateway.kugou.com/v2/get_res_privilege/lite?appid=1001&clienttime=1668883879&clientver=10112&dfid=2O3jKa20Gdks0LWojP3ly7ck&mid=70a02aad1ce4648e7dca77f2afa7b182&userid=390523108&uuid=92691C6246F86F28B149BAA1FD370DF1', {
    method: 'POST', headers: { ...kugouHeaders, 'x-router': 'media.store.kugou.com' }, body: JSON.stringify(postData),
  });
  if (!step3Resp.ok) throw new Error(`获取歌曲详情失败（步骤3）: HTTP ${step3Resp.status}`);
  const step3Data = await step3Resp.json() as Record<string, unknown>;
  const detailList = (step3Data.data || []) as Array<Record<string, unknown>>;

  const songs: TPSong[] = detailList.map((song: Record<string, unknown>) => {
    let title = String(song.name || song.songname || '未知歌曲');
    const singerName = String(song.singername || '');
    if (singerName && title) { const idx = title.indexOf(singerName); if (idx === 0 && title.length > singerName.length) title = title.substring(singerName.length).replace(/^[\s\-]+/, '').trim(); }
    return {
      name: title, singer: singerName, hash: String(song.hash || ''),
      album_id: String(song.album_id || '0'), albumName: String(song.albumname || song.album_name || ''),
      duration: Math.round(Number(song.duration || 0)), cover: extractKugouCover(song),
    };
  });
  // 批量补齐缺失封面（通过酷狗专辑信息接口）
  await fillKugouCoversByHash(songs);
  return { name: playlistName, count: songs.length, songs };
}

async function fetchKugouStandardPlaylist(gcid: string): Promise<{ name: string; count: number; songs: TPSong[] }> {
  const url = `https://m.kugou.com/songlist/gcid_${gcid}`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
  if (!resp.ok) throw new Error(`获取歌单页面失败: HTTP ${resp.status}`);
  const text = await resp.text();
  const startMarker = 'window.$output = '; const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) throw new Error('无法从歌单页面提取数据');
  const jsonStart = startIdx + startMarker.length;
  const endIdx = text.indexOf('</script>', jsonStart);
  if (endIdx === -1) throw new Error('无法找到数据结束位置');
  const jsonStr = text.substring(jsonStart, endIdx).trim().replace(/;$/, '');
  let output: Record<string, unknown>;
  try { output = JSON.parse(jsonStr) as Record<string, unknown>; } catch { throw new Error('歌单页面数据解析失败'); }
  const info = (output.info || {}) as Record<string, unknown>;
  const listinfo = (info.listinfo || {}) as Record<string, unknown>;
  const rawSongs = (info.songs || []) as Array<Record<string, unknown>>;
  const songs: TPSong[] = rawSongs.map((song: Record<string, unknown>) => {
    const fullName = String(song.name || '未知歌曲'); const parts = fullName.split(/\s*-\s*/);
    const songName = parts.length > 1 ? parts.slice(1).join(' - ') : fullName; const singer = parts.length > 1 ? parts[0] : '';
    const singerinfo = (song.singerinfo || []) as Array<Record<string, unknown>>;
    const singerName = singerinfo.length > 0 ? String((singerinfo[0] as Record<string, unknown>).name || singer) : singer;
    const albuminfo = (song.albuminfo || {}) as Record<string, unknown>;
    return {
      name: songName, singer: singerName, hash: String(song.hash || ''),
      album_id: String(song.album_id || ''), albumName: String(albuminfo.name || ''),
      duration: Math.round(Number(song.timelen || 0) / 1000), cover: extractKugouCover(song),
    };
  });
  await fillKugouCoversByHash(songs);
  return { name: String(listinfo.name || '酷狗歌单'), count: Number(listinfo.count || songs.length), songs };
}

async function fetchKugouConceptPlaylist(gcid: string, specialid: string): Promise<{ name: string; count: number; songs: TPSong[] }> {
  const sign = kugouSign(gcid, specialid);
  const listUrl = `https://gateway.kugou.com/pubsongs/v4/get_other_list_file?specialid=${specialid}&need_sort=1&module=CloudMusic&signature=${sign}&clientver=12309&pagesize=300&global_collection_id=${gcid}&userid=0&mode=1&page=1&type=0&area_code=1&appid=1005`;
  const resp = await fetch(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36' } });
  if (!resp.ok) throw new Error(`获取歌单失败: HTTP ${resp.status}`);
  const data = await resp.json() as Record<string, unknown>;
  const dataField = (data.data || data) as Record<string, unknown>;
  const songs = (dataField.info || dataField.list || dataField || []) as Array<Record<string, unknown>>;
  const songList: TPSong[] = songs.map((song: Record<string, unknown>) => {
    const fullName = String(song.name || song.filename || '未知歌曲'); const parts = fullName.split(/\s*-\s*/);
    const songName = parts.length > 1 ? parts.slice(1).join(' - ') : fullName; const singer = parts.length > 1 ? parts[0] : '';
    return {
      name: songName, singer, hash: String(song.hash || ''),
      album_id: String(song.album_id || ''),
      albumName: String((song.albuminfo as Record<string, unknown> | undefined)?.name || ''),
      duration: Math.round(Number(song.timelen || 0) / 1000), cover: extractKugouCover(song),
    };
  });
  await fillKugouCoversByHash(songList);
  return { name: '酷狗歌单', count: songList.length, songs: songList };
}

// ===== 酷我音乐歌单解析 =====
function extractKuwoPid(text: string): string {
  const decoded = (() => { try { return decodeURIComponent(text); } catch { return text; } })();
  const haystack = decoded + ' ' + text;
  const m = haystack.match(/playlist_detail[/#]*\/?(\d+)/);
  if (m) return m[1];
  const pidM = haystack.match(/[?&]pid=(\d+)/);
  if (pidM) return pidM[1];
  if (/^\d+$/.test(text.trim())) return text.trim();
  return '';
}

async function fetchKuwoPlaylist(pid: string): Promise<{ name: string; count: number; songs: TPSong[] }> {
  const pageSize = 100;
  let page = 1;
  const allSongs: TPSong[] = [];
  let playlistName = '酷我歌单';
  let total = 0;
  while (page <= 20) {
    const url = `https://wapi.kuwo.cn/api/www/playlist/playListInfo?pid=${pid}&pn=${page}&rn=${pageSize}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': `https://kuwo.cn/playlist_detail/${pid}`,
        'csrf': 'no',
        'Cookie': 'kw_token=no',
      },
    });
    if (!resp.ok) throw new Error(`获取酷我歌单失败: HTTP ${resp.status}`);
    const data = await resp.json() as Record<string, unknown>;
    if (Number(data.code) !== 200) throw new Error(`酷我 API 错误: ${String(data.msg || data.message || '')}`);
    const info = (data.data || {}) as Record<string, unknown>;
    if (page === 1) {
      playlistName = String(info.name || '酷我歌单');
      total = Number(info.total || 0);
    }
    const musicList = Array.isArray(info.musicList) ? info.musicList : [];
    if (musicList.length === 0) break;
    for (const s of musicList as Array<Record<string, unknown>>) {
      const pic = String(s.pic || s.albumPic || s.albumpic || '');
      allSongs.push({
        name: String(s.name || '未知歌曲'),
        singer: String(s.artist || s.singer || ''),
        hash: String(s.rid || s.musicrid || ''),
        album_id: String(s.albumid || s.albumId || ''),
        albumName: String(s.album || s.albumname || ''),
        duration: Math.round(Number(s.duration || 0)),
        cover: pic && /^https?:\/\//i.test(pic) ? pic.replace('{size}', '400') : '',
      });
    }
    if (allSongs.length >= total) break;
    page++;
  }
  return { name: playlistName, count: allSongs.length, songs: allSongs };
}

// ===== 网易云音乐歌单解析 =====
function extractNeteaseId(text: string): string {
  const decoded = (() => { try { return decodeURIComponent(text); } catch { return text; } })();
  const haystack = decoded + ' ' + text;
  const m = haystack.match(/[?&]id=(\d+)/);
  if (m) return m[1];
  const m2 = haystack.match(/playlist[/#]*\/?(\d+)/);
  if (m2) return m2[1];
  if (/^\d+$/.test(text.trim())) return text.trim();
  return '';
}

async function fetchNeteasePlaylist(playlistId: string): Promise<{ name: string; count: number; songs: TPSong[] }> {
  const detailUrl = `https://music.163.com/api/v6/playlist/detail?id=${playlistId}&n=100000&s=0`;
  const detailResp = await fetch(detailUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://music.163.com/',
      'Cookie': 'os=pc; appver=2.9.7',
    },
  });
  if (!detailResp.ok) throw new Error(`获取网易云歌单信息失败: HTTP ${detailResp.status}`);
  const detailData = await detailResp.json() as Record<string, unknown>;
  if (Number(detailData.code) !== 200) throw new Error(`网易云 API 错误: ${String(detailData.msg || '')}`);
  const playlist = (detailData.playlist || {}) as Record<string, unknown>;
  const playlistName = String(playlist.name || '网易云歌单');

  // 如果 tracks 已直接返回完整数据（歌单不大时），直接用；否则用 trackIds 批量查 song/detail
  let tracks: any[] = [];
  if (Array.isArray(playlist.tracks) && (playlist.tracks as any[]).length > 0
      && (playlist.tracks as any[])[0] && (playlist.tracks as any[])[0].name) {
    tracks = playlist.tracks as any[];
  } else {
    const trackIds = Array.isArray(playlist.trackIds) ? playlist.trackIds as Array<Record<string, unknown>> : [];
    if (trackIds.length === 0) return { name: playlistName, count: 0, songs: [] };
    const ids = trackIds.map((t) => Number(t.id)).filter((n) => n > 0);
    // 分批获取歌曲详情（每批 500）
    const BATCH = 500;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const c = `[${batch.join(',')}]`;
      const songUrl = `https://music.163.com/api/song/detail?ids=${encodeURIComponent(c)}`;
      const songResp = await fetch(songUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://music.163.com/',
          'Cookie': 'os=pc; appver=2.9.7',
        },
      });
      if (!songResp.ok) continue;
      const songData = await songResp.json() as Record<string, unknown>;
      const arr = Array.isArray(songData.songs) ? songData.songs : [];
      tracks = tracks.concat(arr as any[]);
    }
  }

  const songs: TPSong[] = [];
  for (const s of tracks) {
    const ar = Array.isArray(s.artists) ? s.artists : (Array.isArray(s.ar) ? s.ar : []);
    const artistNames = ar.map((a: Record<string, unknown>) => String(a.name || '')).filter(Boolean).join('/');
    const al = (s.album || s.al || {}) as Record<string, unknown>;
    const pic = String(al.picUrl || s.album?.picUrl || s.al?.picUrl || '');
    songs.push({
      name: String(s.name || '未知歌曲'),
      singer: artistNames,
      hash: String(s.id || ''),
      album_id: String(al.id || ''),
      albumName: String(al.name || ''),
      duration: Math.round(Number(s.dt || s.duration || 0) / 1000),
      cover: pic || '',
    });
  }
  return { name: playlistName, count: songs.length, songs };
}

// 解析三方歌单链接
router.post('/api/third-party/parse', async (req) => {
  try {
    const body = await parseBody(req);
    const url = String(body.url || '').trim();
    const platform = String(body.platform || 'kugou').trim().toLowerCase();
    if (!url) return jsonResponse({ error: 'url is required' }, 400);

    let result: { name: string; count: number; songs: TPSong[] };

    if (platform === 'kuwo') {
      const pid = extractKuwoPid(url);
      if (!pid) return jsonResponse({ error: '无法从链接中提取酷我歌单ID（pid），请粘贴 https://m.kuwo.cn/newh5app/playlist_detail/xxx 形式的链接' }, 400);
      result = await fetchKuwoPlaylist(pid);
    } else if (platform === 'netease') {
      const id = extractNeteaseId(url);
      if (!id) return jsonResponse({ error: '无法从链接中提取网易云歌单ID，请粘贴 https://music.163.com/#/playlist?id=xxx 形式的链接' }, 400);
      result = await fetchNeteasePlaylist(id);
    } else {
      // 默认酷狗
      let params = extractKugouParams(url);
      if (!params.global_collection_id && !params.kucode) {
        try {
          const resp = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36' } });
          const candidates: string[] = [];
          if (typeof (resp as any).url === 'string') candidates.push((resp as any).url);
          const h = (resp as any).headers;
          if (h && typeof h.get === 'function') { const loc = h.get('location'); if (loc) candidates.push(loc); }
          for (const c of candidates) { params = extractKugouParams(c); if (params.global_collection_id) break; }
          if (!params.global_collection_id) {
            const text = await resp.text();
            const urlMatch = text.match(/https?:\/\/[^\s"'<>]+global_specialid=[^\s"'<&]+/);
            if (urlMatch) params = extractKugouParams(urlMatch[0]);
          }
        } catch { }
      }

      if (params.platform === 'kucode') {
        if (!params.kucode) return jsonResponse({ error: 'kucode is required' }, 400);
        result = await fetchKugouKucodePlaylist(params.kucode);
      } else if (params.platform === 'standard') {
        result = await fetchKugouStandardPlaylist(params.global_collection_id);
      } else if (params.global_collection_id) {
        result = await fetchKugouConceptPlaylist(params.global_collection_id, params.specialid || '0');
      } else {
        return jsonResponse({ error: '无法解析酷狗链接，请使用酷狗码或包含 gcid/global_collection_id 的歌单链接' }, 400);
      }
    }
    return jsonResponse({ success: true, platform, total: result.songs.length, songs: result.songs, playlistName: result.name });
  } catch (e) { return jsonResponse({ error: `解析失败: ${String(e)}` }, 500); }
});

// 搜索单曲匹配（先本地 songloft 库，再 MusicFree 插件）
router.post('/api/third-party/match', async (req) => {
  try {
    const body = await parseBody(req);
    const name = String(body.name || '').trim();
    const singer = String(body.singer || '').trim();
    if (!name) return jsonResponse({ error: 'name is required' }, 400);

    // 归一化字符串：转小写、去空白、去常见标点/符号
    const normalize = (s: string) =>
      String(s || '').toLowerCase().replace(/[\s\-_.·・,，。.!！?？、~～"'"\'()（）\[\]【】]/g, '');
    const nameNorm = normalize(name);
    const singerNorm = normalize(singer);

    // 1. 优先匹配 songloft 本地库
    let localBest: any = null;
    let localBestScore = -1;
    try {
      const sl = (globalThis as any).songloft;
      if (sl?.songs?.list) {
        const localSongs = sl.songs.list({ limit: 5000, offset: 0 }) as Array<{
          id: number; title: string; artist: string; album: string; duration: number;
          cover_url?: string; source_data?: any;
        }>;
        for (const s of localSongs) {
          const tNorm = normalize(s.title);
          const aNorm = normalize(s.artist);
          if (!tNorm) continue;
          let score = -1;
          // 1a. 标题与艺术家完全相等（含归一化后）
          if (tNorm === nameNorm) {
            if (singerNorm && aNorm === singerNorm) score = 100;
            else if (!singerNorm) score = 90;
            else if (aNorm && (aNorm.includes(singerNorm) || singerNorm.includes(aNorm))) score = 80;
          }
          // 1b. 标题互相包含
          else if (nameNorm && (tNorm.includes(nameNorm) || nameNorm.includes(tNorm))) {
            if (singerNorm && aNorm === singerNorm) score = 70;
            else if (singerNorm && aNorm && (aNorm.includes(singerNorm) || singerNorm.includes(aNorm))) score = 60;
            else if (!singerNorm) score = 50;
          }
          if (score > localBestScore) {
            localBestScore = score;
            localBest = s;
            if (score === 100) break; // 满分直接返回
          }
        }
        if (localBest && localBestScore >= 50) {
          let srcData: any = null;
          try { srcData = typeof localBest.source_data === 'string' ? JSON.parse(localBest.source_data) : localBest.source_data; } catch { srcData = null; }
          // 只有 source_data 含有效 platform/id 时才能走插件解析播放
          const validSrc = srcData && srcData.platform && srcData.id && srcData.platform !== 'local';
          const playItem = validSrc
            ? { ...srcData, title: localBest.title, artist: localBest.artist, album: localBest.album || srcData.album, artwork: localBest.cover_url || srcData.artwork, duration: normalizeDuration(localBest.duration) || srcData.duration }
            : null;
          return jsonResponse({
            matched: true, source: 'local', title: localBest.title, artist: localBest.artist || '',
            album: localBest.album || '', duration: normalizeDuration(localBest.duration) || 0,
            cover_url: localBest.cover_url || '',
            source_data: playItem,
            local_song_id: localBest.id, // 已存在本地库，导入时可跳过
            playable: !!playItem,
          });
        }
      }
    } catch { }

    // 2. 本地库未找到：再走 MusicFree 插件搜索
    const keyword = `${name} ${singer}`.trim();
    const tasks = Array.from(installedPlugins).filter(([url]) => !disabledPlugins.has(url) && typeof url === 'string').filter(([, p]) => typeof p.search === 'function').map(async ([, p]) => {
      try {
        const result = await withTimeout(p.search!(keyword, 1, 'music'), PLUGIN_TIMEOUT, `search[${p.platform}]`);
        if (result?.data) return result.data.map((item: any) => ({ ...item, platform: p.platform, duration: normalizeDuration(item.duration) }));
      } catch { }
      return [] as MusicItem[];
    });
    const nested = await Promise.all(tasks);
    const allResults = nested.flat();

    if (allResults.length > 0) {
      // 插件结果也用归一化打分，挑最匹配的
      let best: any = null;
      let bestScore = -1;
      for (const r of allResults) {
        const tNorm = normalize(r.title);
        const aRaw = Array.isArray(r.artist) ? r.artist.join(' ') : (r.artist || '');
        const aNorm = normalize(aRaw);
        let score = 0;
        if (tNorm === nameNorm) {
          if (singerNorm && aNorm === singerNorm) score = 100;
          else if (!singerNorm) score = 90;
          else if (aNorm && (aNorm.includes(singerNorm) || singerNorm.includes(aNorm))) score = 80;
          else score = 70;
        } else if (tNorm && (tNorm.includes(nameNorm) || nameNorm.includes(tNorm))) {
          if (singerNorm && aNorm === singerNorm) score = 60;
          else if (singerNorm && aNorm && (aNorm.includes(singerNorm) || singerNorm.includes(aNorm))) score = 50;
          else score = 40;
        }
        if (score > bestScore) { bestScore = score; best = r; if (score === 100) break; }
      }
      if (!best) best = allResults[0];
      const artistStr = Array.isArray(best.artist) ? best.artist.join(' / ') : (best.artist || '');
      return jsonResponse({
        matched: true, source: 'plugin', title: best.title, artist: artistStr,
        album: best.album || '', duration: best.duration || 0, cover_url: best.artwork || '',
        source_data: { platform: best.platform, id: best.id, title: best.title, artist: best.artist, album: best.album, duration: best.duration, artwork: best.artwork, qualities: best.qualities },
      });
    }

    return jsonResponse({ matched: false, error: '未找到匹配歌曲' });
  } catch (e) { return jsonResponse({ error: String(e) }, 500); }
});

// 获取 Songloft 歌单列表
router.get('/api/songloft-playlists', async (req) => {
  try {
    const auth = req.headers?.authorization || '';
    const origin = req.headers?.origin || req.headers?.['x-forwarded-host'] || '';
    const host = origin ? `https://${origin.replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : 'https://songloftserver';
    const resp = await fetch(`${host}/api/v1/playlists`, { headers: { 'Content-Type': 'application/json', Authorization: auth } });
    if (!resp.ok) return jsonResponse({ success: false, error: await resp.text() }, 500);
    const data = await resp.json();
    return jsonResponse({ success: true, playlists: (data as any).playlists || [] });
  } catch (e) { return jsonResponse({ success: false, error: String(e) }, 500); }
});

// 获取 Songloft 歌单列表
router.get('/api/songloft-playlists', async (req) => {
  try {
    const auth = req.headers?.authorization || '';
    const host = 'https://songloftserver';
    const resp = await fetch(`${host}/api/v1/playlists`, { headers: { 'Content-Type': 'application/json', Authorization: auth } });
    if (!resp.ok) return jsonResponse({ success: false, error: await resp.text() }, 500);
    const data = await resp.json();
    return jsonResponse({ success: true, playlists: (data as any).playlists || [] });
  } catch (e) { return jsonResponse({ success: false, error: String(e) }, 500); }
});

// ===== MIoT 搜索源注册（对齐 songloft-plugin-bili 的实现） =====
// 延迟 + 重试，规避与 miot 同时启动的竞态；
// miot 未安装 / 旧版 host 无 comm 时静默跳过，绝不阻塞自身功能。
function registerToMiot(): void {
  let attempts = 0;
  const tryRegister = async () => {
    attempts++;
    try {
      if (!songloft.comm || typeof songloft.comm.call !== 'function') return; // 旧 host 无 comm
      await songloft.comm.call('miot', 'register-search-provider', {
        name: 'MusicFree',
        searchPath: '/api/search/topone',
        // searchPath: '/external/search',
      });
      songloft.log.info('[miot] 已向 miot 注册搜索源候选: MusicFree 音源');
    } catch (e) {
      if (attempts < 5) {
        setTimeout(tryRegister, 3000);
      } else {
        songloft.log.info('[miot] miot 未安装/未就绪，放弃注册: ' + String(e));
      }
    }
  };
  setTimeout(tryRegister, 2000);
}

// POST /api/search/topone — 专供 miot 调用的搜索接口（与 Subsonic 插件路径一致）
router.post('/api/search/topone', async (req) => {
  try {
    const body = await parseBody(req);
    const keyword = String(body.keyword || '').trim();
    const hint = body.hint || {};
    const requestQuality = body.quality || '320k';

    if (!keyword) {
      return jsonResponse({ code: 400, msg: 'keyword 参数错误', data: null });
    }

    const qualityMap: Record<string, string> = {
      '128k': 'low', 'low': 'low',
      '320k': 'standard', 'standard': 'standard',
      'flac': 'high', 'high': 'high',
      'flac24': 'super', 'super': 'super',
    };
    const quality = qualityMap[requestQuality] || 'standard';

    // 并行搜索所有启用的插件
    const tasks = Array.from(installedPlugins)
      .filter(([url, plugin]) => !disabledPlugins.has(url) && typeof plugin.search === 'function')
      .map(async ([, plugin]) => {
        try {
          const result = await withTimeout(plugin.search!(keyword, 1, 'music'), PLUGIN_TIMEOUT, `Search[${plugin.platform}]`);
          if (result && result.data) {
            return result.data.map(item => ({ ...item, platform: plugin.platform, duration: normalizeDuration(item.duration) }));
          }
        } catch (error) {
          songloft.log.warn(`External search[${plugin.platform}] failed: ${error}`);
        }
        return [] as MusicItem[];
      });

    const nested = await Promise.all(tasks);
    const allResults = nested.flat();

    if (allResults.length === 0) {
      return jsonResponse({ code: 404, msg: '未找到歌曲', data: null });
    }

    function scoreMatch(item: MusicItem): number {
      let score = 0;
      const title = String(item.title || '').toLowerCase();
      const artist = String(item.artist || '').toLowerCase();
      const itemDuration = item.duration || 0;

      if (hint.title && title === String(hint.title).toLowerCase()) score += 100;
      else if (hint.title && title.indexOf(String(hint.title).toLowerCase()) !== -1) score += 50;
      if (hint.artist && artist === String(hint.artist).toLowerCase()) score += 80;
      else if (hint.artist && artist.indexOf(String(hint.artist).toLowerCase()) !== -1) score += 40;
      if (hint.duration && itemDuration > 0) {
        const diff = Math.abs(itemDuration - hint.duration);
        if (diff <= 5) score += 60;
        else if (diff <= 15) score += 30;
        else if (diff <= 30) score += 10;
      }
      if (title.indexOf(keyword.toLowerCase()) !== -1) score += 20;
      return score;
    }

    allResults.sort((a, b) => scoreMatch(b) - scoreMatch(a));
    const bestMatch = allResults[0];

    // 尝试获取完整歌曲信息
    let fullMusicItem: MusicItem = bestMatch;
    const matchPlugin = Array.from(installedPlugins.values()).find(p => p.platform === bestMatch.platform);
    if (matchPlugin && typeof matchPlugin.getMusicInfo === 'function') {
      try {
        const fullInfo = await withTimeout(
          matchPlugin.getMusicInfo({ id: bestMatch.id, platform: bestMatch.platform }),
          PLUGIN_TIMEOUT, `getMusicInfo[${bestMatch.platform}]`
        );
        if (fullInfo) {
          fullMusicItem = { ...bestMatch, ...fullInfo } as MusicItem;
          fullMusicItem.duration = normalizeDuration(fullMusicItem.duration);
        }
      } catch (e) {
        songloft.log.warn(`getMusicInfo failed for topone search: ${e}`);
      }
    }

    // 获取播放地址
    let songUrl = '';
    let startQuality = 'standard';
    try {
      const rawSettings = await songloft.storage.get('adapter_settings');
      if (rawSettings) {
        const settings = JSON.parse(String(rawSettings));
        if (settings.defaultQuality && QUALITY_ORDER.indexOf(settings.defaultQuality) !== -1) {
          startQuality = settings.defaultQuality;
        }
      }
    } catch (e) {}

    const plugin = Array.from(installedPlugins.values()).find(p => p.platform === bestMatch.platform);
    if (plugin && typeof plugin.getMediaSource === 'function') {
      try {
        const source = await resolveMediaSourceWithFallback(plugin, fullMusicItem, startQuality, bestMatch.platform);
        if (source && source.url) {
          songUrl = source.url;
        }
      } catch (error) {
        songloft.log.error(`getMediaSource failed for topone search: ${error}`);
      }
    }

    if (!songUrl) {
      return jsonResponse({ code: 404, msg: '未找到可用的播放地址', data: null });
    }

    const artistStr = Array.isArray(bestMatch.artist) ? bestMatch.artist.join(' / ') : (bestMatch.artist || '');
    const finalDuration = fullMusicItem.duration || bestMatch.duration || 0;

    // source_data 必须与 /api/music/url 的入参约定一致：
    // handleMusicUrl 会把整个 sourceData 作为 musicItem 直接传给 MusicFree 插件的 getMediaSource，
    // 因此 id / hash / songmid 等插件用于解析播放地址的字段必须放在顶层，不能嵌套在 songInfo 下。
    const sourceData: Record<string, any> = { platform: bestMatch.platform };
    if (bestMatch.id) sourceData.id = bestMatch.id;
    if ((bestMatch as any).musicId) sourceData.musicId = (bestMatch as any).musicId;
    if ((bestMatch as any).songmid) sourceData.songmid = (bestMatch as any).songmid;
    if ((bestMatch as any).hash) sourceData.hash = (bestMatch as any).hash;
    if ((bestMatch as any).copyrightId) sourceData.copyrightId = (bestMatch as any).copyrightId;
    if ((bestMatch as any).types) sourceData.types = (bestMatch as any).types;
    // 同步 fullMusicItem 中可能补全的其他字段（如 qualities、lrc 等）
    for (const key of Object.keys(fullMusicItem)) {
      if (!(key in sourceData) && (fullMusicItem as any)[key] !== undefined) {
        (sourceData as any)[key] = (fullMusicItem as any)[key];
      }
    }

    return jsonResponse({
      code: 0,
      msg: 'success',
      data: {
        title: bestMatch.title || '',
        artist: artistStr,
        album: bestMatch.album || '',
        duration: finalDuration,
        cover_url: bestMatch.artwork || '',
        url: songUrl,
        source_data: sourceData,
        dedup_key: bestMatch.platform + ':' + (bestMatch.id || ''),
        plugin_entry_path: 'musicfree-adapter',
      },
    });
  } catch (error) {
    return jsonResponse({ code: 500, msg: String(error), data: null });
  }
});

async function onInit(): Promise<void> {
  songloft.log.info('MusicFree adapter plugin initialized');
  // 注册 miot 搜索源独立于插件加载，fire-and-forget 不阻塞 onInit，
  // 避免 loadSavedPlugins 的 IO/网络耗时导致注册超时重试多次。
  registerToMiot();
  await loadSavedPlugins();
}

async function onDeinit(): Promise<void> {
  songloft.log.info('MusicFree adapter plugin deinitialized');
  try {
    if (songloft.comm && typeof songloft.comm.call === 'function') {
      await songloft.comm.call('miot', 'unregister-search-provider', {});
    }
  } catch { }
  installedPlugins.clear();
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req);
}

// 生命周期函数挂载到全局（对齐 bili/ytdlp 等参考实现的写法）
globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;