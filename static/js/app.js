(function () {
  var BASE = '/api/v1/jsplugin/musicfree-adapter';

  function getToken() {
    var auth = JSON.parse(localStorage.getItem('songloft-auth') || '{}');
    return auth.accessToken || '';
  }

  function apiUrl(path, params) {
    var url = BASE + path;
    var token = getToken();
    if (token) {
      url += (url.indexOf('?') === -1 ? '?' : '&') + 'access_token=' + encodeURIComponent(token);
    }
    if (params) {
      url += (url.indexOf('?') === -1 ? '?' : '&') + params;
    }
    return url;
  }

  function ajax(method, path, body, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, apiUrl(path), true);
    xhr.setRequestHeader('Accept', 'application/json');
    if (body) {
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(body));
    } else {
      xhr.send();
    }
    xhr.onload = function () {
      try {
        callback(null, JSON.parse(xhr.responseText));
      } catch (e) {
        callback(e, null);
      }
    };
    xhr.onerror = function () {
      callback(new Error('Network error'), null);
    };
  }

  function showStatus(el, msg, isError) {
    el.innerHTML = '<div class="message ' + (isError ? 'error-message' : 'success-message') + '">' + msg + '</div>';
  }

  // --- 顶部导航标签切换 ---
  var navTabs = document.querySelectorAll('.nav-tab');
  var tabPages = document.querySelectorAll('.tab-page');
  function switchTab(name) {
    navTabs.forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === name); });
    tabPages.forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-page') === name);
    });
    if (name === 'rank') loadRankLists();
    if (name === 'hotsheet') loadHotSheetLists();
    if (name === 'home') {
      hideRankDetail();
      hideHotSheetDetail();
      hotSongsEl.style.display = '';
      searchResultsWrap.style.display = 'none';
      searchState.end = true;
      loadHotSongs();
    }
  }
  navTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      switchTab(tab.getAttribute('data-tab'));
    });
  });
  // 跳转到设置页
  window.goToSettings = function () {
    switchTab('settings');
  };

  // --- Load plugin list ---
  var pluginListEl = document.getElementById('plugin-list');
  var noPluginTip = document.getElementById('no-plugin-tip');
  // 更新首页无插件提示的显示状态
  function updateNoPluginTip(plugins) {
    if (!noPluginTip) return;
    var hasEnabled = (plugins || []).some(function (p) { return p.enabled !== false; });
    noPluginTip.style.display = hasEnabled ? 'none' : '';
  }
  function loadPluginList() {
    ajax('GET', '/plugins', null, function (err, data) {
      if (err || !data) {
        pluginListEl.innerHTML = '<div class="message error-message">加载插件列表失败</div>';
        return;
      }
      var plugins = data.plugins || [];
      window._allPlugins = plugins;
      updateNoPluginTip(plugins);
      if (plugins.length === 0) {
        pluginListEl.innerHTML = '<div class="empty-state">暂无已安装的 MusicFree 插件，点击右上角「添加插件」安装。</div>';
        return;
      }
      var html = '<div class="table-wrap"><table class="data-table plugins"><thead><tr><th>平台名称</th><th>版本</th><th>功能</th><th>状态</th><th></th></tr></thead><tbody>';
      plugins.forEach(function (p) {
        var caps = p.capabilities || {};
        var features = [];
        if (caps.search) features.push('搜索');
        if (caps.getMediaSource) features.push('播放');
        if (caps.getLyric) features.push('歌词');
        if (caps.importMusicSheet) features.push('歌单导入');
        var featStr = features.join(', ') || '无';
        var enabled = p.enabled !== false;
        var safeUrl = escapeHtml(p.url);
        var toggle = '<label class="switch" title="' + (enabled ? '已启用' : '已停用') + '">' +
          '<input type="checkbox" ' + (enabled ? 'checked' : '') +
          ' onchange="togglePlugin(\'' + safeUrl + '\', this.checked)" />' +
          '<span class="switch-slider"></span></label>';
        html += '<tr class="' + (enabled ? '' : 'row-disabled') + '">' +
          '<td><div class="cell-title">' + escapeHtml(p.platform) + '</div>' +
            '<div class="cell-sub">v' + escapeHtml(p.version) + ' · ' + featStr + ' · ' + (enabled ? '已启用' : '已停用') + '</div></td>' +
          '<td>' + escapeHtml(p.version) + '</td>' +
          '<td>' + featStr + '</td>' +
          '<td>' + toggle + '</td>' +
          '<td class="col-op">' +
            (p.srcUrl ? '<button class="btn btn-small" onclick="updatePlugin(\'' + safeUrl + '\')" style="margin-right:4px">更新</button>' : '') +
            '<button class="btn btn-small btn-primary" onclick="openVarsModal(\'' + safeUrl + '\',\'' + escapeHtml(p.platform) + '\')" style="margin-right:4px">变量</button>' +
            '<button class="btn btn-small btn-danger" onclick="removePlugin(\'' + safeUrl + '\')">卸载</button>' +
          '</td></tr>';
      });
      html += '</tbody></table></div>';
      pluginListEl.innerHTML = html;
    });
  }
  loadPluginList();

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 根据歌曲 qualities 计算可用的最高音质标签
  function topQuality(qualities) {
    if (!qualities || typeof qualities !== 'object') return null;
    var order = [
      { key: 'super', label: 'Hi-Res' },
      { key: 'high', label: 'FLAC' },
      { key: 'standard', label: '320K' },
      { key: 'low', label: '128K' }
    ];
    for (var i = 0; i < order.length; i++) {
      var q = qualities[order[i].key];
      // 有效音质需存在且带有实际信息（url/hash/size 等）
      if (q && (typeof q === 'string' || Object.keys(q).length > 0)) {
        return order[i];
      }
    }
    return null;
  }

  window.removePlugin = function (url) {
    if (!confirm('确认卸载此插件？')) return;
    ajax('DELETE', '/plugins', { url: url }, function (err, data) {
      if (err || !data || !data.success) {
        showStatus(document.getElementById('plugin-list'), '卸载失败', true);
      } else {
        loadPluginList();
      }
    });
  };

  window.togglePlugin = function (url, enabled) {
    ajax('PUT', '/plugins', { url: url, enabled: enabled }, function (err, data) {
      if (err || !data || !data.success) {
        showStatus(document.getElementById('plugin-list'), '操作失败', true);
      }
      loadPluginList();
    });
  };

  window.updatePlugin = function (url) {
    ajax('PUT', '/plugins/update', { url: url }, function (err, data) {
      if (err || !data) {
        showToast('更新失败（网络错误）', true);
        return;
      }
      if (data.error) {
        showToast(data.error, true);
        return;
      }
      if (data.success) {
        showToast(data.platform + ' 已从 v' + data.oldVersion + ' 更新到 v' + data.newVersion);
        loadPluginList();
      }
    });
  };

  function showToast(msg, isError) {
    var el = document.createElement('div');
    el.className = 'toast-message' + (isError ? ' toast-error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () {
      el.classList.add('toast-fade');
      setTimeout(function () { el.remove(); }, 300);
    }, 2000);
  }


  // --- Settings: default quality ---
  var qualitySelect = document.getElementById('default-quality');
  var qualityStatus = document.getElementById('quality-status');
  var defaultQuality = 'standard';

  function loadSettings() {
    ajax('GET', '/settings', null, function (err, data) {
      if (err || !data) return;
      defaultQuality = data.defaultQuality || 'standard';
      qualitySelect.value = defaultQuality;
      gpQuality.value = defaultQuality;
    });
  }

  document.getElementById('save-quality-btn').addEventListener('click', function () {
    var q = qualitySelect.value;
    ajax('PUT', '/settings', { defaultQuality: q }, function (err, data) {
      if (err || !data || !data.success) {
        qualityStatus.innerHTML = '<div class="message error-message">保存失败</div>';
        return;
      }
      defaultQuality = q;
      gpQuality.value = q;
      qualityStatus.innerHTML = '<div class="message success-message">默认音质已保存为 ' + q + '</div>';
      setTimeout(function () { qualityStatus.innerHTML = ''; }, 3000);
    });
  });

  // 页面加载时加载设置
  loadSettings();

  // 设置 tab 显示时刷新设置
  document.querySelector('[data-tab="settings"]').addEventListener('click', function () {
    loadSettings();
    loadExternalEndpoint();
  });

  // --- 外部搜索接口地址 ---
  function loadExternalEndpoint() {
    var endpointInput = document.getElementById('external-endpoint');
    var methodEl = document.getElementById('external-method');
    var statusEl = document.getElementById('external-status');
    if (!endpointInput) return;
    ajax('GET', '/external/endpoint', null, function (err, data) {
      if (err || !data) {
        endpointInput.value = '加载失败';
        return;
      }
      endpointInput.value = data.endpoint || '';
      if (methodEl && data.method) methodEl.textContent = data.method;
    });
  }
  loadExternalEndpoint();

  window.copyExternalEndpoint = function () {
    var input = document.getElementById('external-endpoint');
    var statusEl = document.getElementById('external-status');
    if (!input || !input.value) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(function () {
        showStatus(statusEl, '已复制到剪贴板', false);
        setTimeout(function () { statusEl.innerHTML = ''; }, 2000);
      }, function () {
        input.select();
        showStatus(statusEl, '请按 Ctrl+C 复制', false);
      });
    } else {
      input.select();
      try { document.execCommand('copy'); showStatus(statusEl, '已复制到剪贴板', false); }
      catch (e) { showStatus(statusEl, '请按 Ctrl+C 复制', false); }
      setTimeout(function () { statusEl.innerHTML = ''; }, 2000);
    }
  };

  // --- Add plugin（弹窗：URL + 本地文件上传） ---
  var addPluginStatus = document.getElementById('add-plugin-status');
  var selectedFile = null;

  window.openAddPluginModal = function () {
    document.getElementById('add-plugin-modal').style.display = 'flex';
    document.getElementById('plugin-url-input').value = '';
    document.getElementById('plugin-file-name').textContent = '';
    document.getElementById('plugin-upload-btn').style.display = 'none';
    document.getElementById('plugin-file-input').value = '';
    selectedFile = null;
    if (addPluginStatus) addPluginStatus.innerHTML = '';
  };

  window.closeAddPluginModal = function () {
    document.getElementById('add-plugin-modal').style.display = 'none';
  };

  document.getElementById('add-plugin-modal').addEventListener('click', function (e) {
    if (e.target === this) closeAddPluginModal();
  });

  // URL 安装
  function installPlugin(url, force) {
    var btn = document.getElementById('plugin-url-btn');
    btn.disabled = true;
    showStatus(addPluginStatus, '正在安装...', false);
    ajax('POST', '/plugins', { url: url, force: force === true }, function (err, data) {
      btn.disabled = false;
      if (err || !data) {
        showStatus(addPluginStatus, '添加失败（网络错误）', true);
        return;
      }
      if (data.useForce) {
        if (confirm('该插件已安装，是否覆盖更新？')) {
          installPlugin(url, true);
        } else {
          showStatus(addPluginStatus, '已取消', true);
        }
        return;
      }
      if (!data.success) {
        showStatus(addPluginStatus, data.error || '添加失败', true);
        return;
      }
      showStatus(addPluginStatus, '插件 ' + data.platform + ' v' + data.version + ' 安装成功！');
      document.getElementById('plugin-url-input').value = '';
      loadPluginList();
    });
  }

  window.installFromUrl = function () {
    var input = document.getElementById('plugin-url-input');
    var url = (input.value || '').trim();
    if (!url) {
      showStatus(addPluginStatus, '请输入插件 URL', true);
      return;
    }
    installPlugin(url, false);
  };

  document.getElementById('plugin-url-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') installFromUrl();
  });

  // 文件上传：点击选择
  var dropZone = document.getElementById('plugin-drop-zone');
  var fileInput = document.getElementById('plugin-file-input');
  var fileNameEl = document.getElementById('plugin-file-name');
  var uploadBtn = document.getElementById('plugin-upload-btn');

  dropZone.addEventListener('click', function () {
    fileInput.click();
  });

  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files[0]) {
      handleFile(fileInput.files[0]);
    }
  });

  // 拖拽支持
  dropZone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', function () {
    dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  function handleFile(file) {
    // 校验文件类型
    var name = file.name || '';
    if (!/\.js$/i.test(name) && file.type !== 'text/javascript') {
      showStatus(addPluginStatus, '请选择 .js 文件', true);
      return;
    }
    selectedFile = file;
    fileNameEl.textContent = name + ' (' + formatSize(file.size) + ')';
    uploadBtn.style.display = '';
    if (addPluginStatus) addPluginStatus.innerHTML = '';
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  // 从本地文件安装
  window.installFromFile = function () {
    if (!selectedFile) {
      showStatus(addPluginStatus, '请先选择文件', true);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var code = String(reader.result || '');
      if (!code) {
        showStatus(addPluginStatus, '文件内容为空', true);
        return;
      }
      uploadBtn.disabled = true;
      showStatus(addPluginStatus, '正在安装...', false);
      ajax('POST', '/plugins', { code: code, force: false }, function (err, data) {
        uploadBtn.disabled = false;
        if (err || !data) {
          showStatus(addPluginStatus, '添加失败（网络错误）', true);
          return;
        }
        if (data.useForce) {
          if (confirm('该插件已安装，是否覆盖更新？')) {
            // 覆盖更新
            uploadBtn.disabled = true;
            showStatus(addPluginStatus, '正在安装...', false);
            ajax('POST', '/plugins', { code: code, force: true }, function (e2, d2) {
              uploadBtn.disabled = false;
              if (e2 || !d2 || !d2.success) {
                showStatus(addPluginStatus, (d2 && d2.error) || '添加失败', true);
                return;
              }
              showStatus(addPluginStatus, '插件 ' + d2.platform + ' v' + d2.version + ' 安装成功！');
              selectedFile = null;
              fileNameEl.textContent = '';
              uploadBtn.style.display = 'none';
              fileInput.value = '';
              loadPluginList();
            });
          } else {
            showStatus(addPluginStatus, '已取消', true);
          }
          return;
        }
        if (!data.success) {
          showStatus(addPluginStatus, data.error || '添加失败', true);
          return;
        }
        showStatus(addPluginStatus, '插件 ' + data.platform + ' v' + data.version + ' 安装成功！');
        selectedFile = null;
        fileNameEl.textContent = '';
        uploadBtn.style.display = 'none';
        fileInput.value = '';
        loadPluginList();
      });
    };
    reader.onerror = function () {
      showStatus(addPluginStatus, '读取文件失败', true);
    };
    reader.readAsText(selectedFile);
  };

  // --- Hot songs (cached, 5min TTL) ---
  var hotSongsEl = document.getElementById('hot-songs');
  var hotSongsGrid = document.getElementById('hot-songs-grid');
  var searchBackBtn = document.getElementById('search-back-btn');
  var searchResultsWrap = document.getElementById('search-results-wrap');
  var _hotCache = { songs: null, ts: 0 };

  function loadHotSongs(force) {
    if (!force && _hotCache.songs && Date.now() - _hotCache.ts < 300000) {
      hotSongsGrid.innerHTML = _hotCache.html;
      window._hotSongs = _hotCache.songs;
      hotSongsEl.style.display = _hotCache.songs.length ? '' : 'none';
      return;
    }
    hotSongsGrid.innerHTML = '<div class="empty-state" style="padding:12px">加载中...</div>';
    hotSongsEl.style.display = '';
    ajax('GET', '/top-lists', null, function (err, data) {
      if (err || !data) {
        if (!_hotCache.songs) hotSongsEl.style.display = 'none';
        return;
      }
      var groups = data.groups || [];
      if (groups.length === 0 || !groups[0].items || groups[0].items.length === 0) {
        if (!_hotCache.songs) hotSongsEl.style.display = 'none';
        return;
      }
      var firstGroup = groups[0];
      var firstItem = firstGroup.items[0];
      var platform = firstGroup.platform;
      var id = firstItem.id;
      ajax('GET', '/top-list-detail?platform=' + encodeURIComponent(platform) + '&id=' + encodeURIComponent(id) + '&page=1', null, function (err2, data2) {
        if (err2 || !data2) {
          if (!_hotCache.songs) hotSongsEl.style.display = 'none';
          return;
        }
        var songs = (data2.songs || []).slice(0, 20);
        if (songs.length === 0) {
          if (!_hotCache.songs) hotSongsEl.style.display = 'none';
          return;
        }
        var html = '';
        songs.forEach(function (item, i) {
          var artist = Array.isArray(item.artist) ? item.artist.join(', ') : (item.artist || '');
          var cover = item.artwork || '';
          var coverHtml = cover
            ? '<img class="hot-song-cover" src="' + escapeHtml(cover) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'inline-flex\'" /><span class="song-cover-fallback" style="display:none">♫</span>'
            : '<span class="song-cover-fallback">♫</span>';
          html += '<div class="hot-song-item" onclick="searchHotSong(' + i + ')" title="点击搜索该歌曲">' +
            coverHtml +
            '<div class="hot-song-info">' +
              '<div class="hot-song-title">' + escapeHtml(item.title) + '</div>' +
              '<div class="hot-song-artist">' + escapeHtml(artist) + '</div>' +
            '</div>' +
          '</div>';
        });
        _hotCache.songs = songs;
        _hotCache.html = html;
        _hotCache.ts = Date.now();
        hotSongsGrid.innerHTML = html;
        window._hotSongs = songs;
        hotSongsEl.style.display = '';
      });
    });
  }

  window.searchHotSong = function (idx) {
    var songs = window._hotSongs;
    if (!songs || !songs[idx]) return;
    searchKeyword.value = songs[idx].title;
    startSearch();
  };

  searchBackBtn.addEventListener('click', function () {
    hotSongsEl.style.display = '';
    searchResultsWrap.style.display = 'none';
    searchState.end = true;
  });

  // --- Search with pagination ---
  var searchBtn = document.getElementById('search-btn');
  var searchKeyword = document.getElementById('search-keyword');
  var searchResults = document.getElementById('search-results');
  var searchLoader = document.getElementById('search-loader');

  var lastResults = [];
  var searchState = { query: '', page: 1, loading: false, end: true };

  function songloftApiUrl(path) {
    var auth = JSON.parse(localStorage.getItem('songloft-auth') || '{}');
    var token = auth.accessToken || '';
    if (token) {
      path += (path.indexOf('?') === -1 ? '?' : '&') + 'access_token=' + encodeURIComponent(token);
    }
    return path;
  }

  // --- 歌单选择弹窗 ---
  var _pickerState = { idx: -1, rowId: '', playlistId: null };

  // 实际的导入逻辑（不弹窗）
  function normalizeDuration(d) {
    if (d == null) return 0;
    // 处理 "mm:ss" / "hh:mm:ss" 字符串格式
    if (typeof d === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(d.trim())) {
      var parts = d.trim().split(':').map(Number);
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    var n = parseFloat(d) || 0;
    if (n <= 0) return 0;
    if (n > 600) n = n / 1000;
    return Math.round(n);
  }

  function doImport(item, btn, playlistId, cb) {
    var duration = normalizeDuration(item.duration);
    var payload = [{
      title: item.title || '',
      artist: Array.isArray(item.artist) ? item.artist.join(', ') : (item.artist || ''),
      album: item.album || '',
      cover_url: item.artwork || '',
      url: '',
      duration: duration,
      dedup_key: item.id ? (item.platform + ':' + item.id) : '',
      plugin_entry_path: 'musicfree-adapter',
      source_data: JSON.stringify(item)
    }];
    ajax('POST', '/lyric', { musicItem: item }, function (err, data) {
      var lyricText = '';
      if (!err && data && data.rawLrc) lyricText = data.rawLrc;
      payload[0].lyric = lyricText;
      var xhr = new XMLHttpRequest();
      xhr.open('POST', songloftApiUrl('/api/v1/songs/remote'), true);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function () {
        if (btn) { btn.disabled = false; btn.textContent = '导入'; }
        try {
          var r = JSON.parse(xhr.responseText);
          if (xhr.status === 201 && r.count > 0) {
            btn.textContent = '已导入';
            btn.classList.add('btn-imported');
            // 如果选择了歌单，添加歌曲到歌单
            if (playlistId && r.songs && r.songs.length > 0) {
              addSongsToPlaylist(playlistId, r.songs.map(function(s){return s.id;}));
            }
            if (cb) cb(null, r);
          } else {
            if (cb) cb(new Error('导入失败'), null);
          }
        } catch (e) { if (cb) cb(e, null); }
      };
      xhr.onerror = function () {
        if (btn) { btn.disabled = false; btn.textContent = '导入'; }
        if (cb) cb(new Error('Network error'), null);
      };
      xhr.send(JSON.stringify(payload));
    });
  }

  function addSongsToPlaylist(playlistId, songIds) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', songloftApiUrl('/api/v1/playlists/' + playlistId + '/songs'), true);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify({ song_ids: songIds }));
  }

  window.importToSongloft = function (idx, rowId) {
    var fromRank = rowId && rowId.indexOf('rank-song-') === 0;
    var fromHs = rowId && rowId.indexOf('hs-song-') === 0;
    var item;
    if (fromRank) {
      item = window._rankSongs && window._rankSongs[idx] ? window._rankSongs[idx] : lastResults[idx];
    } else if (fromHs) {
      item = window._hsSongs && window._hsSongs[idx] ? window._hsSongs[idx] : lastResults[idx];
    } else {
      item = lastResults[idx] ? lastResults[idx] : (window._rankSongs && window._rankSongs[idx]);
    }
    if (!item) return;
    _pickerState.idx = idx;
    _pickerState.rowId = rowId;
    _pickerState.playlistId = null;

    var listEl = document.getElementById('playlist-list');
    listEl.innerHTML = '<div class="empty-state">加载中...</div>';
    document.getElementById('playlist-modal').style.display = 'flex';

    // 获取歌单列表
    var xhr = new XMLHttpRequest();
    xhr.open('GET', songloftApiUrl('/api/v1/playlists'), true);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.onload = function () {
      try {
        var data = JSON.parse(xhr.responseText);
        var playlists = data.playlists || data.data || [];
        renderPlaylistList(playlists);
      } catch (e) {
        listEl.innerHTML = '<div class="message error-message">加载歌单失败</div>';
      }
    };
    xhr.onerror = function () {
      listEl.innerHTML = '<div class="message error-message">网络错误</div>';
    };
    xhr.send();
  };

  function renderPlaylistList(playlists) {
    var listEl = document.getElementById('playlist-list');
    if (!playlists || playlists.length === 0) {
      listEl.innerHTML = '<div class="empty-state">暂无歌单</div>';
      return;
    }
    var html = '';
    html += '<label class="playlist-item selected" data-plid="">' +
      '<input type="radio" name="playlist-radio" value="" checked onchange="selectPlaylist(this.value)" />' +
      '<span class="pli-name" style="color:var(--text-sub)">不导入歌单</span></label>';
    playlists.forEach(function (pl) {
      html += '<label class="playlist-item" data-plid="' + pl.id + '">' +
        '<input type="radio" name="playlist-radio" value="' + pl.id + '" onchange="selectPlaylist(this.value)" />' +
        '<span class="pli-name">' + escapeHtml(pl.name || '未命名') + '</span>' +
        '<span class="pli-count">' + (pl.song_count || 0) + ' 首</span></label>';
    });
    html += '<label class="playlist-item" data-plid="new" style="border-top:1px solid var(--border);margin-top:4px;color:var(--primary)">' +
      '<input type="radio" name="playlist-radio" value="new" onchange="selectPlaylist(this.value)" />' +
      '<span class="pli-name">+ 创建新歌单</span></label>';
    listEl.innerHTML = html;
  }

  window.selectPlaylist = function (val) {
    _pickerState.playlistId = val || null;
    var items = document.querySelectorAll('#playlist-list .playlist-item');
    items.forEach(function (el) {
      el.classList.remove('selected');
      if (el.getAttribute('data-plid') === String(val)) {
        el.classList.add('selected');
      }
    });
    var nameArea = document.getElementById('playlist-new-name-area');
    if (val === 'new') {
      nameArea.style.display = '';
      document.getElementById('playlist-new-name').focus();
    } else {
      nameArea.style.display = 'none';
    }
  };

  window.confirmPlaylistImport = function () {
    var idx = _pickerState.idx;
    var rowId = _pickerState.rowId;
    var playlistId = _pickerState.playlistId;

    if (playlistId === 'new') {
      var name = document.getElementById('playlist-new-name').value.trim();
      if (!name) { alert('请输入歌单名称'); return; }
    }
    closePlaylistModal();

    var fromRank = rowId && rowId.indexOf('rank-song-') === 0;
    var fromHs = rowId && rowId.indexOf('hs-song-') === 0;
    var item;
    if (fromRank) {
      item = window._rankSongs && window._rankSongs[idx] ? window._rankSongs[idx] : lastResults[idx];
    } else if (fromHs) {
      item = window._hsSongs && window._hsSongs[idx] ? window._hsSongs[idx] : lastResults[idx];
    } else {
      item = lastResults[idx] ? lastResults[idx] : (window._rankSongs && window._rankSongs[idx]);
    }
    if (!item) return;
    var btn = rowId ? document.querySelector('#' + rowId + ' .btn-import') : null;

    if (playlistId === 'new') {
      btn.disabled = true;
      btn.textContent = '创建歌单...';
      var xhr = new XMLHttpRequest();
      xhr.open('POST', songloftApiUrl('/api/v1/playlists'), true);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function () {
        try {
          var pl = JSON.parse(xhr.responseText);
          if (xhr.status === 201 && pl.id) {
            btn.textContent = '导入中...';
            doImport(item, btn, pl.id);
          } else {
            if (btn) { btn.disabled = false; btn.textContent = '导入'; }
          }
        } catch (e) {
          if (btn) { btn.disabled = false; btn.textContent = '导入'; }
        }
      };
      xhr.onerror = function () {
        if (btn) { btn.disabled = false; btn.textContent = '导入'; }
      };
      xhr.send(JSON.stringify({ name: name, type: 'normal' }));
    } else {
      if (btn) { btn.disabled = true; btn.textContent = '导入中...'; }
      doImport(item, btn, playlistId);
    }
  };

  window.closePlaylistModal = function () {
    document.getElementById('playlist-modal').style.display = 'none';
  };

  // 点击遮罩层关闭弹窗
  document.getElementById('playlist-modal').addEventListener('click', function (e) {
    if (e.target === this) closePlaylistModal();
  });

  function renderSearchRows(items, startIdx) {
    var html = '';
    items.forEach(function (item, i) {
      var idx = startIdx + i;
      var artist = Array.isArray(item.artist) ? item.artist.join(', ') : item.artist;
      var q = topQuality(item.qualities);
      var qTag = q ? '<span class="quality-tag q-' + q.key + '">' + q.label + '</span>' : '';
      var cover = item.artwork || '';
      var coverHtml = cover
        ? '<img class="song-cover" src="' + escapeHtml(cover) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'inline-flex\'" /><span class="song-cover-fallback" style="display:none">♫</span>'
        : '<span class="song-cover-fallback">♫</span>';
      html += '<tr id="song-row-' + idx + '">' +
        '<td class="col-cover">' + coverHtml + '</td>' +
        '<td><div class="cell-title">' + escapeHtml(item.title) + qTag + '</div>' +
          '<div class="cell-sub">' + escapeHtml(artist) + ' · ' + escapeHtml(item.platform) + '</div></td>' +
        '<td>' + escapeHtml(artist) + '</td>' +
        '<td class="col-platform">' + escapeHtml(item.platform) + '</td>' +
        '<td class="col-op">' +
          '<button class="btn btn-small btn-primary btn-play" onclick="playSong(' + idx + ')" style="margin-right:4px">播放</button>' +
          '<button class="btn btn-small btn-import" onclick="importToSongloft(' + idx + ',\'song-row-' + idx + '\')">导入</button>' +
        '</td></tr>';
    });
    return html;
  }

  function loadSearchPage() {
    if (searchState.loading || searchState.end) return;
    searchState.loading = true;
    searchLoader.style.display = '';

    ajax('GET', '/search?q=' + encodeURIComponent(searchState.query) + '&page=' + searchState.page, null, function (err, data) {
      searchState.loading = false;
      searchLoader.style.display = 'none';
      if (err || !data) {
        if (searchState.page === 1) { searchResults.innerHTML = '<div class="message error-message">搜索失败</div>'; searchBtn.disabled = false; }
        return;
      }
      var items = data.data || [];
      if (items.length === 0) {
        searchState.end = true;
        if (searchState.page === 1) { searchResults.innerHTML = '<div class="empty-state">未找到相关结果</div>'; searchBtn.disabled = false; }
        return;
      }
      if (searchState.page === 1) searchBtn.disabled = false;
      if (searchState.page === 1) {
        searchResults.innerHTML = '<div class="table-wrap"><table class="data-table songs"><thead><tr><th class="col-cover"></th><th>歌曲名</th><th>艺术家</th><th class="col-platform">来源平台</th><th></th></tr></thead><tbody>';
      }
      var tbody = searchResults.querySelector('tbody');
      if (tbody) {
        tbody.insertAdjacentHTML('beforeend', renderSearchRows(items, lastResults.length));
      }
      Array.prototype.push.apply(lastResults, items);
      searchState.page++;
      if (data.isEnd) searchState.end = true;
    });
  }

  function startSearch() {
    var q = searchKeyword.value.trim();
    if (!q) {
      searchResults.innerHTML = '<div class="empty-state">请输入搜索关键词</div>';
      return;
    }
    // 无可用插件时直接提示
    if (noPluginTip && noPluginTip.style.display !== 'none') {
      searchResults.innerHTML = '<div class="empty-state">请先到「设置」页面安装并启用插件，<a href="javascript:goToSettings()" style="color:var(--primary)">前往设置</a></div>';
      return;
    }
    hotSongsEl.style.display = 'none';
    searchResultsWrap.style.display = '';
    searchState.query = q;
    searchState.page = 1;
    searchState.loading = false;
    searchState.end = false;
    lastResults = [];
    searchBtn.disabled = true;
    searchResults.innerHTML = '<div class="empty-state">搜索中...</div>';
    loadSearchPage();
  }

  searchBtn.addEventListener('click', startSearch);

  searchKeyword.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') startSearch();
  });

  // 无限滚动：滚动到底部自动加载
  window.addEventListener('scroll', function () {
    if (searchState.end || searchState.loading) return;
    if (searchResultsWrap.style.display === 'none') return;
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 100) {
      loadSearchPage();
    }
  });

  // --- 全局播放器 ---
  var player = document.getElementById('global-player');
  var gpCover = document.getElementById('gp-cover');
  var gpTitle = document.getElementById('gp-title');
  var gpArtist = document.getElementById('gp-artist');
  var gpAudio = document.getElementById('gp-audio');
  var gpQuality = document.getElementById('gp-quality');
  var gpStatus = document.getElementById('gp-status');
  var gpLyric = document.getElementById('gp-lyric');

  var currentIdx = -1;
  var lrcLines = [];

  function setStatus(msg) {
    gpStatus.textContent = msg || '';
  }

  function highlightRow(idx) {
    var prev = document.querySelector('.row-playing');
    if (prev) prev.classList.remove('row-playing');
    var row = document.getElementById('song-row-' + idx);
    if (row) row.classList.add('row-playing');
  }

  function parseLrc(text) {
    if (!text) return [];
    var lines = [];
    var lineRe = /\[(\d{1,3}):(\d{2})(?:\.(\d{2,3}))?\](.*)/g;
    var m;
    while ((m = lineRe.exec(text)) !== null) {
      var sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (parseInt(m[3] || '0', 10) / 1000);
      lines.push({ time: sec, text: m[4].trim() });
    }
    lines.sort(function (a, b) { return a.time - b.time; });
    return lines;
  }

  function fetchLyric(item) {
    gpLyric.textContent = '';
    lrcLines = [];
    if (!item.platform || !item.id) return;
    ajax('POST', '/lyric', { musicItem: item }, function (err, data) {
      if (err || !data || (!data.rawLrc && !data.translation)) return;
      lrcLines = parseLrc(data.rawLrc || '');
    });
  }

  function updateLyric() {
    if (lrcLines.length === 0) return;
    var t = gpAudio.currentTime;
    var text = '';
    for (var i = lrcLines.length - 1; i >= 0; i--) {
      if (t >= lrcLines[i].time) {
        text = lrcLines[i].text;
        break;
      }
    }
    gpLyric.textContent = text || '';
  }

  function resolveAndPlay(item, quality) {
    setStatus('解析中...');
    player.classList.add('active');
    gpTitle.textContent = item.title || '未知';
    gpArtist.textContent = Array.isArray(item.artist) ? item.artist.join(', ') : (item.artist || '');
    gpCover.src = item.artwork || '';
    gpQuality.value = quality;
    lrcLines = [];
    gpLyric.textContent = '';
    fetchLyric(item);

    ajax('POST', '/source', { musicItem: item, quality: quality }, function (err, data) {
      if (err || !data || !data.url) {
        setStatus((data && data.error) || '无法获取播放地址');
        return;
      }
      setStatus('播放中');
      gpAudio.src = data.url;
      gpQuality.value = data.quality || quality;
      var p = gpAudio.play();
      if (p && p.catch) {
        p.catch(function () { setStatus('点击播放按钮开始'); });
      }
    });
  }

  gpAudio.addEventListener('timeupdate', updateLyric);

  window.playSong = function (idx) {
    var item = lastResults[idx];
    if (!item) return;
    currentIdx = idx;
    highlightRow(idx);
    resolveAndPlay(item, defaultQuality);
  };

  // 切换音质时，若正在播放则重新解析当前歌曲
  gpQuality.addEventListener('change', function () {
    if (currentIdx >= 0 && lastResults[currentIdx]) {
      resolveAndPlay(lastResults[currentIdx], gpQuality.value);
    }
  });

  gpAudio.addEventListener('error', function () {
    if (gpAudio.src) setStatus('播放失败');
  });

  // --- 排行榜 ---
  var rankListEl = document.getElementById('rank-list');
  var rankTabsEl = document.getElementById('rank-tabs');
  var rankDetailEl = document.getElementById('rank-detail');
  var rankDetailTitle = document.getElementById('rank-detail-title');
  var rankDetailSongs = document.getElementById('rank-detail-songs');
  var allRankGroups = [];
  var currentRankPlatform = '';

  function renderRankGroups(platform) {
    var filtered = platform ? allRankGroups.filter(function (g) { return g.platform === platform; }) : allRankGroups;
    if (filtered.length === 0) {
      rankListEl.innerHTML = '<div class="empty-state">该平台暂无榜单</div>';
      return;
    }
    var html = '';
    filtered.forEach(function (group) {
      if (group.title) {
        html += '<div class="rank-group-title">' + escapeHtml(group.title) + '</div>';
      }
      html += '<div class="rank-grid">';
      (group.items || []).forEach(function (item) {
        var safeName = escapeHtml(item.title || '未知');
        var safeDesc = escapeHtml(item.description || '');
        var cover = item.coverImg || '';
        var dataAttrs = 'data-platform="' + escapeHtml(item.platform || '') + '"' +
          ' data-id="' + escapeHtml(item.id || '') + '"' +
          ' data-title="' + safeName + '"';
        var extraKeys = [];
        for (var k in item) {
          if (['id', 'title', 'description', 'coverImg', 'platform'].indexOf(k) === -1) {
            extraKeys.push(k + '=' + encodeURIComponent(String(item[k])));
          }
        }
        dataAttrs += ' data-extra="' + escapeHtml(extraKeys.join('&')) + '"';
        html += '<div class="rank-card" onclick="openTopList(this)" ' + dataAttrs + '>' +
          '<img class="rank-card-cover" src="' + (cover || '') + '" alt="' + safeName + '" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'flex\'" />' +
          '<div class="rank-card-cover rank-card-cover-fallback" style="display:' + (cover ? 'none' : 'flex') + ';background:linear-gradient(135deg,#667eea,#764ba2);font-size:40px;color:rgba(255,255,255,.9)">♫</div>' +
          '<div class="rank-card-body"><h3>' + safeName + '</h3><p>' + safeDesc + '</p></div></div>';
      });
      html += '</div>';
    });
    rankListEl.innerHTML = html;
  }

  function loadRankLists() {
    rankDetailEl.style.display = 'none';
    rankListEl.style.display = '';
    rankListEl.innerHTML = '<div class="empty-state">加载中...</div>';
    rankTabsEl.innerHTML = '';
    ajax('GET', '/top-lists', null, function (err, data) {
      if (err || !data) {
        rankListEl.innerHTML = '<div class="message error-message">加载失败</div>';
        return;
      }
      allRankGroups = data.groups || [];
      if (allRankGroups.length === 0) {
        rankListEl.innerHTML = '<div class="empty-state">暂无榜单，请确认已安装支持榜单的插件</div>';
        return;
      }
      var platforms = [];
      var seen = {};
      allRankGroups.forEach(function (g) {
        if (!seen[g.platform]) {
          seen[g.platform] = true;
          platforms.push(g.platform);
        }
      });
      var tabsHtml = '';
      platforms.forEach(function (p) {
        tabsHtml += '<span class="rank-tab' + (p === platforms[0] ? ' active' : '') + '" data-rank-platform="' + escapeHtml(p) + '">' + escapeHtml(p) + '</span>';
      });
      rankTabsEl.innerHTML = tabsHtml;
      Array.from(rankTabsEl.children).forEach(function (tab) {
        tab.addEventListener('click', function () {
          var prev = rankTabsEl.querySelector('.active');
          if (prev) prev.classList.remove('active');
          tab.classList.add('active');
          currentRankPlatform = tab.getAttribute('data-rank-platform');
          renderRankGroups(currentRankPlatform);
        });
      });
      currentRankPlatform = platforms[0];
      renderRankGroups(currentRankPlatform);
    });
  }

  var _rankCtx = { platform: '', id: '', extraStr: '', page: 1, isEnd: false, loading: false };

  window.openTopList = function (el) {
    _rankCtx.platform = el.getAttribute('data-platform');
    _rankCtx.id = el.getAttribute('data-id');
    _rankCtx.extraStr = el.getAttribute('data-extra') || '';
    _rankCtx.page = 1;
    _rankCtx.isEnd = false;
    _rankCtx.loading = false;

    var title = el.getAttribute('data-title');

    rankListEl.style.display = 'none';
    rankDetailEl.style.display = '';
    rankDetailTitle.textContent = title || '榜单详情';
    var oldBatchBtn = document.getElementById('rank-batch-import-btn');
    if (!oldBatchBtn) {
      var hdr = document.querySelector('.rank-detail-header');
      if (hdr) {
        var bBtn = document.createElement('button');
        bBtn.className = 'btn btn-small btn-import';
        bBtn.id = 'rank-batch-import-btn';
        bBtn.textContent = '批量导入';
        bBtn.onclick = batchImportRankSongs;
        bBtn.style.cssText = 'display:none;margin-left:auto';
        hdr.appendChild(bBtn);
      }
    } else {
      oldBatchBtn.style.display = 'none';
    }

    rankDetailSongs.innerHTML = '<div class="empty-state">加载中...</div>';
    window._rankSongs = [];
    _loadRankPage(true);
  };

  function _loadRankPage(reset) {
    if (_rankCtx.loading) return;
    if (!reset && _rankCtx.isEnd) return;
    _rankCtx.loading = true;

    if (reset) {
      rankDetailSongs.innerHTML = '<div class="empty-state">加载中...</div>';
      window._rankSongs = [];
      _rankCtx.page = 1;
    } else {
      var loader = document.getElementById('rank-load-more');
      if (loader) loader.textContent = '加载中...';
    }

    var params = 'platform=' + encodeURIComponent(_rankCtx.platform) + '&id=' + encodeURIComponent(_rankCtx.id) + '&page=' + _rankCtx.page;
    if (_rankCtx.extraStr) params += '&' + _rankCtx.extraStr;

    ajax('GET', '/top-list-detail?' + params, null, function (err, data) {
      _rankCtx.loading = false;
      if (err || !data) {
        if (reset) rankDetailSongs.innerHTML = '<div class="message error-message">加载失败</div>';
        return;
      }
      var songs = data.songs || [];
      var isEnd = data.isEnd !== false;
      if (songs.length === 0 && reset) {
        rankDetailSongs.innerHTML = '<div class="empty-state">该榜单暂无歌曲</div>';
        return;
      }
      if (songs.length === 0) { _rankCtx.isEnd = true; return; }
      _rankCtx.isEnd = isEnd;
      _rankCtx.page++;

      var allSongs = reset ? [] : window._rankSongs;
      var startIdx = allSongs.length;
      var html = '';
      if (reset) {
        html = '<div class="table-wrap"><table class="data-table songs rank-song-table"><thead><tr>' +
          '<th style="width:36px"><input type="checkbox" id="rank-select-all" onchange="toggleAllRankSongs(this.checked)" /></th>' +
          '<th class="col-cover"></th><th>歌曲名</th><th>艺术家</th><th class="col-platform">来源</th><th></th></tr></thead><tbody>';
      }
      songs.forEach(function (item, i) {
        var idx = startIdx + i;
        var artist = Array.isArray(item.artist) ? item.artist.join(', ') : item.artist;
        var q = topQuality(item.qualities);
        var qTag = q ? '<span class="quality-tag q-' + q.key + '">' + q.label + '</span>' : '';
        var cover = item.artwork || '';
        var coverHtml = cover
          ? '<img class="song-cover" src="' + escapeHtml(cover) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'inline-flex\'" /><span class="song-cover-fallback" style="display:none">♫</span>'
          : '<span class="song-cover-fallback">♫</span>';
        html += '<tr id="rank-song-' + idx + '">' +
          '<td style="width:36px"><input type="checkbox" class="rank-song-cb" data-idx="' + idx + '" onchange="updateRankBatchBtn()" /></td>' +
          '<td class="col-cover">' + coverHtml + '</td>' +
          '<td><div class="cell-title">' + escapeHtml(item.title) + qTag + '</div>' +
            '<div class="cell-sub">' + escapeHtml(artist) + ' · ' + escapeHtml(item.platform) + '</div></td>' +
          '<td>' + escapeHtml(artist) + '</td>' +
          '<td class="col-platform">' + escapeHtml(item.platform) + '</td>' +
          '<td class="col-op"><button class="btn btn-small btn-primary btn-play" onclick="playRankSong(' + idx + ')" style="margin-right:4px">播放</button>' +
            '<button class="btn btn-small btn-import" onclick="importToSongloft(' + idx + ',\'rank-song-' + idx + '\')">导入</button></td></tr>';
      });
      Array.prototype.push.apply(allSongs, songs);
      window._rankSongs = allSongs;

      if (reset) {
        html += '</tbody></table></div>';
        rankDetailSongs.innerHTML = html;
      } else {
        var tbody = document.querySelector('.rank-song-table tbody');
        if (tbody) tbody.insertAdjacentHTML('beforeend', html);
      }
      updateRankBatchBtn();
      // 加载更多按钮
      var moreEl = document.getElementById('rank-load-more');
      if (!isEnd) {
        var moreHtml = '<div id="rank-load-more" class="empty-state" style="cursor:pointer;color:var(--primary)" onclick="window.loadMoreRankSongs()">点击加载更多</div>';
        if (reset) {
          rankDetailSongs.insertAdjacentHTML('beforeend', moreHtml);
        } else {
          if (moreEl) moreEl.textContent = '点击加载更多';
          else rankDetailSongs.insertAdjacentHTML('beforeend', moreHtml);
        }
      } else {
        if (moreEl) moreEl.remove();
      }
    });
  }

  window.loadMoreRankSongs = function () {
    _loadRankPage(false);
  };

  window.toggleAllRankSongs = function (checked) {
    var cbs = document.querySelectorAll('.rank-song-cb');
    cbs.forEach(function (cb) { cb.checked = checked; });
    updateRankBatchBtn();
  };

  window.updateRankBatchBtn = function () {
    var checked = document.querySelectorAll('.rank-song-cb:checked');
    var btn = document.getElementById('rank-batch-import-btn');
    if (btn) {
      btn.style.display = '';
      btn.textContent = checked.length > 0 ? ('批量导入 (' + checked.length + ')') : '批量导入 (全部)';
    }
  };

  window.batchImportRankSongs = function () {
    var btn = document.getElementById('rank-batch-import-btn');
    // 检查是否有已勾选的歌曲
    var checked = document.querySelectorAll('.rank-song-cb:checked');
    if (checked.length > 0) {
      // 有勾选：只导入勾选的歌曲
      var indices = [];
      checked.forEach(function (cb) { indices.push(parseInt(cb.getAttribute('data-idx'), 10)); });
      _showBatchPickerWithIndices(indices);
    } else {
      // 没勾选：加载全部歌曲后全部导入
      if (!_rankCtx.isEnd) {
        if (btn) btn.textContent = '加载全部歌曲...';
        _loadAllRankPages(function () {
          if (btn) btn.textContent = '批量导入';
          var allIndices = [];
          for (var i = 0; i < (window._rankSongs || []).length; i++) allIndices.push(i);
          document.querySelectorAll('.rank-song-cb').forEach(function (cb) { cb.checked = true; });
          updateRankBatchBtn();
          _showBatchPickerWithIndices(allIndices);
        });
      } else {
        var allIndices = [];
        for (var i = 0; i < (window._rankSongs || []).length; i++) allIndices.push(i);
        _showBatchPickerWithIndices(allIndices);
      }
    }
  };

  function _showBatchPickerWithIndices(indices) {
    if (!indices || indices.length === 0) return;
    var listEl = document.getElementById('playlist-list');
    listEl.innerHTML = '<div class="empty-state">加载中...</div>';
    document.getElementById('playlist-modal').style.display = 'flex';

    var xhr = new XMLHttpRequest();
    xhr.open('GET', songloftApiUrl('/api/v1/playlists'), true);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.onload = function () {
      try {
        var data = JSON.parse(xhr.responseText);
        var playlists = data.playlists || data.data || [];
        renderPlaylistList(playlists);
        var origConfirm = window.confirmPlaylistImport;
        window.confirmPlaylistImport = function () {
          var playlistId = _pickerState.playlistId;
          if (playlistId === 'new') {
            var name = document.getElementById('playlist-new-name').value.trim();
            if (!name) { alert('请输入歌单名称'); return; }
          }
          closePlaylistModal();
          _runBatchImport(indices, playlistId);
          window.confirmPlaylistImport = origConfirm;
        };
      } catch (e) {
        listEl.innerHTML = '<div class="message error-message">加载歌单失败</div>';
      }
    };
    xhr.onerror = function () {
      listEl.innerHTML = '<div class="message error-message">网络错误</div>';
    };
    xhr.send();
  }

  function _loadAllRankPages(cb) {
    if (_rankCtx.isEnd || _rankCtx.loading) { if (cb) cb(); return; }
    _rankCtx.loading = true;
    var params = 'platform=' + encodeURIComponent(_rankCtx.platform) + '&id=' + encodeURIComponent(_rankCtx.id) + '&page=' + _rankCtx.page;
    if (_rankCtx.extraStr) params += '&' + _rankCtx.extraStr;
    ajax('GET', '/top-list-detail?' + params, null, function (err, data) {
      _rankCtx.loading = false;
      if (err || !data) { if (cb) cb(); return; }
      var songs = data.songs || [];
      var isEnd = data.isEnd !== false;
      if (songs.length === 0) { _rankCtx.isEnd = true; if (cb) cb(); return; }
      _rankCtx.isEnd = isEnd;
      _rankCtx.page++;
      var allSongs = window._rankSongs;
      var startIdx = allSongs.length;
      Array.prototype.push.apply(allSongs, songs);
      window._rankSongs = allSongs;
      // 追加到DOM
      var tbody = document.querySelector('.rank-song-table tbody');
      if (tbody) {
        var html = '';
        songs.forEach(function (item, i) {
          var idx = startIdx + i;
          var artist = Array.isArray(item.artist) ? item.artist.join(', ') : item.artist;
          var q = topQuality(item.qualities);
          var qTag = q ? '<span class="quality-tag q-' + q.key + '">' + q.label + '</span>' : '';
          var cover = item.artwork || '';
          var coverHtml = cover
            ? '<img class="song-cover" src="' + escapeHtml(cover) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'inline-flex\'" /><span class="song-cover-fallback" style="display:none">♫</span>'
            : '<span class="song-cover-fallback">♫</span>';
          html += '<tr id="rank-song-' + idx + '">' +
            '<td style="width:36px"><input type="checkbox" class="rank-song-cb" data-idx="' + idx + '" onchange="updateRankBatchBtn()" checked /></td>' +
            '<td class="col-cover">' + coverHtml + '</td>' +
            '<td><div class="cell-title">' + escapeHtml(item.title) + qTag + '</div>' +
              '<div class="cell-sub">' + escapeHtml(artist) + ' · ' + escapeHtml(item.platform) + '</div></td>' +
            '<td>' + escapeHtml(artist) + '</td>' +
            '<td class="col-platform">' + escapeHtml(item.platform) + '</td>' +
            '<td class="col-op"><button class="btn btn-small btn-primary btn-play" onclick="playRankSong(' + idx + ')" style="margin-right:4px">播放</button>' +
              '<button class="btn btn-small btn-import" onclick="importToSongloft(' + idx + ',\'rank-song-' + idx + '\')">导入</button></td></tr>';
        });
        tbody.insertAdjacentHTML('beforeend', html);
      }
      // 递归加载更多
      _loadAllRankPages(cb);
    });
  }

  function _showBatchPicker() {
    // 收集所有已加载的歌曲
    var totalSongs = window._rankSongs || [];
    if (totalSongs.length === 0) return;
    var indices = [];
    for (var i = 0; i < totalSongs.length; i++) indices.push(i);
    // 全选所有复选框
    document.querySelectorAll('.rank-song-cb').forEach(function (cb) { cb.checked = true; });
    updateRankBatchBtn();

    var listEl = document.getElementById('playlist-list');
    listEl.innerHTML = '<div class="empty-state">加载中...</div>';
    document.getElementById('playlist-modal').style.display = 'flex';

    var xhr = new XMLHttpRequest();
    xhr.open('GET', songloftApiUrl('/api/v1/playlists'), true);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.onload = function () {
      try {
        var data = JSON.parse(xhr.responseText);
        var playlists = data.playlists || data.data || [];
        renderPlaylistList(playlists);
        var origConfirm = window.confirmPlaylistImport;
        window.confirmPlaylistImport = function () {
          var playlistId = _pickerState.playlistId;
          if (playlistId === 'new') {
            var name = document.getElementById('playlist-new-name').value.trim();
            if (!name) { alert('请输入歌单名称'); return; }
          }
          closePlaylistModal();
          _runBatchImport(indices, playlistId);
          window.confirmPlaylistImport = origConfirm;
        };
      } catch (e) {
        listEl.innerHTML = '<div class="message error-message">加载歌单失败</div>';
      }
    };
    xhr.onerror = function () {
      listEl.innerHTML = '<div class="message error-message">网络错误</div>';
    };
    xhr.send();
  }

  function _runBatchImport(indices, playlistId) {
    var songs = window._rankSongs;
    if (!songs || indices.length === 0) return;
    var total = indices.length;
    var done = 0;
    var allSongIds = [];
    var importBtn = document.getElementById('rank-batch-import-btn');

    function onComplete() {
      if (importBtn) { importBtn.textContent = '已导入'; importBtn.classList.add('btn-imported'); }
      indices.forEach(function (idx) {
        var btn = document.querySelector('#rank-song-' + idx + ' .btn-import');
        if (btn) { btn.textContent = '已导入'; btn.classList.add('btn-imported'); }
      });
      if (playlistId && allSongIds.length > 0) {
        addSongsToPlaylist(playlistId, allSongIds);
      }
    }

    function importOne(i) {
      if (i >= indices.length) { onComplete(); return; }
      var item = songs[indices[i]];
      if (!item) { importOne(i + 1); return; }
      if (importBtn) importBtn.textContent = '导入中 ' + (done + 1) + '/' + total;
      var duration = normalizeDuration(item.duration);
      var payload = [{
        title: item.title || '',
        artist: Array.isArray(item.artist) ? item.artist.join(', ') : (item.artist || ''),
        album: item.album || '',
        cover_url: item.artwork || '',
        url: '',
        duration: duration,
        dedup_key: item.id ? (item.platform + ':' + item.id) : '',
        plugin_entry_path: 'musicfree-adapter',
        source_data: JSON.stringify(item)
      }];
      ajax('POST', '/lyric', { musicItem: item }, function (err, data) {
        var lyricText = '';
        if (!err && data && data.rawLrc) lyricText = data.rawLrc;
        payload[0].lyric = lyricText;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', songloftApiUrl('/api/v1/songs/remote'), true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
          done++;
          try {
            var r = JSON.parse(xhr.responseText);
            if (xhr.status === 201 && r.count > 0 && r.songs) {
              r.songs.forEach(function (s) { allSongIds.push(s.id); });
            }
          } catch (e) {}
          importOne(i + 1);
        };
        xhr.onerror = function () { done++; importOne(i + 1); };
        xhr.send(JSON.stringify(payload));
      });
    }

    function startImport() {
      importOne(0);
    }

    if (playlistId === 'new') {
      if (importBtn) importBtn.textContent = '创建歌单...';
      var name = document.getElementById('playlist-new-name').value.trim() || (songs[indices[0]] ? songs[indices[0]].title : '新歌单');
      var createXhr = new XMLHttpRequest();
      createXhr.open('POST', songloftApiUrl('/api/v1/playlists'), true);
      createXhr.setRequestHeader('Accept', 'application/json');
      createXhr.setRequestHeader('Content-Type', 'application/json');
      createXhr.onload = function () {
        try {
          var pl = JSON.parse(createXhr.responseText);
          if (createXhr.status === 201 && pl.id) {
            playlistId = pl.id;
            startImport();
          } else {
            if (importBtn) importBtn.textContent = '创建失败';
          }
        } catch (e) {
          if (importBtn) importBtn.textContent = '创建失败';
        }
      };
      createXhr.onerror = function () {
        if (importBtn) importBtn.textContent = '创建失败';
      };
      createXhr.send(JSON.stringify({ name: name, type: 'normal' }));
    } else {
      startImport();
    }
  };

  window.playRankSong = function (idx) {
    var songs = window._rankSongs;
    if (!songs || !songs[idx]) return;
    var item = songs[idx];
    lastResults = songs;
    currentIdx = idx;
    highlightRow(idx);
    resolveAndPlay(item, defaultQuality);
  };

  function hideRankDetail() {
    rankDetailEl.style.display = 'none';
    rankListEl.style.display = '';
  }

  document.getElementById('rank-back-btn').addEventListener('click', function () {
    rankDetailEl.style.display = 'none';
    rankListEl.style.display = '';
  });

  // --- 热门歌单（与排行榜逻辑一致：一次性获取所有启用插件的歌单，按平台tab切换） ---
  var hsListEl = document.getElementById('hs-list');
  var hsTagsEl = document.getElementById('hs-tags');
  var hsDetailEl = document.getElementById('hs-detail');
  var hsDetailTitle = document.getElementById('hs-detail-title');
  var hsDetailSongs = document.getElementById('hs-detail-songs');
  var allHsGroups = [];
  var currentHsPlatform = '';
  var hsCtx = { platform: '', id: '', page: 1, isEnd: false, loading: false };

  function renderHsGroups(platform) {
    var filtered = platform ? allHsGroups.filter(function (g) { return g.platform === platform; }) : allHsGroups;
    if (filtered.length === 0) {
      hsListEl.innerHTML = '<div class="empty-state">该平台暂无热门歌单</div>';
      return;
    }
    var html = '';
    filtered.forEach(function (group) {
      if (group.title) {
        html += '<div class="rank-group-title">' + escapeHtml(group.title) + '</div>';
      }
      html += '<div class="rank-grid">';
      (group.items || []).forEach(function (item) {
        var safeName = escapeHtml(item.title || '未知');
        var safeDesc = escapeHtml(item.description || '');
        var cover = item.coverImg || item.artwork || '';
        var dataAttrs = 'data-platform="' + escapeHtml(item.platform || '') + '"' +
          ' data-id="' + escapeHtml(item.id || '') + '"' +
          ' data-title="' + safeName + '"';
        var extraKeys = [];
        for (var k in item) {
          if (['id', 'title', 'description', 'coverImg', 'artwork', 'platform'].indexOf(k) === -1) {
            extraKeys.push(k + '=' + encodeURIComponent(String(item[k])));
          }
        }
        dataAttrs += ' data-extra="' + escapeHtml(extraKeys.join('&')) + '"';
        html += '<div class="rank-card" onclick="openHotSheet(this)" ' + dataAttrs + '>' +
          '<img class="rank-card-cover" src="' + (cover || '') + '" alt="' + safeName + '" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'flex\'" />' +
          '<div class="rank-card-cover rank-card-cover-fallback" style="display:' + (cover ? 'none' : 'flex') + ';background:linear-gradient(135deg,#e74c3c,#f39c12);font-size:40px;color:rgba(255,255,255,.9)">📋</div>' +
          '<div class="rank-card-body"><h3>' + safeName + '</h3><p>' + safeDesc + '</p></div></div>';
      });
      html += '</div>';
    });
    hsListEl.innerHTML = html;
  }

  function loadHotSheetLists() {
    hsDetailEl.style.display = 'none';
    hsListEl.style.display = '';
    hsListEl.innerHTML = '<div class="empty-state">加载中...</div>';
    hsTagsEl.innerHTML = '';
    ajax('GET', '/recommend-sheets', null, function (err, data) {
      if (err || !data) {
        hsListEl.innerHTML = '<div class="message error-message">加载失败</div>';
        return;
      }
      allHsGroups = data.groups || [];
      if (allHsGroups.length === 0) {
        hsListEl.innerHTML = '<div class="empty-state">暂无热门歌单，请确认已安装支持热门歌单的插件</div>';
        return;
      }
      var platforms = [];
      var seen = {};
      allHsGroups.forEach(function (g) {
        if (!seen[g.platform]) {
          seen[g.platform] = true;
          platforms.push(g.platform);
        }
      });
      var tabsHtml = '';
      platforms.forEach(function (p) {
        tabsHtml += '<span class="rank-tab' + (p === platforms[0] ? ' active' : '') + '" data-hs-platform="' + escapeHtml(p) + '">' + escapeHtml(p) + '</span>';
      });
      hsTagsEl.innerHTML = tabsHtml;
      Array.from(hsTagsEl.children).forEach(function (tab) {
        tab.addEventListener('click', function () {
          var prev = hsTagsEl.querySelector('.active');
          if (prev) prev.classList.remove('active');
          tab.classList.add('active');
          currentHsPlatform = tab.getAttribute('data-hs-platform');
          renderHsGroups(currentHsPlatform);
        });
      });
      currentHsPlatform = platforms[0];
      renderHsGroups(currentHsPlatform);
    });
  }

  window.openHotSheet = function (el) {
    hsCtx.platform = el.getAttribute('data-platform');
    hsCtx.id = el.getAttribute('data-id');
    hsCtx.extraStr = el.getAttribute('data-extra') || '';
    hsCtx.page = 1;
    hsCtx.isEnd = false;
    hsCtx.loading = false;
    var title = el.getAttribute('data-title');
    hsListEl.style.display = 'none';
    hsDetailEl.style.display = '';
    hsDetailTitle.textContent = title || '歌单详情';

    var oldBatchBtn = document.getElementById('hs-batch-import-btn');
    if (!oldBatchBtn) {
      var hdr = document.querySelector('#hs-detail .rank-detail-header');
      if (hdr) {
        var bBtn = document.createElement('button');
        bBtn.className = 'btn btn-small btn-import';
        bBtn.id = 'hs-batch-import-btn';
        bBtn.textContent = '批量导入';
        bBtn.onclick = batchImportHsSongs;
        bBtn.style.cssText = 'display:none;margin-left:auto';
        hdr.appendChild(bBtn);
      }
    } else {
      oldBatchBtn.style.display = 'none';
    }

    hsDetailSongs.innerHTML = '<div class="empty-state">加载中...</div>';
    window._hsSongs = [];
    _loadHsPage(true);
  };

  function _loadHsPage(reset) {
    if (hsCtx.loading) return;
    if (!reset && hsCtx.isEnd) return;
    hsCtx.loading = true;
    if (reset) {
      hsDetailSongs.innerHTML = '<div class="empty-state">加载中...</div>';
      window._hsSongs = [];
      hsCtx.page = 1;
    } else {
      var loader = document.getElementById('hs-load-more');
      if (loader) loader.textContent = '加载中...';
    }
    var params = 'platform=' + encodeURIComponent(hsCtx.platform) + '&id=' + encodeURIComponent(hsCtx.id) + '&page=' + hsCtx.page + '&pageSize=20';
    if (hsCtx.extraStr) params += '&' + hsCtx.extraStr;
    ajax('GET', '/recommend-sheets/detail?' + params, null, function (err, data) {
      hsCtx.loading = false;
      if (err || !data) {
        if (reset) hsDetailSongs.innerHTML = '<div class="message error-message">加载失败</div>';
        return;
      }
      var songs = data.songs || [];
      var isEnd = data.isEnd !== false;
      if (songs.length === 0 && reset) {
        hsDetailSongs.innerHTML = '<div class="empty-state">该歌单暂无内容</div>';
        return;
      }
      if (songs.length === 0) { hsCtx.isEnd = true; return; }
      hsCtx.isEnd = isEnd;
      hsCtx.page++;
      var allSongs = reset ? [] : window._hsSongs;
      var startIdx = allSongs.length;
      var html = '';
      if (reset) {
        html = '<div class="table-wrap"><table class="data-table songs hs-song-table"><thead><tr>' +
          '<th style="width:36px"><input type="checkbox" id="hs-select-all" onchange="toggleAllHsSongs(this.checked)" /></th>' +
          '<th class="col-cover"></th><th>歌曲名</th><th>艺术家</th><th class="col-platform">来源</th><th></th></tr></thead><tbody>';
      }
      songs.forEach(function (item, i) {
        var idx = startIdx + i;
        var artist = Array.isArray(item.artist) ? item.artist.join(', ') : (item.artist || '');
        var cover = item.artwork || '';
        var coverHtml = cover
          ? '<img class="song-cover" src="' + escapeHtml(cover) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'inline-flex\'" /><span class="song-cover-fallback" style="display:none">♫</span>'
          : '<span class="song-cover-fallback">♫</span>';
        html += '<tr id="hs-song-' + idx + '">' +
          '<td style="width:36px"><input type="checkbox" class="hs-song-cb" data-idx="' + idx + '" onchange="updateHsBatchBtn()" /></td>' +
          '<td class="col-cover">' + coverHtml + '</td>' +
          '<td><div class="cell-title">' + escapeHtml(item.title) + '</div>' +
            '<div class="cell-sub">' + escapeHtml(artist) + ' · ' + escapeHtml(item.platform) + '</div></td>' +
          '<td>' + escapeHtml(artist) + '</td>' +
          '<td class="col-platform">' + escapeHtml(item.platform) + '</td>' +
          '<td class="col-op">' +
            '<button class="btn btn-small btn-primary btn-play" onclick="playHsSong(' + idx + ')" style="margin-right:4px">播放</button>' +
            '<button class="btn btn-small btn-import" onclick="importToSongloft(' + idx + ',\'hs-song-' + idx + '\')">导入</button></td></tr>';
      });
      Array.prototype.push.apply(allSongs, songs);
      window._hsSongs = allSongs;

      if (reset) {
        html += '</tbody></table></div>';
        hsDetailSongs.innerHTML = html;
      } else {
        var tbody = document.querySelector('.hs-song-table tbody');
        if (tbody) tbody.insertAdjacentHTML('beforeend', html);
      }
      updateHsBatchBtn();
      // 加载更多按钮
      var moreEl = document.getElementById('hs-load-more');
      if (!isEnd) {
        var moreHtml = '<div id="hs-load-more" class="empty-state" style="cursor:pointer;color:var(--primary)" onclick="loadMoreHsSongs()">点击加载更多</div>';
        if (reset) {
          hsDetailSongs.insertAdjacentHTML('beforeend', moreHtml);
        } else {
          if (moreEl) moreEl.textContent = '点击加载更多';
          else hsDetailSongs.insertAdjacentHTML('beforeend', moreHtml);
        }
      } else {
        if (moreEl) moreEl.remove();
      }
    });
  }

  window.playHsSong = function (idx) {
    var songs = window._hsSongs;
    if (!songs || !songs[idx]) return;
    lastResults = songs;
    currentIdx = idx;
    resolveAndPlay(songs[idx], defaultQuality);
  }

  window.toggleAllHsSongs = function (checked) {
    var cbs = document.querySelectorAll('.hs-song-cb');
    cbs.forEach(function (cb) { cb.checked = checked; });
    updateHsBatchBtn();
  };

  window.updateHsBatchBtn = function () {
    var checked = document.querySelectorAll('.hs-song-cb:checked');
    var btn = document.getElementById('hs-batch-import-btn');
    if (btn) {
      btn.style.display = '';
      btn.textContent = checked.length > 0 ? ('批量导入 (' + checked.length + ')') : '批量导入 (全部)';
    }
  };

  window.loadMoreHsSongs = function () {
    _loadHsPage(false);
  };

  window.batchImportHsSongs = function () {
    var btn = document.getElementById('hs-batch-import-btn');
    var checked = document.querySelectorAll('.hs-song-cb:checked');
    if (checked.length > 0) {
      var indices = [];
      checked.forEach(function (cb) { indices.push(parseInt(cb.getAttribute('data-idx'), 10)); });
      _showHsBatchPickerWithIndices(indices);
    } else {
      if (!hsCtx.isEnd) {
        if (btn) btn.textContent = '加载全部歌曲...';
        _loadAllHsPages(function () {
          if (btn) btn.textContent = '批量导入';
          var allIndices = [];
          for (var i = 0; i < (window._hsSongs || []).length; i++) allIndices.push(i);
          document.querySelectorAll('.hs-song-cb').forEach(function (cb) { cb.checked = true; });
          updateHsBatchBtn();
          _showHsBatchPickerWithIndices(allIndices);
        });
      } else {
        var allIndices = [];
        for (var i = 0; i < (window._hsSongs || []).length; i++) allIndices.push(i);
        _showHsBatchPickerWithIndices(allIndices);
      }
    }
  };

  function _loadAllHsPages(cb) {
    if (hsCtx.isEnd || hsCtx.loading) { if (cb) cb(); return; }
    hsCtx.loading = true;
    var params = 'platform=' + encodeURIComponent(hsCtx.platform) + '&id=' + encodeURIComponent(hsCtx.id) + '&page=' + hsCtx.page + '&pageSize=20';
    if (hsCtx.extraStr) params += '&' + hsCtx.extraStr;
    ajax('GET', '/recommend-sheets/detail?' + params, null, function (err, data) {
      hsCtx.loading = false;
      if (err || !data) { if (cb) cb(); return; }
      var songs = data.songs || [];
      var isEnd = data.isEnd !== false;
      if (songs.length === 0) { hsCtx.isEnd = true; if (cb) cb(); return; }
      hsCtx.isEnd = isEnd;
      hsCtx.page++;
      var allSongs = window._hsSongs;
      var startIdx = allSongs.length;
      Array.prototype.push.apply(allSongs, songs);
      window._hsSongs = allSongs;
      var tbody = document.querySelector('.hs-song-table tbody');
      if (tbody) {
        var html = '';
        songs.forEach(function (item, i) {
          var idx = startIdx + i;
          var artist = Array.isArray(item.artist) ? item.artist.join(', ') : (item.artist || '');
          var cover = item.artwork || '';
          var coverHtml = cover
            ? '<img class="song-cover" src="' + escapeHtml(cover) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'inline-flex\'" /><span class="song-cover-fallback" style="display:none">♫</span>'
            : '<span class="song-cover-fallback">♫</span>';
          html += '<tr id="hs-song-' + idx + '">' +
            '<td style="width:36px"><input type="checkbox" class="hs-song-cb" data-idx="' + idx + '" onchange="updateHsBatchBtn()" checked /></td>' +
            '<td class="col-cover">' + coverHtml + '</td>' +
            '<td><div class="cell-title">' + escapeHtml(item.title) + '</div>' +
              '<div class="cell-sub">' + escapeHtml(artist) + ' · ' + escapeHtml(item.platform) + '</div></td>' +
            '<td>' + escapeHtml(artist) + '</td>' +
            '<td class="col-platform">' + escapeHtml(item.platform) + '</td>' +
            '<td class="col-op"><button class="btn btn-small btn-primary btn-play" onclick="playHsSong(' + idx + ')" style="margin-right:4px">播放</button>' +
              '<button class="btn btn-small btn-import" onclick="importToSongloft(' + idx + ',\'hs-song-' + idx + '\')">导入</button></td></tr>';
        });
        tbody.insertAdjacentHTML('beforeend', html);
      }
      _loadAllHsPages(cb);
    });
  }

  function _showHsBatchPickerWithIndices(indices) {
    if (!indices || indices.length === 0) return;
    var listEl = document.getElementById('playlist-list');
    listEl.innerHTML = '<div class="empty-state">加载中...</div>';
    document.getElementById('playlist-modal').style.display = 'flex';

    var xhr = new XMLHttpRequest();
    xhr.open('GET', songloftApiUrl('/api/v1/playlists'), true);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.onload = function () {
      try {
        var data = JSON.parse(xhr.responseText);
        var playlists = data.playlists || data.data || [];
        renderPlaylistList(playlists);
        var origConfirm = window.confirmPlaylistImport;
        window.confirmPlaylistImport = function () {
          var playlistId = _pickerState.playlistId;
          if (playlistId === 'new') {
            var name = document.getElementById('playlist-new-name').value.trim();
            if (!name) { alert('请输入歌单名称'); return; }
          }
          closePlaylistModal();
          _runHsBatchImport(indices, playlistId);
          window.confirmPlaylistImport = origConfirm;
        };
      } catch (e) {
        listEl.innerHTML = '<div class="message error-message">加载歌单失败</div>';
      }
    };
    xhr.onerror = function () {
      listEl.innerHTML = '<div class="message error-message">网络错误</div>';
    };
    xhr.send();
  }

  function _runHsBatchImport(indices, playlistId) {
    var songs = window._hsSongs;
    if (!songs || indices.length === 0) return;
    var total = indices.length;
    var done = 0;
    var allSongIds = [];
    var importBtn = document.getElementById('hs-batch-import-btn');

    function onComplete() {
      if (importBtn) { importBtn.textContent = '已导入'; importBtn.classList.add('btn-imported'); }
      indices.forEach(function (idx) {
        var btn = document.querySelector('#hs-song-' + idx + ' .btn-import');
        if (btn) { btn.textContent = '已导入'; btn.classList.add('btn-imported'); }
      });
      if (playlistId && allSongIds.length > 0) {
        addSongsToPlaylist(playlistId, allSongIds);
      }
    }

    function importOne(i) {
      if (i >= indices.length) { onComplete(); return; }
      var item = songs[indices[i]];
      if (!item) { importOne(i + 1); return; }
      if (importBtn) importBtn.textContent = '导入中 ' + (done + 1) + '/' + total;
      var duration = normalizeDuration(item.duration);
      var payload = [{
        title: item.title || '',
        artist: Array.isArray(item.artist) ? item.artist.join(', ') : (item.artist || ''),
        album: item.album || '',
        cover_url: item.artwork || '',
        url: '',
        duration: duration,
        dedup_key: item.id ? (item.platform + ':' + item.id) : '',
        plugin_entry_path: 'musicfree-adapter',
        source_data: JSON.stringify(item)
      }];
      ajax('POST', '/lyric', { musicItem: item }, function (err, data) {
        var lyricText = '';
        if (!err && data && data.rawLrc) lyricText = data.rawLrc;
        payload[0].lyric = lyricText;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', songloftApiUrl('/api/v1/songs/remote'), true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
          done++;
          try {
            var r = JSON.parse(xhr.responseText);
            if (xhr.status === 201 && r.count > 0 && r.songs) {
              r.songs.forEach(function (s) { allSongIds.push(s.id); });
            }
          } catch (e) {}
          importOne(i + 1);
        };
        xhr.onerror = function () { done++; importOne(i + 1); };
        xhr.send(JSON.stringify(payload));
      });
    }

    function startImport() {
      importOne(0);
    }

    if (playlistId === 'new') {
      if (importBtn) importBtn.textContent = '创建歌单...';
      var name = document.getElementById('playlist-new-name').value.trim() || (songs[indices[0]] ? songs[indices[0]].title : '新歌单');
      var createXhr = new XMLHttpRequest();
      createXhr.open('POST', songloftApiUrl('/api/v1/playlists'), true);
      createXhr.setRequestHeader('Accept', 'application/json');
      createXhr.setRequestHeader('Content-Type', 'application/json');
      createXhr.onload = function () {
        try {
          var pl = JSON.parse(createXhr.responseText);
          if (createXhr.status === 201 && pl.id) {
            playlistId = pl.id;
            startImport();
          } else {
            if (importBtn) importBtn.textContent = '创建失败';
          }
        } catch (e) {
          if (importBtn) importBtn.textContent = '创建失败';
        }
      };
      createXhr.onerror = function () {
        if (importBtn) importBtn.textContent = '创建失败';
      };
      createXhr.send(JSON.stringify({ name: name, type: 'normal' }));
    } else {
      startImport();
    }
  }

  function hideHotSheetDetail() {
    hsDetailEl.style.display = 'none';
    hsListEl.style.display = '';
    var batchBtn = document.getElementById('hs-batch-import-btn');
    if (batchBtn) batchBtn.style.display = 'none';
  }

  document.getElementById('hs-back-btn').addEventListener('click', function () {
    hsDetailEl.style.display = 'none';
    hsListEl.style.display = '';
  });

  // --- 用户变量编辑 ---
  var editingVarsUrl = '';

  window.openVarsModal = function (url, platform) {
    editingVarsUrl = url;
    document.getElementById('vars-modal-title').textContent = '变量设置 - ' + platform;
    document.getElementById('vars-editor').value = '';
    document.getElementById('vars-status').innerHTML = '';
    document.getElementById('vars-modal').style.display = 'flex';
    ajax('GET', '/plugin-vars?url=' + encodeURIComponent(url), null, function (err, data) {
      if (err || !data || data.error) {
        document.getElementById('vars-editor').value = '{\n  "error": "无法加载变量"\n}';
        return;
      }
      document.getElementById('vars-editor').value = JSON.stringify(data.variables || {}, null, 2);
    });
  };

  window.closeVarsModal = function () {
    document.getElementById('vars-modal').style.display = 'none';
    editingVarsUrl = '';
  };

  window.saveVars = function () {
    var text = document.getElementById('vars-editor').value.trim();
    var varsEl = document.getElementById('vars-status');
    var saveBtn = document.getElementById('vars-save-btn');
    try {
      var parsed = text ? JSON.parse(text) : {};
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('必须是一个 JSON 对象');
      }
      saveBtn.disabled = true;
      ajax('PUT', '/plugin-vars', { url: editingVarsUrl, variables: parsed }, function (err, data) {
        saveBtn.disabled = false;
        if (err || !data || !data.success) {
          varsEl.innerHTML = '<div class="message error-message">保存失败</div>';
        } else {
          varsEl.innerHTML = '<div class="message success-message">保存成功</div>';
        }
      });
    } catch (e) {
      varsEl.innerHTML = '<div class="message error-message">JSON 格式错误: ' + e.message + '</div>';
    }
  };

  // 点击遮罩层关闭弹窗
  document.getElementById('vars-modal').addEventListener('click', function (e) {
    if (e.target === this) closeVarsModal();
  });

  // --- 订阅设置（服务端持久化） ---
  var subscriptions = [];
  var editingSubIdx = -1; // 当前正在编辑的订阅索引，-1 表示新增模式

  function loadSubscriptions(cb) {
    ajax('GET', '/subscriptions', null, function (err, data) {
      if (err || !data) {
        subscriptions = [];
      } else {
        subscriptions = data.subscriptions || [];
      }
      if (cb) cb();
    });
  }

  function renderSubList() {
    var listEl = document.getElementById('sub-list');
    if (!listEl) return;
    if (subscriptions.length === 0) {
      listEl.innerHTML = '<div class="empty-state">暂无订阅源，添加一个订阅链接以批量管理插件</div>';
      return;
    }
    var html = '';
    subscriptions.forEach(function (sub, idx) {
      var url = sub.url || '';
      var updatedAt = sub.updatedAt ? new Date(sub.updatedAt).toLocaleString() : '未更新';
      var count = typeof sub.pluginCount === 'number' && sub.pluginCount > 0 ? sub.pluginCount + ' 个插件' : '';
      var meta = count ? (count + ' · 更新于 ' + updatedAt) : ('更新于 ' + updatedAt);
      var editingCls = idx === editingSubIdx ? ' editing' : '';
      html += '<div class="sub-item' + editingCls + '">' +
        '<div class="sub-item-icon">&#128246;</div>' +
        '<div class="sub-item-info">' +
          '<div class="sub-item-url">' + escapeHtml(url) + '</div>' +
          '<div class="sub-item-meta">' + escapeHtml(meta) + '</div>' +
        '</div>' +
        '<button class="sub-item-btn" title="修改订阅地址" onclick="editSubscription(' + idx + ')">&#9998;</button>' +
        '<button class="sub-item-btn sub-item-remove" title="删除订阅" onclick="removeSubscription(' + idx + ')">&times;</button>' +
      '</div>';
    });
    listEl.innerHTML = html;
  }

  // 切换输入区为"新增"或"编辑"模式
  function updateInputMode() {
    var addBtn = document.getElementById('sub-add-btn');
    var cancelBtn = document.getElementById('sub-cancel-btn');
    var inputRow = document.querySelector('.sub-input-row');
    var input = document.getElementById('sub-url-input');
    if (editingSubIdx >= 0) {
      addBtn.textContent = '保存修改';
      addBtn.classList.add('btn-import');
      cancelBtn.style.display = '';
      inputRow.classList.add('editing');
      input.focus();
    } else {
      addBtn.textContent = '+ 添加订阅';
      addBtn.classList.remove('btn-import');
      cancelBtn.style.display = 'none';
      inputRow.classList.remove('editing');
    }
  }

  // 取消编辑，回到新增模式
  window.cancelEdit = function () {
    editingSubIdx = -1;
    document.getElementById('sub-url-input').value = '';
    updateInputMode();
    renderSubList();
  };

  window.openSubModal = function () {
    document.getElementById('sub-modal').style.display = 'flex';
    editingSubIdx = -1;
    document.getElementById('sub-url-input').value = '';
    updateInputMode();
    loadSubscriptions(function () {
      renderSubList();
    });
  };

  window.openSubModalAndUpdate = function () {
    openSubModal();
    setTimeout(function () { updateAllSubscriptions(); }, 300);
  };

  window.closeSubModal = function () {
    document.getElementById('sub-modal').style.display = 'none';
    editingSubIdx = -1;
  };

  document.getElementById('sub-modal').addEventListener('click', function (e) {
    if (e.target === this) closeSubModal();
  });

  // 点击修改：把订阅地址填入输入框，进入编辑模式
  window.editSubscription = function (idx) {
    var sub = subscriptions[idx];
    if (!sub) return;
    editingSubIdx = idx;
    document.getElementById('sub-url-input').value = sub.url;
    updateInputMode();
    renderSubList();
  };

  window.addSubscription = function () {
    var input = document.getElementById('sub-url-input');
    var url = (input.value || '').trim();
    if (!url) {
      alert('请输入订阅链接');
      return;
    }
    // 编辑模式：更新订阅地址
    if (editingSubIdx >= 0) {
      var oldSub = subscriptions[editingSubIdx];
      if (!oldSub) { cancelEdit(); return; }
      if (url === oldSub.url) {
        // 地址未改动，直接退出编辑
        cancelEdit();
        return;
      }
      ajax('PUT', '/subscriptions', { url: oldSub.url, newUrl: url }, function (err, data) {
        if (err || !data) {
          alert('修改失败（网络错误）');
          return;
        }
        if (data.error) {
          alert(data.error);
          return;
        }
        if (!data.success) {
          alert('修改失败');
          return;
        }
        // 更新本地数据
        subscriptions[editingSubIdx] = data.subscription;
        cancelEdit();
      });
      return;
    }
    // 新增模式
    ajax('POST', '/subscriptions', { url: url }, function (err, data) {
      if (err || !data) {
        alert('添加失败（网络错误）');
        return;
      }
      if (data.error) {
        alert(data.error);
        return;
      }
      if (!data.success) {
        alert('添加失败');
        return;
      }
      subscriptions.push(data.subscription);
      input.value = '';
      renderSubList();
      // 自动更新该订阅
      updateSubscription(subscriptions.length - 1);
    });
  };

  window.removeSubscription = function (idx) {
    var sub = subscriptions[idx];
    if (!sub) return;
    if (!confirm('确认删除此订阅源？')) return;
    ajax('DELETE', '/subscriptions', { url: sub.url }, function (err, data) {
      if (err || !data || !data.success) {
        alert('删除失败');
        return;
      }
      subscriptions.splice(idx, 1);
      renderSubList();
    });
  };

  // 从订阅地址获取插件 URL 列表
  function fetchSubPlugins(url, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = function () {
      try {
        var data = JSON.parse(xhr.responseText);
        // 支持多种格式：数组、{plugins:[]}、{data:[]}
        var list = [];
        if (Array.isArray(data)) {
          list = data;
        } else if (Array.isArray(data.plugins)) {
          list = data.plugins;
        } else if (Array.isArray(data.data)) {
          list = data.data;
        } else if (Array.isArray(data.list)) {
          list = data.list;
        }
        // 提取 URL：字符串直接用，对象取 url/link/uri 字段
        var urls = list.map(function (item) {
          if (typeof item === 'string') return item;
          return item.url || item.link || item.uri || '';
        }).filter(function (u) { return u && /^https?:\/\//i.test(u); });
        callback(null, urls);
      } catch (e) {
        callback(e, null);
      }
    };
    xhr.onerror = function () {
      callback(new Error('网络错误'), null);
    };
    xhr.send();
  }

  // 更新单个订阅（拉取插件列表并批量安装）
  function updateSubscription(idx, cb) {
    var sub = subscriptions[idx];
    if (!sub) { if (cb) cb(); return; }
    fetchSubPlugins(sub.url, function (err, urls) {
      if (err) {
        alert('订阅 ' + sub.url + ' 获取失败：' + err.message);
        if (cb) cb(err);
        return;
      }
      // 更新服务端的订阅记录（插件数量、更新时间）
      ajax('PUT', '/subscriptions', { url: sub.url, pluginCount: urls.length }, function () {
        sub.updatedAt = Date.now();
        sub.pluginCount = urls.length;
        renderSubList();
      });
      // 依次安装/更新插件
      var i = 0;
      function installNext() {
        if (i >= urls.length) {
          loadPluginList();
          if (cb) cb(null, urls.length);
          return;
        }
        ajax('POST', '/plugins', { url: urls[i], force: true }, function () {
          i++;
          installNext();
        });
      }
      installNext();
    });
  }

  window.updateAllSubscriptions = function () {
    if (subscriptions.length === 0) {
      showToast('暂无订阅源', true);
      return;
    }
    var btn = document.querySelector('#sub-modal .modal-footer .btn');
    var progressWrap = document.getElementById('sub-update-progress');
    var progressBar = document.getElementById('sub-update-bar');
    var progressText = document.getElementById('sub-update-text');
    var progressCount = document.getElementById('sub-update-count');

    btn.disabled = true;
    progressWrap.style.display = '';
    progressBar.style.width = '0%';
    progressCount.textContent = '0/' + subscriptions.length;

    var done = 0;
    var total = subscriptions.length;
    function next() {
      if (done >= total) {
        btn.disabled = false;
        progressText.textContent = '全部订阅已更新完成';
        progressBar.style.width = '100%';
        progressCount.textContent = total + '/' + total;
        setTimeout(function () { progressWrap.style.display = 'none'; }, 3000);
        return;
      }
      var sub = subscriptions[done];
      progressText.textContent = '正在更新：' + (sub.name || sub.url);
      updateSubscription(done, function () {
        done++;
        var pct = Math.round(done / total * 100);
        progressBar.style.width = pct + '%';
        progressCount.textContent = done + '/' + total;
        next();
      });
    }
    next();
  };
})();