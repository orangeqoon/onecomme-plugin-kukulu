const fs = require('fs');
const path = require('path');

let timer = null;
let lastCnum = 0;
let isPolling = false;
let isInitialized = false;
let resolvedServiceId = null;
let emotionsCache = {}; // 全体エモーション辞書キャッシュ
let currentDir = __dirname;

// ステータス管理
let statusState = {
  status: 'idle', // idle, connecting, active, no_live, error
  message: '待機中',
  liveId: '',
  totalReceived: 0,
  lastCheckTime: null
};

// わんコメ内の枠IDを自動解決（未指定なら枠名・URLから自動検出）
async function resolveServiceId(configuredId) {
  if (configuredId && !configuredId.includes('ここに') && configuredId.trim() !== '') {
    return configuredId.trim();
  }
  if (resolvedServiceId) return resolvedServiceId;

  try {
    const res = await fetch('http://localhost:11180/api/services');
    if (!res.ok) return null;
    const services = await res.json();
    const target = services.find(s => {
      const name = (s.name || '').toLowerCase();
      const url = (s.url || '').toLowerCase();
      return name.includes('kukulu') || url.includes('kuku.lu') || url.includes('erinn.biz');
    });

    if (target) {
      resolvedServiceId = target.id;
      console.info(`[kukulu-plugin] わんコメの枠 '${target.name}' (ID: ${target.id}) を自動検出しました！`);
      return target.id;
    }
  } catch (err) {
    console.warn('[kukulu-plugin] 枠一覧の取得に失敗:', err.message);
  }
  return null;
}

