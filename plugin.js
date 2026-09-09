const fs = require('fs');
const path = require('path');

let timer = null;
let lastCnum = 0;
let isPolling = false;
let isInitialized = false;
let resolvedServiceId = null;

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

const plugin = {
  name: 'kukuluLIVE コメント連携',
  uid: 'com.kukululive.comment-sync',
  version: '1.3.1',
  author: 'orangeqoon',
  url: 'https://github.com/orangeqoon/onecomme-plugin-kukulu',
  permissions: ['comments'],
  defaultState: {},

  init({ dir }) {
    console.info('[kukulu-plugin] 初期化開始 (お絵描き画像表示対応 v1.3.1)');
    const configPath = path.join(dir, 'config.json');
    const sampleConfigPath = path.join(dir, 'config.sample.json');

    // config.json が無い場合は雛形を自動作成
    if (!fs.existsSync(configPath)) {
      if (fs.existsSync(sampleConfigPath)) {
        fs.copyFileSync(sampleConfigPath, configPath);
      } else {
        const initialConfig = {
          apikey: "ここにKukuluのAPIキーを入力",
          serviceId: "",
          intervalMs: 2000,
          autoPublish: true,
          autoGetPort: true
        };
        fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2), 'utf8');
      }
      console.info('[kukulu-plugin] config.json を作成しました。APIキーを設定してください。');
      return;
    }

    // 枠状態チェック & 自動枠取得・公開化
    const checkLivePort = async (apikey, config) => {
      try {
        const infoUrl = `https://live.erinn.biz/api/?category=mylive&type=port_info&apikey=${encodeURIComponent(apikey)}`;
        const res = await fetch(infoUrl);
        if (!res.ok) return;
        const data = await res.json();
        if (!data || data.success !== 1) return;

        // 1. 配信枠が存在しない場合の自動取得（設定で有効な場合）
        const autoGet = config.autoGetPort !== false;
        const hasLive = String(data.mylive) === '1';
        if (!hasLive && autoGet) {
          console.info('[kukulu-plugin] 配信枠が存在しないため、自動で枠を取得します...');
          const getUrl = `https://live.erinn.biz/api/?category=mylive&type=port_get&apikey=${encodeURIComponent(apikey)}&eula=1`;
          const getRes = await fetch(getUrl);
          const getData = await getRes.json();
          if (getData && getData.success === 1) {
            console.info('[kukulu-plugin] 配信枠の自動取得に成功しました！');
          }
          return;
        }

        // 2. OBSプッシュ接続中で、まだ「準備中(status: 1)」の場合は自動で「公開配信(status: 2)」に切り替え！
        const autoPublish = config.autoPublish !== false;
        const isConnected = String(data.connect) === '1';
        const isPreparing = String(data.status) === '1';
        if (isConnected && isPreparing && autoPublish) {
          console.info('[kukulu-plugin] OBS接続を検知！自動で「配信中（公開）」に切り替えます...');
          const statusUrl = `https://live.erinn.biz/api/?category=mylive&type=port_status&apikey=${encodeURIComponent(apikey)}&status=2`;
          const statusRes = await fetch(statusUrl);
          const statusData = await statusRes.json();
          if (statusData && statusData.success === 1) {
            console.info('[kukulu-plugin] ★公開配信が開始されました！');
          }
        }
      } catch (err) {
        console.error('[kukulu-plugin] 配信枠チェックエラー:', err.message || err);
      }
    };

    // コメント送信処理
    const sendCommentList = async (comments, serviceId) => {
      await ensureServiceEnabled(serviceId);

      for (const item of comments) {
        const cnum = Number(item.cnum);
        if (cnum && cnum <= lastCnum) continue;
        if (cnum) lastCnum = cnum;

        // 管理用内部通知はスキップ
        if (item.from === 'admin' && item.message && item.message.startsWith('__INFO__')) continue;

        let commentText = item.message || '';

        // お絵描きコメント（visualchat）の画像埋め込み
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
            commentText = `${commentText ? commentText + '<br>' : ''}<img src="${imgUrl}" alt="[お絵描き]" style="max-width: 250px; max-height: 200px; object-fit: contain; border-radius: 4px; display: block; margin-top: 4px;" />`;
          } else {
            commentText = commentText ? `${commentText} [お絵描き]` : '[お絵描き]';
          }
        } else if (item.type === 'sscomment') {
          // 画像・動画コメント（sscomment）の画像埋め込み
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
          if (!mediaUrl && item.url) {
            mediaUrl = item.url;
          }
          if (mediaUrl) {
            commentText = `${commentText ? commentText + '<br>' : ''}<img src="${mediaUrl}" alt="[画像]" style="max-width: 250px; max-height: 200px; object-fit: contain; border-radius: 4px; display: block; margin-top: 4px;" />`;
          } else {
            commentText = commentText ? `${commentText} [画像/動画]` : '[画像/動画]';
          }
        }

        const isMaster = item.from === 'master';
        const payload = {
          service: { id: serviceId, write: true, speech: true, persist: true },
          comment: {
            id: String(item.cnum || item.number || Date.now()),
            userId: String(item.ipid || (isMaster ? 'master' : 'unknown')),
            name: item.icon_name || (isMaster ? '配信者' : '名無し'),
            badges: [],
            profileImage: '',
            comment: commentText,
            hasGift: false,
            isOwner: isMaster,
            timestamp: item.time ? Number(item.time) * 1000 : Date.now()
          }
        };

        await fetch('http://localhost:11180/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(err => console.error('[kukulu-plugin] わんコメへのコメント送信エラー:', err.message));
      }
    };

    // コメント取得関数
    const fetchComments = async (apikey, serviceId) => {
      let url = `https://live.erinn.biz/api/?category=comment&type=list&apikey=${encodeURIComponent(apikey)}`;
      if (lastCnum > 0) url += `&cnum=${lastCnum}`;

      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();

      if (data && data.success === 1 && Array.isArray(data.comments)) {
        if (!isInitialized) {
          const maxCnum = data.comments.length > 0
            ? Math.max(...data.comments.map(c => Number(c.cnum) || 0))
            : 0;
          const nowMs = Date.now();
          const thresholdMs = nowMs - 15 * 60 * 1000;
          const recent = data.comments.filter(c => c.time && Number(c.time) * 1000 >= thresholdMs);
          if (recent.length > 0) {
            console.info(`[kukulu-plugin] 初回接続: 直近15分以内のコメント ${recent.length} 件を取り込みます`);
            const sortedRecent = [...recent].sort((a, b) => (Number(a.cnum) || 0) - (Number(b.cnum) || 0));
            await sendCommentList(sortedRecent, serviceId);
          } else {
            console.info(`[kukulu-plugin] 初回接続完了: 既存コメント${data.comments.length}件をスキップ (最新cnum: ${maxCnum})`);
          }
          lastCnum = Math.max(lastCnum, maxCnum);
          isInitialized = true;
          return;
        }
        const sorted = [...data.comments].sort((a, b) => (Number(a.cnum) || 0) - (Number(b.cnum) || 0));
        await sendCommentList(sorted, serviceId);
      }
    };

    const poll = async () => {
      if (isPolling) return;
      isPolling = true;
      try {
        if (!fs.existsSync(configPath)) return;
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const { apikey, serviceId: configuredServiceId } = config;

        if (!apikey || apikey.includes('ここに') || apikey.trim() === '') {
          return;
        }

        const serviceId = await resolveServiceId(configuredServiceId);
        if (!serviceId) {
          console.warn('[kukulu-plugin] わんコメにKukulu用の配信枠が見つかりません。わんコメで枠を追加（枠名を「Kukulu」にするか、URLを「https://live.erinn.biz/」等に設定）してください。');
          return;
        }

        await checkLivePort(apikey, config);
        await fetchComments(apikey, serviceId);
      } catch (err) {
        console.error('[kukulu-plugin] ポーリング中エラー:', err.message || err);
      } finally {
        isPolling = false;
      }
    };

    let intervalMs = 2000;
    try {
      if (fs.existsSync(configPath)) {
        const conf = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (conf.intervalMs && conf.intervalMs >= 1000) {
          intervalMs = conf.intervalMs;
        }
      }
    } catch (_) {}

    timer = setInterval(poll, intervalMs);
    console.info(`[kukulu-plugin] 監視ループを開始しました (${intervalMs}ms 間隔)`);
  },

  destroy() {
    if (timer) { clearInterval(timer); timer = null; }
    isPolling = false;
    lastCnum = 0;
    isInitialized = false;
    resolvedServiceId = null;
    console.info('[kukulu-plugin] プラグインを停止しました');
  }
};

module.exports = plugin;
