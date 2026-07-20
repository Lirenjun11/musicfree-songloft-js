# MusicFree Adapter — Songloft Plugin

**musicfree-adapter** 是一个 [Songloft](https://songloft.app) 插件，它作为一个运行时适配器，让 [MusicFree](https://github.com/maotoumao/MusicFree) 格式的音源插件能够直接在 Songloft 的 QuickJS 沙箱环境中运行。

## 工作原理

MusicFree 生态拥有大量开箱即用的音源插件（.js 文件），但它们依赖 Node.js / Hermes 运行时。本项目通过以下方式弥合差异：

1. **代码加载** — 从 URL 下载 MusicFree 插件的 JS 文件，持久化到 Songloft 的 data 目录，下次启动时可离线使用。
2. **代码预处理** — 自动将 ESM 格式（`export default`）转为 CommonJS，并将 `let/const` 替换为 `var` 以规避 QuickJS 严格的参数重声明检查。
3. **运行时垫片** — 提供 `crypto-js`、`axios`、`env`、`require` 等常用依赖的纯 JS 实现，确保 MusicFree 插件的 API 调用在 QuickJS 下正常工作。
4. **REST API** — 通过 Songloft 的 HTTP 插件接口暴露搜索、获取播放地址、歌词、歌单导入、排行榜、热门歌单等功能。
5. **Web UI** — 内置管理界面，支持插件的添加/卸载/启用/停用、更新、订阅管理，以及音乐搜索、播放与排行榜浏览。

## 功能

- 安装/卸载 MusicFree 音源插件
- 启用/停用已安装的插件
- **更新单个插件** — 在插件卡片上可单独更新指定插件
- **批量更新订阅** — 在订阅管理弹窗中一键更新所有插件（含进度条）
- 聚合搜索（同时搜索所有已启用的插件，带超时保护：单个插件 15s / 全局 17s）
- 获取歌曲播放地址（支持多音质切换与自动降级）
- 获取歌词
- 导入歌单 URL
- **排行榜** — 浏览各平台排行榜榜单，支持单曲导入与批量导入（含歌单选择）
- **热门歌单** — 浏览各平台推荐歌单
- **外部搜索 API** — 为外部应用提供搜索+获取播放地址的一站式接口
- 插件本地缓存，支持离线使用
- Web 管理界面（移动端适配）

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/plugins` | 列出已安装的插件及其能力 |
| `POST` | `/plugins` | 安装插件（body: `{ url }`） |
| `DELETE` | `/plugins` | 卸载插件（body: `{ url }`） |
| `PUT` | `/plugins` | 启用/停用插件（body: `{ url, enabled }`）；或更新插件（body: `{ url, action: "update" }`） |
| `GET` | `/search` | 搜索音乐（`?q=keyword&page=1&type=music&platform=`） |
| `POST` | `/source` | 获取播放地址（body: `{ musicItem, quality }`） |
| `GET` | `/lyric` | 获取歌词（`?platform=&id=&title=&artist=`） |
| `GET` | `/playlist/import` | 导入歌单（`?url=`） |
| `GET` | `/top-lists` | 获取各平台排行榜列表 |
| `GET` | `/top-list-detail` | 获取排行榜歌曲列表（`?platform=&id=&page=`） |
| `GET` | `/recommend-sheets/tags` | 获取各平台热门歌单分类标签 |
| `GET` | `/recommend-sheets/list` | 获取热门歌单列表（`?platform=&tag=&page=`） |
| `POST` | `/external/search` | 外部搜索接口：搜索歌曲并返回可直接播放的 URL（body: `{ keyword, quality?, id?, title?, artist?, duration? }`） |
| `GET` | `/external/endpoint` | 列出所有可用外部端点信息 |

## 外部搜索 API

提供给外部应用（如手机客户端）使用的搜索接口。

### `POST /external/search`

请求体：

```json
{
  "keyword": "十年",
  "quality": "standard",
  "id": "可选，用于 hint 匹配",
  "title": "可选，用于 hint 匹配",
  "artist": "可选，用于 hint 匹配",
  "duration": "可选，用于 hint 匹配"
}
```

响应：

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "title": "十年",
    "artist": "陈奕迅",
    "album": "黑白灰",
    "duration": 240,
    "cover_url": "https://...",
    "url": "https://...",
    "source_data": { "platform": "neteasemusic", "quality": "standard", "songInfo": { ... } }
  }
}
```

说明：
- `quality` 字段会被忽略，实际使用插件设置中的默认音质并自动降级
- 返回的 URL 会经过音质校验，确保与请求的音质匹配
- 自动调用 `getMusicInfo` 获取完整歌曲信息（types/hash 等），提高播放成功率

## 排行榜

- `GET /top-lists` — 获取所有插件提供的排行榜列表
- `GET /top-list-detail?platform=&id=&page=` — 获取某个排行榜的歌曲列表（分页）
- Web UI 中支持歌曲预览、单曲导入、批量选择导入
- 批量导入时可选择已有歌单或创建新歌单

## 热门歌单

- `GET /recommend-sheets/tags` — 获取每个插件的推荐歌单分类标签
- `GET /recommend-sheets/list?platform=&tag=&page=` — 获取某个分类下的歌单列表
- Web UI 中通过导航栏可切换浏览

## 插件更新

- **单个更新** — 在插件列表的每个插件卡片上点击「更新」按钮，自动下载最新版本
- **批量更新** — 在订阅管理弹窗中点击「全部更新」，依次更新所有非付费插件（srcUrl 的插件会被跳过），实时显示进度条

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器（热更新）
npm run dev

# 构建
npm run build
```

## 技术栈

- **TypeScript** — 核心逻辑
- **@songloft/plugin-sdk** — Songloft 插件 SDK
- **QuickJS** — 沙箱运行时环境
- **原生 JS** — Web 管理界面（无框架依赖）

## 免责声明

本项目仅供个人学习与技术研究，禁止商用。音源脚本、歌曲、歌词、封面和平台数据的版权归其各自权利人所有。用户须自行确认使用行为符合当地法律、平台条款和版权要求，并自行清除使用过程中产生的版权数据。项目维护者不提供、不托管、不推荐任何第三方音源脚本，也不对第三方脚本或数据的可用性、安全性、合法性负责。

## 许可

MIT