// 枠がOFFになってビューアから消えるのを防ぐため、自動で有効化
async function ensureServiceEnabled(serviceId) {
  if (!serviceId) return;
  try {
    await fetch(`http://localhost:11180/api/services/${encodeURIComponent(serviceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, write: true })
    });
  } catch (_) {}
}

// 枠状態チェック & 自動枠取得・公開化
async function checkLivePort(apikey, config) {
  try {
    const infoUrl = `https://live.erinn.biz/api/?category=mylive&type=port_info&apikey=${encodeURIComponent(apikey)}`;
    const res = await fetch(infoUrl);
    if (!res.ok) return;
    const data = await res.json();
    if (!data || data.success !== 1) {
      statusState.status = 'error';
      statusState.message = 'APIキーが無効または通信エラー';
      return;
    }

    const autoGet = config.autoGetPort === true;
    const hasLive = String(data.mylive) === '1';

    if (hasLive && data.liveid) {
      statusState.liveId = String(data.liveid);
    }

    // 1. 配信枠が存在しない場合の自動取得
    if (!hasLive && autoGet) {
      statusState.status = 'connecting';
      statusState.message = '配信枠が存在しないため自動取得中...';
      console.info('[kukulu-plugin] 配信枠が存在しないため、自動で枠を取得します...');
      const getUrl = `https://live.erinn.biz/api/?category=mylive&type=port_get&apikey=${encodeURIComponent(apikey)}&eula=1`;
      const getRes = await fetch(getUrl);
      if (getRes.ok) {
        const getData = await getRes.json();
        if (getData && getData.success === 1) {
          console.info(`[kukulu-plugin] 枠の自動取得に成功しました！(Port: ${getData.port})`);
          statusState.liveId = String(getData.liveid || '');
        }
      }
    } else if (!hasLive) {
      statusState.status = 'no_live';
      statusState.message = '配信枠なし（待機中）';
    }

    // 2. 枠が非公開の場合の自動公開化
    const autoPub = config.autoPublish !== false;
    const isPublic = String(data.public) === '1';
    if (hasLive && !isPublic && autoPub) {
      console.info('[kukulu-plugin] 枠が非公開のため、自動で公開化します...');
      const pubUrl = `https://live.erinn.biz/api/?category=mylive&type=port_publish&apikey=${encodeURIComponent(apikey)}&public=1`;
      await fetch(pubUrl).catch(() => {});
    }
  } catch (err) {
    statusState.status = 'error';
    statusState.message = '枠チェック通信失敗: ' + err.message;
    console.error('[kukulu-plugin] 枠チェックエラー:', err.message);
  }
}

// コメント一覧送信
async function sendCommentList(comments, serviceId, config) {
  await ensureServiceEnabled(serviceId);

  const maxWidth = config.imageMaxWidth || 650;
  const maxHeight = config.imageMaxHeight || 520;

  for (const item of comments) {
    const cnum = Number(item.cnum);
    if (cnum > lastCnum) {
      lastCnum = cnum;
    }

    let commentText = item.comment || '';

    // --- 自動在席確認（定期点呼）の検知と自動応答 ---
    if (item.from === 'system' && (item.is_absence === 1 || item.is_absence === '1' || commentText.includes('在席確認'))) {
      const match = commentText.match(/「([^」]+)」/);
      if (match && match[1]) {
        const keyword = match[1];
        const minMs = 10 * 60 * 1000;
        const maxMs = 40 * 60 * 1000;
        const delayMs = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
        const delayMinutes = (delayMs / 1000 / 60).toFixed(1);
        console.info(`[kukulu-plugin] 自動在席確認を検出しました。約${delayMinutes}分後にキーワード「${keyword}」を自動応答します。`);

        const writeUrl = `https://live.erinn.biz/api/?category=comment&type=write&apikey=${encodeURIComponent(config.apikey)}&comment=${encodeURIComponent(keyword)}&icon=1`;

        setTimeout(() => {
          fetch(writeUrl)
            .then(res => res.json())
            .then(data => {
              if (data && data.success === 1) {
                console.info(`[kukulu-plugin] 自動在席確認に自動応答しました: ${keyword}`);
              } else {
                console.warn(`[kukulu-plugin] 自動在席確認の応答エラー:`, data);
              }
            })
            .catch(err => console.error('[kukulu-plugin] 自動在席確認の応答リクエスト失敗:', err.message));
        }, delayMs);
      }
    }

    const escapeHtml = (str) => {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    // エモーション（絵文字）処理
    const localEmotions = {};
    if (item.emotions && typeof item.emotions === 'object' && !Array.isArray(item.emotions)) {
      Object.assign(localEmotions, item.emotions);
    }
    const combinedEmotions = { ...emotionsCache, ...localEmotions };
    const sortedEmoKeys = Object.keys(combinedEmotions)
      .filter(key => key.trim().length > 0)
      .sort((a, b) => b.length - a.length);

    if (sortedEmoKeys.length > 0) {
      const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regexPattern = new RegExp(sortedEmoKeys.map(escapeRegExp).join('|'), 'g');
      commentText = commentText.replace(regexPattern, (match) => {
        const emoData = combinedEmotions[match];
        if (emoData && emoData.url) {
          const safeUrl = escapeHtml(emoData.url);
          const safeAlt = escapeHtml(emoData.message || match);
          return `<img src="${safeUrl}" alt="${safeAlt}" title="${safeAlt}" style="height:1.5em; vertical-align:middle; display:inline-block; margin:0 2px;" />`;
        }
        return match;
      });
    }

    // お絵描きコメント（visualchat）
    if (item.type === 'visualchat') {
      let imgUrl = '';
      if (item.message_additional) {
        if (typeof item.message_additional === 'string') {
          try {
            const parsed = JSON.parse(item.message_additional);
            imgUrl = parsed.visualchat_url || '';
          } catch (_) {}
        } else if (typeof item.message_additional === 'object') {
          imgUrl = item.message_additional.visualchat_url || '';
        }
      }
      if (imgUrl) {
        commentText = `${commentText ? commentText + '<br>' : ''}<div style="margin-top:8px;"><a href="${imgUrl}" target="_blank" rel="noopener noreferrer" title="クリックで原寸大表示"><img src="${imgUrl}" alt="[お絵描き]" style="width:100%;max-width:${maxWidth}px;max-height:${maxHeight}px;object-fit:contain;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.22);display:block;background:#ffffff;border:1px solid rgba(0,0,0,0.1);cursor:pointer;" /></a></div>`;
      } else {
        commentText = commentText ? `${commentText} [お絵描き]` : '[お絵描き]';
      }
    } else if (item.type === 'sscomment') {
      // 画像・動画コメント（sscomment）
      let mediaUrl = '';
      if (item.message_additional) {
        if (typeof item.message_additional === 'string') {
          try {
            const parsed = JSON.parse(item.message_additional);
            mediaUrl = parsed.ss_url || parsed.url || parsed.image_url || '';
          } catch (_) {}
        } else if (typeof item.message_additional === 'object') {
          mediaUrl = item.message_additional.ss_url || item.message_additional.url || item.message_additional.image_url || '';
        }
      }
      if (!mediaUrl && item.url) mediaUrl = item.url;
      if (mediaUrl) {
        commentText = `${commentText ? commentText + '<br>' : ''}<div style="margin-top:8px;"><a href="${mediaUrl}" target="_blank" rel="noopener noreferrer" title="クリックで原寸大表示"><img src="${mediaUrl}" alt="[画像]" style="width:100%;max-width:${maxWidth}px;max-height:${maxHeight}px;object-fit:contain;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.22);display:block;background:#ffffff;border:1px solid rgba(0,0,0,0.1);cursor:pointer;" /></a></div>`;
      } else {
        commentText = commentText ? `${commentText} [画像/動画]` : '[画像/動画]';
      }
    }

    const isMaster = item.from === 'master';
    const payload = {
      service: {
        id: serviceId,
        write: true,
        speech: true,
        persist: true
      },
      comment: {
        id: `kukulu_${item.cnum || Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        userId: String(item.user_hash || item.uid || item.ip || 'anonymous'),
        name: isMaster ? `${item.name || '配信者'} (主)` : (item.name || '名無し'),
        badges: [],
        profileImage: item.user_icon || '',
        comment: commentText,
        hasGift: false,
        isOwner: isMaster,
        timestamp: item.time ? (Number(item.time) * 1000) : Date.now()
      }
    };

    await fetch('http://localhost:11180/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => {
      console.error('[kukulu-plugin] コメント送信エラー:', err.message);
    });

    statusState.totalReceived++;
  }
}

// コメント取得処理
async function fetchComments(apikey, serviceId, config) {
  const url = `https://live.erinn.biz/api/?category=comment&type=get&apikey=${encodeURIComponent(apikey)}&cnum=${lastCnum}`;
  const res = await fetch(url);
  if (!res.ok) {
    statusState.status = 'error';
    statusState.message = `HTTPエラー: ${res.status}`;
    return;
  }

  const data = await res.json();
  if (!data || data.success !== 1) {
    if (data && data.success === 0) {
      statusState.status = 'error';
      statusState.message = 'APIキーが無効または期限切れです';
    }
    return;
  }

  statusState.status = 'active';
  statusState.message = '受信中（正常稼働）';
  statusState.lastCheckTime = Date.now();

  if (!isInitialized) {
    isInitialized = true;
    lastCnum = Number(data.cnum_now) || 0;
    console.info(`[kukulu-plugin] 初回接続成功！最新cnum: ${lastCnum} から待機開始`);

    if (Array.isArray(data.comments) && data.comments.length > 0) {
      const sorted = [...data.comments].sort((a, b) => (Number(a.cnum) || 0) - (Number(b.cnum) || 0));
      const recent = sorted.slice(-5);
      await sendCommentList(recent, serviceId, config);
    }
    return;
  }

  if (Array.isArray(data.comments) && data.comments.length > 0) {
    const sorted = [...data.comments].sort((a, b) => (Number(a.cnum) || 0) - (Number(b.cnum) || 0));
    await sendCommentList(sorted, serviceId, config);
  }
}

function startPolling(dir) {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  isPolling = false;
  lastCnum = 0;
  isInitialized = false;
  resolvedServiceId = null;

  const configPath = path.join(dir, 'config.json');
  if (!fs.existsSync(configPath)) {
    statusState.status = 'idle';
    statusState.message = '設定未完了 (config.json なし)';
    return;
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    statusState.status = 'error';
    statusState.message = 'config.json パースエラー';
    return;
  }

  const { apikey, serviceId: configuredServiceId } = config;
  if (!apikey || apikey.includes('ここに') || apikey.trim() === '') {
    statusState.status = 'idle';
    statusState.message = '設定未完了（APIキー未入力）';
    return;
  }

  statusState.status = 'connecting';
  statusState.message = '接続確認中...';

  const poll = async () => {
    if (isPolling) return;
    isPolling = true;

    try {
      if (!fs.existsSync(configPath)) return;
      const conf = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const key = conf.apikey;
      const sId = await resolveServiceId(conf.serviceId);

      if (!key || key.includes('ここに') || key.trim() === '') return;

      if (!sId) {
        statusState.status = 'error';
        statusState.message = 'わんコメ枠が見つかりません';
        console.warn('[kukulu-plugin] わんコメにKukulu用の配信枠が見つかりません。');
        return;
      }

      await checkLivePort(key, conf);

      if (!isInitialized) {
        try {
          const emoUrl = `https://live.erinn.biz/api/?category=comment&type=emotions&apikey=${encodeURIComponent(key)}`;
          const emoRes = await fetch(emoUrl);
          if (emoRes.ok) {
            const emoData = await emoRes.json();
            if (emoData && emoData.success === 1 && emoData.emotions) {
              if (typeof emoData.emotions === 'object' && !Array.isArray(emoData.emotions)) {
                Object.assign(emotionsCache, emoData.emotions);
                console.info(`[kukulu-plugin] エモーション辞書 (${Object.keys(emotionsCache).length}件) を取得しました`);
              }
            }
          }
        } catch (_) {}
      }

      await fetchComments(key, sId, conf);
    } catch (err) {
      console.error('[kukulu-plugin] ポーリング中エラー:', err.message || err);
    } finally {
      isPolling = false;
    }
  };

  let intervalMs = 2000;
  if (config.intervalMs && config.intervalMs >= 1000) {
    intervalMs = config.intervalMs;
  }

  timer = setInterval(poll, intervalMs);
  poll();
  console.info(`[kukulu-plugin] 監視ループを開始しました (${intervalMs}ms 間隔)`);
}

const plugin = {
  name: 'kukuluLIVE コメント連携',
  uid: 'com.kukululive.comment-sync',
  version: '1.5.1',
  author: 'orangeqoon',
  url: 'https://github.com/orangeqoon/onecomme-plugin-kukulu',
  permissions: ['comments'],
  defaultState: {},

  init({ dir }) {
    currentDir = dir;
    console.info('[kukulu-plugin] 初期化開始 (Kukulu コメント連携 v1.5.1)');
    const configPath = path.join(dir, 'config.json');
    const sampleConfigPath = path.join(dir, 'config.sample.json');

    if (!fs.existsSync(configPath)) {
      if (fs.existsSync(sampleConfigPath)) {
        fs.copyFileSync(sampleConfigPath, configPath);
      } else {
        const initialConfig = {
          apikey: "",
          serviceId: "",
          intervalMs: 2000,
          autoPublish: true,
          autoGetPort: true,
          imageMaxWidth: 650,
          imageMaxHeight: 520
        };
        fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2), 'utf8');
      }
    }

    startPolling(dir);
  },

  // わんコメ Web API 通信ハンドラ (/api/plugins/com.kukululive.comment-sync)
  async request(req) {
    const configPath = path.join(currentDir, 'config.json');

    if (req.method === 'GET') {
      let config = {
        apikey: '',
        serviceId: '',
        intervalMs: 2000,
        autoPublish: true,
        autoGetPort: true,
        imageMaxWidth: 650,
        imageMaxHeight: 520
      };
      try {
        if (fs.existsSync(configPath)) {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
      } catch (_) {}

      return {
        code: 200,
        body: {
          config,
          status: statusState
        }
      };
    }

    if (req.method === 'POST') {
      try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        let config = {};
        if (fs.existsSync(configPath)) {
          try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
        }

        if (body.apikey !== undefined) config.apikey = String(body.apikey).trim();
        if (body.serviceId !== undefined) config.serviceId = String(body.serviceId).trim();
        if (body.intervalMs !== undefined) config.intervalMs = Math.max(1000, Number(body.intervalMs) || 2000);
        if (body.autoPublish !== undefined) config.autoPublish = Boolean(body.autoPublish);
        if (body.autoGetPort !== undefined) config.autoGetPort = Boolean(body.autoGetPort);
        if (body.imageMaxWidth !== undefined) config.imageMaxWidth = Number(body.imageMaxWidth) || 650;
        if (body.imageMaxHeight !== undefined) config.imageMaxHeight = Number(body.imageMaxHeight) || 520;

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        console.info('[kukulu-plugin] Web設定画面から設定が更新されました。再接続します...');

        startPolling(currentDir);

        return {
          code: 200,
          body: {
            success: true,
            config,
            status: statusState
          }
        };
      } catch (err) {
        return {
          code: 400,
          body: { success: false, error: err.message }
        };
      }
    }

    return { code: 405, body: { error: 'Method Not Allowed' } };
  },

  destroy() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    isPolling = false;
    lastCnum = 0;
    isInitialized = false;
    resolvedServiceId = null;
    statusState.status = 'idle';
    statusState.message = '停止中';
    console.info('[kukulu-plugin] プラグインを停止しました');
  }
};

module.exports = plugin;
