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
  getRecommendSheetTags?: () => Promise<string[]>;
  getRecommendSheetsByTag?: (tag: any, page: number) => Promise<SearchResult>;
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
    const pageSize = Math.min(50, Math.max(1, parseInt(queryParams['pageSize'] || '20', 10) || 20));

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
    const pageSize = Math.min(50, Math.max(1, parseInt(queryParams['pageSize'] || '20', 10) || 20));

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

async function onInit(): Promise<void> {
  songloft.log.info('MusicFree adapter plugin initialized');
  await loadSavedPlugins();
}

async function onDeinit(): Promise<void> {
  songloft.log.info('MusicFree adapter plugin deinitialized');
  installedPlugins.clear();
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req);
}

// QuickJS 全局注入：将生命周期函数挂载到全局对象
const g = globalThis as Record<string, unknown>;
g.onInit = onInit;
g.onDeinit = onDeinit;
g.onHTTPRequest = onHTTPRequest;