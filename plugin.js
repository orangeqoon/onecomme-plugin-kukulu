const fs = require('fs');
const path = require('path');
const http = require('http');

let timer = null;
let isPolling = false;
let lastCnum = 0;
let isInitialized = false;
let resolvedServiceId = null;
let currentHash = '';
let popupServer = null;
let popupPort = 0;
let isUrlSynced = false;

const plugin = {
  name: 'Kukulu LIVE Plugin',
  uid: 'dev.orangeqoon.kukulu',
  version: '1.4.1',
  author: 'orangeqoon',
  url: 'https://github.com/orangeqoon/onecomme-plugin-kukulu',
  permissions: ['comment', 'service'],
  defaultState: {},

  init({ dir, store }) {
    const configPath = path.join(dir, 'config.json');

    if (!fs.existsSync(configPath)) {
      const defaultConfig = {
        apikey: "YOUR_API_KEY_HERE",
        serviceId: "",
        intervalMs: 2000,
        imageMaxWidth: 650,
        imageMaxHeight: 520
      };
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
      console.info('[kukulu-plugin] config.json を新規作成しました。APIキーを設定してください。');
    }

    // コメントポップアップ用ローカルサーバー起動
    popupServer = http.createServer((req, res) => {
      if (req.url === '/') {
        if (currentHash) {
          // 動的に取得したハッシュ付きURLへリダイレクト
          res.writeHead(302, { 'Location': `https://live.erinn.biz/live.comment.php?hash=${currentHash}` });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html><head><meta charset="utf-8"><title>Kukulu Comment</title></head>
            <body style="background:#333;color:#fff;font-family:sans-serif;padding:20px;">
              <h2>Kukuluの配信情報を確認しています...</h2>
              <p>配信が開始されているか、わんコメがKukuluに接続できているか確認してください。</p>
              <p>数秒待ってからこのページをリロードすると、コメント専用ポップアップに移動します。</p>
            </body></html>
          `);
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    popupServer.listen(0, '127.0.0.1', () => {
      popupPort = popupServer.address().port;
      console.info(`[kukulu-plugin] コメントポップアップ用サーバー起動 (port: ${popupPort})`);
    });

    // ワンコメのサービス一覧からKukuluを自動検出する関数
    const resolveServiceId = async (configuredId) => {
      if (resolvedServiceId) return resolvedServiceId;
      if (configuredId && configuredId.trim() !== '') {
        resolvedServiceId = configuredId;
        return configuredId;
      }
      try {
        const res = await fetch('http://localhost:11180/api/services');
        if (!res.ok) return null;
        const services = await res.json();
        
        const target = services.find(s => 
          s.name.toLowerCase().includes('kukulu') || 
          s.url.includes('kuku.lu') || 
          s.url.includes('erinn.biz') ||
          (popupPort > 0 && s.url.includes(`localhost:${popupPort}`))
        );
        
        if (target) {
          resolvedServiceId = target.id;
          console.info(`[kukulu-plugin] Kukulu枠を自動検出しました: ${target.name} (${target.id})`);
          return target.id;
        }
      } catch (err) {
        console.error('[kukulu-plugin] サービス自動検出エラー:', err.message);
      }
      return null;
    };

    const ensureServiceEnabled = async (serviceId) => {
      try {
        const res = await fetch(`http://localhost:11180/api/services/${serviceId}`);
        if (!res.ok) return;
        const srv = await res.json();
        if (srv && !srv.enabled) {
          console.info(`[kukulu-plugin] 配信枠を有効化します。`);
          await fetch(`http://localhost:11180/api/services/${serviceId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...srv, enabled: true })
          });
        }
      } catch (err) {
        console.error('[kukulu-plugin] 配信枠有効化エラー:', err.message);
      }
    };

    // ポップアップ用URLをわんコメのURLフィールドに1回だけ設定する関数
    const syncPopupUrl = async (serviceId) => {
      if (!popupPort || isUrlSynced) return;
      const targetUrl = `http://localhost:${popupPort}/`;
      
      try {
        const res = await fetch(`http://localhost:11180/api/services/${serviceId}`);
        if (!res.ok) return;
        const srv = await res.json();
        
        if (srv && srv.url !== targetUrl) {
          console.info(`[kukulu-plugin] コメントボタン用URLを更新します: ${targetUrl}`);
          await fetch(`http://localhost:11180/api/services/${serviceId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...srv, url: targetUrl })
          });
        }
        isUrlSynced = true; // 更新成功・または既に同じURLならフラグを立てて以降更新しない
      } catch (err) {
        console.error('[kukulu-plugin] URL更新エラー:', err.message);
      }
    };

    // 枠状態チェック
    const checkLivePort = async (apikey, config) => {
      try {
        const url = `https://live.erinn.biz/api/?category=mylive&type=port_info&apikey=${encodeURIComponent(apikey)}`;
        const res = await fetch(url);
        const data = await res.json();
        
        if (data && data.success === 1) {
          // ハッシュを保存（ポップアップ用サーバーで利用）
          if (data.hash && data.hash !== '-2') {
            currentHash = data.hash;
          }

          if (data.status === '2' || data.status === 2) {
            // 配信中
          } else {
            // 配信準備中またはオフライン
          }
        } else {
          // status API で補完
          const statusUrl = `https://live.erinn.biz/api/?category=mylive&type=port_status&apikey=${encodeURIComponent(apikey)}&status=2`;
          const statusRes = await fetch(statusUrl);
          const statusData = await statusRes.json();
          if (statusData && statusData.success === 1) {
            console.info('[kukulu-plugin] 配信準備開始を確認しました！');
          }
        }
      } catch (err) {
        console.error('[kukulu-plugin] 枠情報チェックエラー:', err.message || err);
      }
    };

    // コメント送信
    const sendCommentList = async (comments, serviceId, config) => {
      await ensureServiceEnabled(serviceId);

      const maxWidth = config.imageMaxWidth || 650;
      const maxHeight = config.imageMaxHeight || 520;

      for (const item of comments) {
        const cnum = Number(item.cnum);
        if (cnum && cnum <= lastCnum) continue;
        if (cnum) lastCnum = cnum;

        // 管理用通知はスキップ
        if (item.from === 'admin' && item.message && item.message.startsWith('__INFO__')) continue;

        let commentText = item.message || '';

        // お絵描きコメント(visualchat)の画像埋め込み
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
            commentText = `${commentText ? commentText + '<br>' : ''}<div style="margin-top:8px;"><a href="${imgUrl}" target="_blank" rel="noopener noreferrer" title="クリックで拡大表示"><img src="${imgUrl}" alt="[お絵描き]" style="width:100%;max-width:${maxWidth}px;max-height:${maxHeight}px;object-fit:contain;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.22);display:block;background:#ffffff;border:1px solid rgba(0,0,0,0.1);cursor:pointer;" /></a></div>`;
          } else {
            commentText = commentText ? `${commentText} [お絵描き]` : '[お絵描き]';
          }
        } else if (item.type === 'sscomment') {
          // 画像付きコメント(sscomment)の画像埋め込み
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
            commentText = `${commentText ? commentText + '<br>' : ''}<div style="margin-top:8px;"><a href="${mediaUrl}" target="_blank" rel="noopener noreferrer" title="クリックで拡大表示"><img src="${mediaUrl}" alt="[画像]" style="width:100%;max-width:${maxWidth}px;max-height:${maxHeight}px;object-fit:contain;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.22);display:block;background:#ffffff;border:1px solid rgba(0,0,0,0.1);cursor:pointer;" /></a></div>`;
          } else {
            commentText = commentText ? `${commentText} [画像/音声]` : '[画像/音声]';
          }
        }

        const isMaster = item.from === 'master';
        const payload = {
          service: { id: serviceId, write: true, speech: true, persist: true },
          comment: {
            id: String(item.cnum || item.number || Date.now()),
            userId: String(item.ipid || (isMaster ? 'master' : 'unknown')),
            name: item.icon_name || (isMaster ? '配信者' : '匿名'),
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
    const fetchComments = async (apikey, serviceId, config) => {
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
            console.info(`[kukulu-plugin] 接続: 過去15分以内のコメント ${recent.length} 件を読み込みます`);
            const sortedRecent = [...recent].sort((a, b) => (Number(a.cnum) || 0) - (Number(b.cnum) || 0));
            await sendCommentList(sortedRecent, serviceId, config);
          } else {
            console.info(`[kukulu-plugin] 接続: 過去コメント${data.comments.length}件をスキップ (最新cnum: ${maxCnum})`);
          }
          lastCnum = Math.max(lastCnum, maxCnum);
          isInitialized = true;
          return;
        }
        const sorted = [...data.comments].sort((a, b) => (Number(a.cnum) || 0) - (Number(b.cnum) || 0));
        await sendCommentList(sorted, serviceId, config);
      }
    };

    const poll = async () => {
      if (isPolling) return;
      isPolling = true;
      try {
        if (!fs.existsSync(configPath)) return;
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const { apikey, serviceId: configuredServiceId } = config;

        if (!apikey || apikey.includes('YOUR_API_KEY') || apikey.trim() === '') {
          return;
        }

        const serviceId = await resolveServiceId(configuredServiceId);
        if (!serviceId) {
          console.warn('[kukulu-plugin] わんコメにKukulu用の配信枠が見つかりません。わんコメで枠を追加してください。');
          return;
        }

        // ポップアップ用URLの同期（1回だけ）
        await syncPopupUrl(serviceId);

        await checkLivePort(apikey, config);
        await fetchComments(apikey, serviceId, config);
      } catch (err) {
        console.error('[kukulu-plugin] ポーリングエラー:', err.message || err);
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
    console.info(`[kukulu-plugin] ポーリングループを開始しました (${intervalMs}ms 間隔)`);
  },

  destroy() {
    if (timer) { clearInterval(timer); timer = null; }
    if (popupServer) {
      popupServer.close();
      popupServer = null;
    }
    isPolling = false;
    lastCnum = 0;
    isInitialized = false;
    resolvedServiceId = null;
    isUrlSynced = false;
    currentHash = '';
    console.info('[kukulu-plugin] プラグインを停止しました');
  }
};

module.exports = plugin;
