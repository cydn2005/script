// ==UserScript==
// @name         多平台通用关键词屏蔽器 (高性能优化版 - 包含收藏夹及个人主页排除)
// @namespace    http://tampermonkey.net/
// @version      4.5.6-blocker
// @description  支持知乎、小红书、B站、微博的通用关键词屏蔽工具。带悬浮控制面板、拆词模式及搜索页屏蔽控制。（4.5.6：修复 B 站被 MARGIN/映间 等把内容重绘进 Shadow DOM 的扩展导致屏蔽失效；4.5.5：修复XSS注入、replaceState不触发重扫、隐藏目标重复处理；性能优化）
// @author       X.I.U & KasenRi
// @match        *://www.zhihu.com/*
// @match        *://zhuanlan.zhihu.com/*
// @match        https://www.xiaohongshu.com/*
// @match        https://www.bilibili.com/*
// @match        https://search.bilibili.com/*
// @match        https://weibo.com/*
// @match        https://www.weibo.com/*
// @match        https://s.weibo.com/*
// @exclude      https://www.zhihu.com/signin*
// @exclude      https://www.zhihu.com/people/*
// @exclude      https://www.zhihu.com/org/*
// @exclude      https://www.xiaohongshu.com/user/profile/*
// @exclude      https://www.xiaohongshu.com/search_result*
// @icon         https://picx.zhimg.com/v2-fab9e4d5ddf148b93df597a86b0525fd_l.jpg?source=32738c0c&needBackground=1
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        window.onurlchange
// @sandbox      JavaScript
// @license      GPL-3.0 License
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ---------- 工具 ----------

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // 兼容旧的 'true'/'false' 字符串存储
    function readBool(key, def) {
        const v = GM_getValue(key, def);
        return v === true || v === 'true';
    }

    // ---------- 页面判断 ----------

    function isZhihuQuestionPage() {
        return window.location.hostname.includes('zhihu.com') && window.location.pathname.includes('/question/');
    }

    function isZhihuProfilePage() {
        const host = window.location.hostname;
        const href = window.location.href;
        return host.includes('zhihu.com') && (href.includes('/people/') || href.includes('/org/'));
    }

    function isZhihuCollectionPage() {
        const host = window.location.hostname;
        const pathname = window.location.pathname;
        return host.includes('zhihu.com') && (pathname.includes('/collection/') || pathname.includes('/collections'));
    }

    function isXhsProfilePage() {
        return window.location.hostname.includes('xiaohongshu.com') && window.location.href.includes('/user/profile/');
    }

    function isXhsSearchPage() {
        const host = window.location.hostname;
        const href = window.location.href;
        const pathname = window.location.pathname;
        return host.includes('xiaohongshu.com') && (pathname.includes('/search') || href.includes('search_result'));
    }

    function isBiliHistoryPage() {
        return window.location.hostname.includes('bilibili.com') && window.location.href.includes('/history');
    }

    function isSearchPage() {
        const href = window.location.href;
        const host = window.location.hostname;

        if (host.includes('zhihu.com') && href.includes('/search')) return true;
        if (isXhsSearchPage()) return true;
        if (host.includes('bilibili.com') && (href.includes('search.bilibili.com') || href.includes('/all') || href.includes('keyword='))) return true;
        if (host.includes('weibo.com') && (href.includes('s.weibo.com') || href.includes('/search'))) return true;

        return false;
    }

    function isCurrentPageExcluded() {
        return isZhihuProfilePage() || isZhihuCollectionPage() || isZhihuQuestionPage() || isXhsProfilePage() || isXhsSearchPage() || isBiliHistoryPage();
    }

    // ---------- 存储 ----------

    const STORAGE_KEY = 'keyword_blocker_words';
    const DISABLED_SITES_KEY = 'keyword_blocker_disabled_sites';
    const DEEP_SPLIT_KEY = 'keyword_blocker_deep_split';
    const BLOCK_IN_SEARCH_KEY = 'keyword_blocker_block_in_search';

    let cachedDeepSplit = readBool(DEEP_SPLIT_KEY, false);
    let cachedBlockInSearch = readBool(BLOCK_IN_SEARCH_KEY, true);

    // 清理所有被隐藏的节点，防止SPA路由跳转后留下空白
    function cleanUpHiddenElements() {
        // 跨根收集（shadow 内的隐藏节点也一并恢复）
        const arr = queryAllGlobal('.zhi-e-hidden');
        for (let i = 0; i < arr.length; i++) {
            arr[i].classList.remove('zhi-e-hidden');
            delete arr[i].dataset.kbProcessed;
        }
    }

    // ---------- Shadow DOM 支持 ----------
    // B 站的 MARGIN（映间）等改版扩展会把整页内容重绘进 #margin-root 的 shadow root 里：
    //   1) document.querySelectorAll 穿不透 shadow 边界 → 找不到卡片；
    //   2) document.head 里的 .zhi-e-hidden 同样穿不透 → 打上标记也不会隐藏。
    // 因此这里对 shadow root 逐个注入隐藏样式、挂 observer，并在其内部用专用选择器扫描。
    // 仅在 bilibili 生效，其它站点行为与旧版完全一致（只用 document）。

    const KB_HIDDEN_STYLE_TEXT = '.zhi-e-hidden { display: none !important; height: 0 !important; overflow: hidden !important; opacity: 0 !important; }';
    const observedRoots = new WeakSet();
    let shadowRootsCache = [];
    let shadowScanAt = -1e9;
    const SHADOW_SCAN_INTERVAL = 1500;   // 扫描节流：滚动等高频路径不会每帧重扫整页

    function needsShadowSupport() {
        return getCurrentSite() === 'bilibili';
    }

    // 向 document 或 shadow root 注入隐藏样式
    // 注意：@run-at document-start 最早期 document.head / documentElement 可能都还是 null，
    // 这里必须返回 null 交给调用方重试，绝不能直接 appendChild 抛错——
    // 一旦抛错，整个 IIFE 中断，连 DOMContentLoaded 都注册不上，悬浮窗和屏蔽会一起消失。
    function injectStyleInto(root) {
        if (!root) return null;
        let parent;
        if (root === document) {
            parent = document.head || document.documentElement;
            if (!parent) return null;
        } else {
            parent = root;
        }
        let styleEl = parent.querySelector ? parent.querySelector('#kb-anti-flicker-style') : null;
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'kb-anti-flicker-style';
            try {
                parent.appendChild(styleEl);
            } catch (e) {
                return null;
            }
        }
        styleEl.textContent = KB_HIDDEN_STYLE_TEXT;
        return styleEl;
    }

    function injectAntiFlickerStyle() {
        if (injectStyleInto(document)) return true;
        // 文档根节点尚未出现，等 DOM 就绪再补一次
        document.addEventListener('DOMContentLoaded', () => {
            if (!injectStyleInto(document)) setTimeout(() => injectStyleInto(document), 200);
        }, { once: true });
        return false;
    }

    // 发现页面里所有可访问的 open shadow root（含嵌套）
    function discoverShadowRoots(force) {
        if (!needsShadowSupport()) return [];
        const now = performance.now();
        // 注意：不能用 length 判断是否命中缓存——没装扩展时缓存本来就是空的，
        // 那样每次调用都会重扫整页。首次（shadowScanAt < 0）一定扫。
        if (!force && shadowScanAt >= 0 && now - shadowScanAt < SHADOW_SCAN_INTERVAL) {
            return shadowRootsCache;
        }
        const found = [];
        const seen = new WeakSet();
        const scan = (root, depth) => {
            if (!root || depth > 4 || seen.has(root)) return;
            seen.add(root);
            let hosts;
            try {
                // 扩展注入的宿主元素都带 margin- 前缀 id（#margin-root / #margin-bg / #margin-watch-top ...）
                hosts = root.querySelectorAll('[id^="margin-"]');
                if (!hosts.length && depth === 0 && shadowScanAt < 0) {
                    hosts = root.querySelectorAll('*'); // 首次兜底：别家扩展可能用别的 id
                }
            } catch (e) {
                return;
            }
            for (let i = 0; i < hosts.length; i++) {
                const sr = hosts[i].shadowRoot;
                if (sr && !found.includes(sr)) {
                    found.push(sr);
                    observeRoot(sr);
                    scan(sr, depth + 1);
                }
            }
        };
        scan(document, 0);
        shadowRootsCache = found;
        shadowScanAt = now;
        return found;
    }

    // 所有需要扫描的根：document + 各 shadow root
    function getQueryRoots() {
        const roots = [document];
        if (needsShadowSupport()) {
            const extra = discoverShadowRoots(false);
            for (let i = 0; i < extra.length; i++) roots.push(extra[i]);
        }
        return roots;
    }

    // 跨根查询（替代 document.querySelectorAll）
    function queryAllGlobal(selector) {
        const out = [];
        const roots = getQueryRoots();
        for (let i = 0; i < roots.length; i++) {
            let list;
            try { list = roots[i].querySelectorAll(selector); } catch (e) { continue; }
            for (let j = 0; j < list.length; j++) out.push(list[j]);
        }
        return out;
    }

    // 节点所在的根（document 或 shadow root）
    function rootOfNode(node) {
        if (node && node.getRootNode) {
            const r = node.getRootNode();
            if (r) return r;
        }
        return document;
    }

    // 按根选择容器/标题选择器：shadow 内用扩展专用结构，document 内保持原选择器
    function selectorsFor(root, config) {
        if (root !== document && config && config.shadowContainerSelector) {
            return {
                containerSelector: config.shadowContainerSelector,
                titleSelector: config.shadowTitleSelector || config.titleSelector
            };
        }
        return {
            containerSelector: config.containerSelector,
            titleSelector: config.titleSelector
        };
    }

    injectAntiFlickerStyle();

    // 展开保护机制
    document.addEventListener('click', function (e) {
        const expandBtn = e.target.closest('.ContentItem-more, .QuestionRichText-more, button[aria-label="展开"]');
        if (expandBtn) {
            const card = expandBtn.closest('.Card.TopstoryItem, .List-item, .Card.AnswerCard, .TopstoryItem, .ContentItem, .SearchResult-Card');
            if (card) {
                card.dataset.userExpanded = 'true';
                card.dataset.kbProcessed = 'true';
                card.classList.remove('zhi-e-hidden');
            }
        }
    }, true);

    const DEFAULT_KEYWORDS = [
         '非洲', '王水牛', '原神', '满清', '小哥哥', '宝妈', '奶爸', '御姐', '萌娃', '爷叔', '阿婆', '白领',
        '蓝领', '金领', '斜杠青年', '空巢青年', '留守老人', '独居青年', 'Z世代', '银发族', '丁克族', '啃老族',
        '追星族', '二次元党', '驴友', '吃货', '猫奴', '狗党', '鸡娃家长', '佛系青年', '马甲线', '天鹅颈',
        '直角肩', '蜜桃臀', '蝴蝶背', '水蛇腰', '漫画腿', '巴掌脸', '九头身', '小升初', '九年一贯', '双一流',
        '普高', '春招', '秋招', '专升本', '硕博连读', '非全研', '函授本科', '强基计划', '综评录取', '三位一体',
        '提前批', '调剂志愿', '复读生', '保研党', '申研党', '雅思党', '教培师', '网约司机', '带货主播', '陪诊师',
        '宠物殡葬师', '收纳师', '电竞选手', '国风lo裙', 'JK制服', '盲盒隐藏款', '联名款', '限量色', '网红奶茶', '脏脏包',
        '空气炸锅', '无叶风扇', '漫签会', 'CP展', '国风巡游', '剧本杀DM', '密室NPC', '电竞网吧', '露营趴', '飞盘局',
        '陆冲板', '折叠屏', '快充头', '降噪豆', '云台相机', '电竞屏', '机械键盘', '东北老铁', '广东靓仔',
        '上海老克勒', '福建老板', '浙江商人', '山东大汉', '川渝辣妹', '京圈文化', '沪上风情', '散装江苏', '山河四省', '江浙沪包邮',
        '东三省口音', '广东吃福建人', '云南象群', '新疆切糕', '县城青年', '一线漂', '新一线', '十八线小城', '城中村', '城乡结合部',
        '新农村', '闪婚族', '裸婚族', '形婚', '丧偶式育儿', '诈尸式育儿', '扶妹魔', '孔雀女', '草食男', '咸鱼女',
        '男权红利', '娇妻文学', '叔圈天菜', '熟女经济', '叔感审美', '少年感营销', '姨味审判', '丧偶式婚姻', '全职主夫', '单亲爸爸',
        '留守妻子', '丁克家庭', 'AA制婚姻', '鸿蒙生态', '澎湃OS', '麒麟芯片', '昆仑玻璃', '星闪技术', '方舟编译器', '董宇辉体',
        '刘畊宏女孩', '王心凌男孩', '俞敏洪式创业', '张雪峰建议', '李佳琦直播间', 'SU7（小米汽车）', 'Mate60（华为手机）', '灵动岛（苹果设计）', '仙女屏（OPPO屏幕）', '房贷断供',
        '消费降级', '副业刚需', '灵活就业', '地摊经济', '预制菜焦虑', '全职儿女', '小镇贵妇', '城市候鸟', '中产返贫', '学区房内卷',
        '鸡娃教育', '厌童症', '厌老症', '服美役', '电子囤积癖', '情绪价值税', '网络判官', '外籍', '小姐姐', '女演员',
        '健身房', 'JK', '身材', '公主', '腿', '胸', '儿子', '女儿', '小孩', '幼儿园',
        '幼师', '高考', '录取', '中考', '职高', '大专', '考研', '考公', '补课', '补习',
        '985', '211', '文科生', '理科生', '迪士尼', '盲盒', '奶茶', 'COSER', 'coser', 'Coser',
        '漫展', '吹风机', '空调', '大妈', '男子', '天价耳环', '外卖', '补贴', '户晨风', '峰哥',
        '阳历', '地域黑', '地图炮', '素质低', '落后', '排外', '小气', '狡猾', '豪爽', '懒惰',
        '勤奋', '爱占便宜', '没文化', '南北差异', '地域偏见', '刻板印象', '女性', '男性', '女生', '美女',
        '女神', '女朋友', '男朋友', '性别', '吵架', '黑人', '单亲', '大龄女', '结婚', '生娃',
        '扶弟魔', '妈宝男', '凤凰男', '普信男', '婚姻', '不生娃', '不结婚', '彩礼', '嫁妆', '生孩子',
        '冠姓权', '婆婆', '大龄剩女', '老公', '体育生', '小米', '华为', '鸿蒙', '雷军', '任正非',
        '余承东', '董宇辉', '刘强东', '东哥', '杨笠', '傅首尔', '李欣莳', '宗庆后', '娃哈哈', '黄杨',
        '鸿蒙智行', '尊界', '问界', 'yu7', 'su7', '红米', '手机', '美白', '美肤', '防晒',
        '俄乌', '普京', '泽连斯基', '高层住宅', '房价', '穷人', '富人', '底层', '阶级', '生育',
        '不婚', '不育', '赚钱', '阶层', '小红书', '原生', '清朝', '明朝', '压抑', '打工人',
        '恒大', '龟男', '小镇', '猫', '自来水', '缅甸', '大叔', '老百姓', '买房', '移民',
        '负债', '油车', '电车', '老实', '中年', '台球', '发钱', '留学生', '印度', '父亲',
        '母亲', '原生家庭', '俄罗斯'
    ];

    let BLOCK_KEYWORDS = loadKeywords();
    let compiledRegex = null;

    function updateCompiledRegex() {
        if (!BLOCK_KEYWORDS || BLOCK_KEYWORDS.length === 0) {
            compiledRegex = null;
            return;
        }
        const patterns = BLOCK_KEYWORDS.map(k => {
            if (!k) return null;
            let escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (cachedDeepSplit && k.length >= 4) {
                let prefix2 = k.substring(0, 2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return escaped + '|' + prefix2;
            }
            return escaped;
        }).filter(Boolean);

        compiledRegex = patterns.length > 0 ? new RegExp(patterns.join('|'), 'i') : null;
    }

    updateCompiledRegex();

    function saveKeywords(keywords) {
        GM_setValue(STORAGE_KEY, JSON.stringify(keywords));
        updateCompiledRegex();
    }

    function loadKeywords() {
        try {
            const saved = GM_getValue(STORAGE_KEY, null);
            return saved ? JSON.parse(saved) : [...DEFAULT_KEYWORDS];
        } catch (e) {
            return [...DEFAULT_KEYWORDS];
        }
    }

    function saveDisabledSites(sites) {
        GM_setValue(DISABLED_SITES_KEY, JSON.stringify(sites));
    }

    function loadDisabledSites() {
        try {
            const saved = GM_getValue(DISABLED_SITES_KEY, null);
            return saved ? JSON.parse(saved) : [];
        } catch (e) {
            return [];
        }
    }

    function setDeepSplit(enabled) {
        cachedDeepSplit = enabled;
        GM_setValue(DEEP_SPLIT_KEY, enabled);
        updateCompiledRegex();
    }

    function setBlockInSearch(enabled) {
        cachedBlockInSearch = enabled;
        GM_setValue(BLOCK_IN_SEARCH_KEY, enabled);

        // 统一策略：清除全部标记与隐藏，再按需重扫，避免开启/关闭后状态不一致
        queryAllGlobal('[data-kb-processed="true"]').forEach(el => {
            delete el.dataset.kbProcessed;
        });
        cleanUpHiddenElements();

        if (cachedBlockInSearch || !isSearchPage()) {
            processAllContent();
        }
    }

    function getCurrentSite() {
        const hostname = window.location.hostname;
        if (hostname.includes('zhihu.com')) return 'zhihu';
        if (hostname.includes('xiaohongshu.com')) return 'xiaohongshu';
        if (hostname.includes('bilibili.com')) return 'bilibili';
        if (hostname.includes('weibo.com')) return 'weibo';
        return 'unknown';
    }

    function isCurrentSiteDisabled() {
        return loadDisabledSites().includes(getCurrentSite());
    }

    function disableCurrentSite() {
        const disabledSites = loadDisabledSites();
        const currentSite = getCurrentSite();
        if (!disabledSites.includes(currentSite)) {
            disabledSites.push(currentSite);
            saveDisabledSites(disabledSites);
            cleanUpHiddenElements();
        }
    }

    function enableCurrentSite() {
        const disabledSites = loadDisabledSites();
        const currentSite = getCurrentSite();
        const index = disabledSites.indexOf(currentSite);
        if (index > -1) {
            disabledSites.splice(index, 1);
            saveDisabledSites(disabledSites);
        }
    }

    function addUrlChangeEvent() {
        // 统一 dispatch 'urlchange'，修复 replaceState 不触发重扫的问题
        history.pushState = (f => function pushState() { var ret = f.apply(this, arguments); window.dispatchEvent(new Event('urlchange')); return ret; })(history.pushState);
        history.replaceState = (f => function replaceState() { var ret = f.apply(this, arguments); window.dispatchEvent(new Event('urlchange')); return ret; })(history.replaceState);
        window.addEventListener('popstate', () => { window.dispatchEvent(new Event('urlchange')) });
    }

    if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(STORAGE_KEY, function (name, oldValue, newValue, remote) {
            if (remote) {
                BLOCK_KEYWORDS = loadKeywords();
                updateCompiledRegex();
                const searchInput = document.getElementById('kb-search-input');
                renderKeywordList(searchInput ? searchInput.value : '');
                processAllContent();
            }
        });

        GM_addValueChangeListener(DEEP_SPLIT_KEY, function (name, oldValue, newValue, remote) {
            if (remote) {
                cachedDeepSplit = readBool(DEEP_SPLIT_KEY, false);
                updateCompiledRegex();
                const deepSwitch = document.getElementById('kb-deep-switch');
                if (deepSwitch) deepSwitch.checked = cachedDeepSplit;
                processAllContent();
            }
        });

        GM_addValueChangeListener(BLOCK_IN_SEARCH_KEY, function (name, oldValue, newValue, remote) {
            if (remote) {
                cachedBlockInSearch = readBool(BLOCK_IN_SEARCH_KEY, true);
                const searchSwitch = document.getElementById('kb-search-switch');
                if (searchSwitch) searchSwitch.checked = cachedBlockInSearch;
                processAllContent();
            }
        });
    }

    const siteConfigs = {
        zhihu: {
            containerSelector: '.SearchResult-Card, .SearchItem, .Card.TopstoryItem, .TopstoryItem, .ContentItem, .Card.AnswerCard',
            titleSelector: '.SearchResult-Card h2, .SearchItem-title a, .ContentItem-title a, h2.ContentItem-title',
            logPrefix: '已屏蔽知乎内容'
        },
        xiaohongshu: {
            containerSelector: 'section.note-item',
            titleSelector: 'a.title, .title, .footer .title span',
            logPrefix: '已屏蔽小红书内容'
        },
        bilibili: {
            containerSelector: '.bili-feed-card, .bili-video-card, .video-item',
            titleSelector: '.bili-video-card__info--tit, .bili-video-card__info--tit a, .title',
            logPrefix: '已屏蔽B站内容',
            // MARGIN（映间）把首页/收藏等重绘在 shadow root 内，卡片结构：
            // <article class="card"><a class="cover"><img></a><div class="body"><a class="title">标题</a>…
            shadowContainerSelector: 'article.card, div.card, .bili-video-card, .bili-feed-card, .video-item',
            shadowTitleSelector: 'a.title, .title, .bili-video-card__info--tit'
        },
        weibo: {
            containerSelector: '.wbpro-scroller-item, .card-wrap',
            titleSelector: '.wbpro-feed-content .detail_wbtext_4CRf9, .txt',
            logPrefix: '已屏蔽微博内容'
        }
    };

    // ---------- 管理面板 UI ----------

    function createManagementUI() {
        if (document.getElementById('keyword-blocker-panel')) return;

        const style = document.createElement('style');
        style.textContent = `
            #keyword-blocker-panel, #keyword-blocker-panel * {
                box-sizing: border-box !important;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            }
            #keyword-blocker-toggle {
                position: fixed; left: 20px; top: 60%; transform: translateY(-50%); z-index: 2147483647;
                background: #1890ff; color: white; border: none; border-radius: 6px;
                padding: 12px 8px; cursor: pointer; font-size: 14px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.15); transition: all 0.3s ease;
                writing-mode: vertical-lr; text-orientation: mixed;
            }
            #keyword-blocker-toggle:hover { background: #40a9ff; transform: translateY(-50%) scale(1.05); }
            #keyword-blocker-panel {
                position: fixed; left: -350px; top: 50%; transform: translateY(-50%); z-index: 2147483647;
                width: 330px; max-height: 85vh; background: white; border: 1px solid #d9d9d9;
                border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.15);
                transition: left 0.3s ease;
            }
            #keyword-blocker-panel.show { left: 20px; }
            .kb-panel-header { padding: 16px; border-bottom: 1px solid #f0f0f0; background: #fafafa; border-radius: 8px 8px 0 0; }
            .kb-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
            .kb-panel-title { margin: 0; font-size: 16px; font-weight: 500; color: #262626; flex: 1; }
            .kb-input-group { display: flex; gap: 8px; margin-bottom: 8px; }
            .kb-input { flex: 1; padding: 6px 10px; border: 1px solid #d9d9d9; border-radius: 4px; font-size: 13px; outline: none; }
            .kb-input:focus { border-color: #1890ff; box-shadow: 0 0 0 2px rgba(24,144,255,0.2); }
            .kb-btn { padding: 6px 14px; background: #1890ff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; transition: background 0.3s; white-space: nowrap; }
            .kb-btn:hover { background: #40a9ff; }

            .kb-switch-group { display: flex; flex-direction: column; gap: 6px; }
            .kb-switch-row { display: flex; justify-content: space-between; align-items: center; background: #f0f5ff; padding: 6px 10px; border-radius: 4px; font-size: 12px; color: #1890ff; border: 1px solid #adc6ff; }
            .kb-switch-label { font-weight: 500; }
            .kb-switch { position: relative; display: inline-block; width: 36px; height: 20px; }
            .kb-switch input { opacity: 0; width: 0; height: 0; }
            .kb-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .3s; border-radius: 20px; }
            .kb-slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .3s; border-radius: 50%; }
            input:checked + .kb-slider { background-color: #1890ff; }
            input:checked + .kb-slider:before { transform: translateX(16px); }

            .kb-list-container { max-height: calc(85vh - 300px); overflow-y: auto; padding: 0; }
            .kb-list { list-style: none; margin: 0; padding: 0; }
            .kb-list-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid #f0f0f0; gap: 6px; }
            .kb-list-item:hover { background: #f5f5f5; }
            .kb-keyword { flex: 1; font-size: 13px; color: #262626; word-break: break-all; }
            .kb-action-group { display: flex; gap: 4px; }
            .kb-edit-btn { padding: 3px 6px; background: #faad14; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
            .kb-edit-btn:hover { background: #ffc53d; }
            .kb-delete-btn { padding: 3px 6px; background: #ff4d4f; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
            .kb-delete-btn:hover { background: #ff7875; }
            .kb-save-btn { padding: 3px 6px; background: #52c41a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
            .kb-save-btn:hover { background: #73d13d; }
            .kb-confirm-group { display: flex; gap: 6px; }
            .kb-confirm-btn { padding: 3px 6px; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
            .kb-confirm-delete { background: #ff4d4f; color: white; }
            .kb-confirm-delete:hover { background: #ff7875; }
            .kb-confirm-cancel { background: #8c8c8c; color: white; }
            .kb-confirm-cancel:hover { background: #a6a6a6; }
            .kb-stats {
                padding: 10px 16px; background: #f9f9f9; border-top: 1px solid #f0f0f0;
                font-size: 12px; color: #666; text-align: center;
                border-radius: 0 0 8px 8px; display: flex; justify-content: center; align-items: center; gap: 10px; flex-wrap: wrap;
            }
            .kb-close-btn { position: absolute; top: 10px; right: 10px; background: none; border: none; font-size: 18px; cursor: pointer; color: #999; padding: 4px; border-radius: 3px; }
            .kb-close-btn:hover { background: #f0f0f0; color: #666; }
            .kb-disable-site-btn { padding: 4px 8px; background: #8c8c8c; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 10px; white-space: nowrap; margin-left: 12px; }
            .kb-disable-site-btn:hover { background: #a6a6a6; }
        `;
        const styleHost = document.head || document.documentElement;
        if (styleHost) styleHost.appendChild(style);

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'keyword-blocker-toggle';
        toggleBtn.textContent = '屏蔽词管理';

        const panel = document.createElement('div');
        panel.id = 'keyword-blocker-panel';
        const currentSite = getCurrentSite();
        const siteNames = { zhihu: '知乎', xiaohongshu: '小红书', bilibili: 'B站', weibo: '微博' };
        const siteName = siteNames[currentSite] || '当前网站';
        const isDisabled = isCurrentSiteDisabled();
        const btnText = isDisabled ? '重新启用' + siteName + '屏蔽' : '有BUG？停止屏蔽' + siteName;
        const statusText = isDisabled ? '⚠️ ' + siteName + '屏蔽功能已停用' : '屏蔽词管理';
        const isDeepChecked = cachedDeepSplit ? 'checked' : '';
        const isSearchChecked = cachedBlockInSearch ? 'checked' : '';

        panel.innerHTML = `
            <button class="kb-close-btn" id="kb-close">×</button>
            <div class="kb-panel-header">
                <div class="kb-title-row">
                    <h3 class="kb-panel-title">${escapeHtml(statusText)}</h3>
                    <button class="kb-disable-site-btn" id="kb-disable-site">${escapeHtml(btnText)}</button>
                </div>
                <div class="kb-input-group">
                    <input type="text" id="kb-input" class="kb-input" placeholder="新增屏蔽词，用 , 或 / 分隔" />
                    <button id="kb-add-btn" class="kb-btn">新增</button>
                </div>
                <div class="kb-input-group">
                    <input type="text" id="kb-search-input" class="kb-input" placeholder="🔍 查找已有屏蔽词..." style="background: #fafafa;" />
                </div>
                <div class="kb-switch-group">
                    <div class="kb-switch-row">
                        <span class="kb-switch-label" title="开启后，在搜索结果页面依然会执行关键词屏蔽">🔍 在搜索结果页也屏蔽内容</span>
                        <label class="kb-switch">
                            <input type="checkbox" id="kb-search-switch" ${isSearchChecked}>
                            <span class="kb-slider"></span>
                        </label>
                    </div>
                    <div class="kb-switch-row">
                        <span class="kb-switch-label" title="开启后，长词会自动提取前2个字进行模糊匹配">⚡ 2字核心拆词模式</span>
                        <label class="kb-switch">
                            <input type="checkbox" id="kb-deep-switch" ${isDeepChecked}>
                            <span class="kb-slider"></span>
                        </label>
                    </div>
                </div>
            </div>
            <div class="kb-list-container">
                <ul id="kb-list" class="kb-list"></ul>
            </div>
            <div class="kb-stats">
                <span>显示 <span id="kb-count">0</span> 个屏蔽词</span>
                <button id="kb-copy-btn" class="kb-btn" style="padding:3px 10px; font-size:12px;">复制全部</button>
                <button id="kb-clear-all-btn" class="kb-btn" style="padding:3px 10px; font-size:12px; background:#ff4d4f;">清空全部</button>
            </div>
        `;

        const mount = () => {
            // 关键：挂 documentElement，不挂 body。
            // MARGIN（映间）这类重绘型扩展会把 B 站 home 的 body 整体设为 display:none，
            // 自己画在 documentElement 下的 #margin-root 里。面板若留在 body 里，
            // 计算样式仍是 display:block / visible，但 rect 全 0，用户看不到任何东西。
            const host = document.documentElement;
            if (!host) {
                setTimeout(mount, 100);
                return;
            }
            host.appendChild(toggleBtn);
            host.appendChild(panel);
            renderKeywordList();
            initUIEvents();
        };
        mount();
    }

    // 构建一个列表项（安全 DOM 构建，杜绝 innerHTML 注入）
    function buildListItem(keyword, index) {
        const li = document.createElement('li');
        li.className = 'kb-list-item';
        li.dataset.index = index;

        const span = document.createElement('span');
        span.className = 'kb-keyword';
        span.textContent = keyword;

        const group = document.createElement('div');
        group.className = 'kb-action-group';

        const editBtn = document.createElement('button');
        editBtn.className = 'kb-edit-btn';
        editBtn.dataset.index = index;
        editBtn.textContent = '修改';

        const delBtn = document.createElement('button');
        delBtn.className = 'kb-delete-btn';
        delBtn.dataset.index = index;
        delBtn.textContent = '删除';

        group.appendChild(editBtn);
        group.appendChild(delBtn);
        li.appendChild(span);
        li.appendChild(group);
        return li;
    }

    function renderKeywordList(filterText = '') {
        const list = document.getElementById('kb-list');
        const count = document.getElementById('kb-count');
        if (!list || !count) return;
        list.innerHTML = '';

        const searchText = filterText.trim().toLowerCase();
        let displayCount = 0;

        BLOCK_KEYWORDS.forEach((keyword, index) => {
            if (searchText && !keyword.toLowerCase().includes(searchText)) {
                return;
            }
            displayCount++;
            list.appendChild(buildListItem(keyword, index));
        });

        if (searchText) {
            count.textContent = displayCount + ' / ' + BLOCK_KEYWORDS.length;
        } else {
            count.textContent = BLOCK_KEYWORDS.length;
        }
    }

    function showEditMode(listItem, index) {
        const currentWord = BLOCK_KEYWORDS[index];
        listItem.innerHTML = '';

        const editInput = document.createElement('input');
        editInput.type = 'text';
        editInput.className = 'kb-input kb-edit-input';
        editInput.style.cssText = 'padding:2px 6px; font-size:13px;';
        editInput.value = currentWord; // 属性赋值，无引号截断问题

        const group = document.createElement('div');
        group.className = 'kb-confirm-group';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'kb-save-btn';
        saveBtn.dataset.index = index;
        saveBtn.textContent = '保存';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'kb-confirm-btn kb-confirm-cancel';
        cancelBtn.dataset.index = index;
        cancelBtn.textContent = '取消';

        group.appendChild(saveBtn);
        group.appendChild(cancelBtn);
        listItem.appendChild(editInput);
        listItem.appendChild(group);

        editInput.focus();
        editInput.select();
    }

    function showDeleteConfirm(listItem, index) {
        listItem.innerHTML = '';

        const span = document.createElement('span');
        span.className = 'kb-keyword';
        span.textContent = BLOCK_KEYWORDS[index];

        const group = document.createElement('div');
        group.className = 'kb-confirm-group';

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'kb-confirm-btn kb-confirm-delete';
        confirmBtn.dataset.index = index;
        confirmBtn.textContent = '确认删除';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'kb-confirm-btn kb-confirm-cancel';
        cancelBtn.dataset.index = index;
        cancelBtn.textContent = '取消';

        group.appendChild(confirmBtn);
        group.appendChild(cancelBtn);
        listItem.appendChild(span);
        listItem.appendChild(group);
    }

    function restoreNormalView(listItem, index) {
        const fresh = buildListItem(BLOCK_KEYWORDS[index], index);
        listItem.replaceWith(fresh);
    }

    function updateKeyword(index, newWord) {
        newWord = newWord.replace(/\s+/g, '').trim();
        if (newWord && index >= 0 && index < BLOCK_KEYWORDS.length) {
            if (BLOCK_KEYWORDS.includes(newWord) && BLOCK_KEYWORDS[index] !== newWord) {
                alert('修改后的屏蔽词已存在！');
                return false;
            }
            BLOCK_KEYWORDS[index] = newWord;
            saveKeywords(BLOCK_KEYWORDS);
            const searchInput = document.getElementById('kb-search-input');
            renderKeywordList(searchInput ? searchInput.value : '');
            processAllContent();
            return true;
        }
        return false;
    }

    function addKeywords(input) {
        const words = input.split(/[,，/]/).map(w => w.replace(/\s+/g, '')).filter(w => w.length > 0 && !BLOCK_KEYWORDS.includes(w));
        if (words.length > 0) {
            BLOCK_KEYWORDS.unshift(...words);
            saveKeywords(BLOCK_KEYWORDS);

            const searchInput = document.getElementById('kb-search-input');
            if (searchInput) searchInput.value = '';
            renderKeywordList();
            return true;
        }
        return false;
    }

    function removeKeyword(index) {
        if (index >= 0 && index < BLOCK_KEYWORDS.length) {
            BLOCK_KEYWORDS.splice(index, 1);
            saveKeywords(BLOCK_KEYWORDS);
            const searchInput = document.getElementById('kb-search-input');
            renderKeywordList(searchInput ? searchInput.value : '');
            return true;
        }
        return false;
    }

    function initUIEvents() {
        const toggleBtn = document.getElementById('keyword-blocker-toggle');
        const panel = document.getElementById('keyword-blocker-panel');
        const closeBtn = document.getElementById('kb-close');
        const addBtn = document.getElementById('kb-add-btn');
        const input = document.getElementById('kb-input');
        const searchInput = document.getElementById('kb-search-input');
        const list = document.getElementById('kb-list');
        const disableSiteBtn = document.getElementById('kb-disable-site');
        const deepSwitch = document.getElementById('kb-deep-switch');
        const searchSwitch = document.getElementById('kb-search-switch');

        if (!toggleBtn || !panel) return;

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                renderKeywordList(e.target.value);
            });
        }

        if (deepSwitch) {
            deepSwitch.addEventListener('change', (e) => {
                setDeepSplit(e.target.checked);
                processAllContent();
            });
        }

        if (searchSwitch) {
            searchSwitch.addEventListener('change', (e) => {
                setBlockInSearch(e.target.checked);
            });
        }

        const copyBtn = document.getElementById('kb-copy-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const text = BLOCK_KEYWORDS.join(', ');
                navigator.clipboard.writeText(text).then(() => {
                    alert('已复制所有屏蔽词！');
                }).catch(() => {
                    const textarea = document.createElement('textarea');
                    textarea.value = text;
                    // 挂 documentElement：body 被扩展设为 display:none 时，隐藏容器里的文本无法 select
                    const scratchHost = document.body && document.body.clientHeight ? document.body : document.documentElement;
                    scratchHost.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    scratchHost.removeChild(textarea);
                    alert('已复制（降级方式）');
                });
            });
        }

        const clearAllBtn = document.getElementById('kb-clear-all-btn');
        if (clearAllBtn) {
            clearAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('确定要删除所有屏蔽词吗？此操作不可恢复！')) {
                    BLOCK_KEYWORDS = [];
                    saveKeywords(BLOCK_KEYWORDS);
                    renderKeywordList();
                    alert('已清空全部屏蔽词。');
                }
            });
        }

        toggleBtn.addEventListener('click', () => {
            if (panel.classList.contains('show')) {
                panel.classList.remove('show');
                toggleBtn.style.display = 'block';
            } else {
                BLOCK_KEYWORDS = loadKeywords();
                renderKeywordList(searchInput ? searchInput.value : '');
                panel.classList.add('show');
                toggleBtn.style.display = 'none';
            }
        });

        function closePanel() {
            panel.classList.remove('show');
            toggleBtn.style.display = 'block';
        }

        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closePanel();
        });

        document.addEventListener('click', (e) => {
            if (!panel.contains(e.target) && !toggleBtn.contains(e.target)) {
                closePanel();
            }
        });

        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const value = input.value.trim();
            if (value) {
                if (addKeywords(value)) {
                    input.value = '';
                    processAllContent();
                } else {
                    alert('请输入有效的屏蔽词（或该词已存在）');
                }
            }
        });

        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') addBtn.click();
        });

        list.addEventListener('click', (e) => {
            const index = parseInt(e.target.dataset.index, 10);
            if (isNaN(index)) return;

            const listItem = e.target.closest('.kb-list-item');

            if (e.target.classList.contains('kb-edit-btn')) {
                e.stopPropagation();
                showEditMode(listItem, index);
            } else if (e.target.classList.contains('kb-save-btn')) {
                e.stopPropagation();
                const editInput = listItem.querySelector('.kb-edit-input');
                if (editInput) {
                    updateKeyword(index, editInput.value);
                }
            } else if (e.target.classList.contains('kb-delete-btn')) {
                e.stopPropagation();
                showDeleteConfirm(listItem, index);
            } else if (e.target.classList.contains('kb-confirm-delete')) {
                e.stopPropagation();
                removeKeyword(index);
            } else if (e.target.classList.contains('kb-confirm-cancel')) {
                e.stopPropagation();
                restoreNormalView(listItem, index);
            }
        });

        list.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && e.target.classList.contains('kb-edit-input')) {
                const listItem = e.target.closest('.kb-list-item');
                const saveBtn = listItem ? listItem.querySelector('.kb-save-btn') : null;
                if (saveBtn) saveBtn.click();
            }
        });

        disableSiteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const site = getCurrentSite();
            const names = { zhihu: '知乎', xiaohongshu: '小红书', bilibili: 'B站', weibo: '微博' };
            const name = names[site] || '当前网站';
            if (isCurrentSiteDisabled()) {
                if (confirm('确定重新启用' + name + '屏蔽吗？')) {
                    enableCurrentSite();
                    alert('已重新启用，刷新页面生效。');
                    closePanel();
                }
            } else {
                if (confirm('确定停止在' + name + '的屏蔽吗？')) {
                    disableCurrentSite();
                    alert('已停止，刷新页面生效。');
                    closePanel();
                }
            }
        });
    }

    // ---------- 屏蔽核心 ----------

    // pageExcluded 由调用方每批计算一次传入，避免逐元素重复判断
    function processContentElement(element, config, pageExcluded) {
        try {
            if (!element || element.dataset.kbProcessed === 'true') return;

            if (element.dataset.userExpanded === 'true') {
                element.dataset.kbProcessed = 'true';
                return;
            }

            if (pageExcluded) {
                element.dataset.kbProcessed = 'true';
                element.classList.remove('zhi-e-hidden');
                return;
            }

            if (isSearchPage() && !cachedBlockInSearch) {
                element.dataset.kbProcessed = 'true';
                element.classList.remove('zhi-e-hidden');
                return;
            }

            const site = getCurrentSite();

            const titleElements = element.querySelectorAll(config.titleSelector);
            let title = '';
            if (titleElements.length > 0) {
                titleElements.forEach(el => { title += el.textContent.trim() + ' '; });
            } else {
                title = element.textContent.trim();
            }

            const trimmedTitle = title.trim();

            if (!trimmedTitle || trimmedTitle.length < 2) {
                element.dataset.kbProcessed = 'true';
                return;
            }

            const isMatched = compiledRegex ? compiledRegex.test(trimmedTitle) : false;

            if (isMatched) {
                let targetToHide = element;
                if (site === 'zhihu') {
                    const parentItem = element.closest('.SearchResult-Card, .SearchItem, .Card.TopstoryItem, .TopstoryItem, .ContentItem');
                    if (parentItem) targetToHide = parentItem;
                } else if (site === 'bilibili') {
                    // MARGIN（映间）重绘的卡片：<article class="card"> 本身就是容器，
                    // 隐藏时连封面/标题/作者整块一起隐藏，避免留下半个空卡。
                    const feed = element.closest('.feed-card, .bili-feed-card, .bili-video-card, .video-item')
                        || element.closest('article.card, div.card, .card.vrow');
                    if (feed) targetToHide = feed;
                } else if (site === 'xiaohongshu') {
                    const note = element.closest('section.note-item');
                    if (note) targetToHide = note;
                } else if (site === 'weibo') {
                    const scroller = element.closest('.wbpro-scroller-item, .card-wrap');
                    if (scroller) targetToHide = scroller;
                }

                targetToHide.classList.add('zhi-e-hidden');
                // 隐藏目标也打标记，避免父容器被重复扫描
                targetToHide.dataset.kbProcessed = 'true';
            }

            element.dataset.kbProcessed = 'true';
        } catch (e) {
            if (element) element.dataset.kbProcessed = 'true';
        }
    }

    let processingTimer = null;
    let processingFallback = null;
    let nodeQueue = new Set();

    function processQueue() {
        const pageExcluded = isCurrentPageExcluded();
        if (pageExcluded || isCurrentSiteDisabled()) {
            nodeQueue.clear();
            cleanUpHiddenElements();
            return;
        }

        const site = getCurrentSite();
        const config = siteConfigs[site];
        if (!config) { nodeQueue.clear(); return; }

        nodeQueue.forEach(node => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;

            // 新出现的 shadow 宿主（如扩展刚刚注入的 #margin-root）立刻接管，不必等下次扫描
            if (node.shadowRoot && needsShadowSupport()) observeRoot(node.shadowRoot);

            const sel = selectorsFor(rootOfNode(node), config);

            if (node.matches && node.matches(sel.containerSelector)) {
                processContentElement(node, sel, pageExcluded);
            }
            if (node.querySelectorAll) {
                const elements = node.querySelectorAll(sel.containerSelector + ':not([data-kb-processed="true"])');
                elements.forEach(el => processContentElement(el, sel, pageExcluded));
            }
        });

        nodeQueue.clear();
    }

    function debounceProcess() {
        if (processingTimer) cancelAnimationFrame(processingTimer);
        processingTimer = requestAnimationFrame(processQueue);
        // 兜底：窗口被遮挡、标签页在后台时浏览器可能长时间不出帧，rAF 会一直不执行，
        // 队列里的卡片就一直没人处理。定时器接一次力，processQueue 本身是幂等的。
        if (processingFallback) clearTimeout(processingFallback);
        processingFallback = setTimeout(processQueue, 150);
    }

    function processAllContent() {
        if (isCurrentPageExcluded() || isCurrentSiteDisabled()) {
            cleanUpHiddenElements();
            return;
        }
        // 关键词以内存为准，不再每次从 GM 读盘（远程变更由 valueChangeListener 负责刷新）
        const site = getCurrentSite();
        const config = siteConfigs[site];
        if (!config) return;

        const pageExcluded = false; // 上面已排除
        const roots = getQueryRoots();
        for (let i = 0; i < roots.length; i++) {
            const root = roots[i];
            const sel = selectorsFor(root, config);
            const elements = root.querySelectorAll(sel.containerSelector + ':not([data-kb-processed="true"])');
            elements.forEach(el => processContentElement(el, sel, pageExcluded));
        }
    }

    function mutationHandler(mutations) {
        if (isCurrentPageExcluded() || isCurrentSiteDisabled()) {
            cleanUpHiddenElements();
            return;
        }

        for (let i = 0; i < mutations.length; i++) {
            const added = mutations[i].addedNodes;
            for (let j = 0; j < added.length; j++) {
                // 非元素节点（文本/注释）直接过滤，不进队列
                if (added[j].nodeType === Node.ELEMENT_NODE) {
                    nodeQueue.add(added[j]);
                }
            }
        }

        if (nodeQueue.size > 0) {
            debounceProcess();
        }
    }

    // 对 document/shadow root 挂 observer 并注入隐藏样式（每个根只做一次）
    function observeRoot(root) {
        if (!root || observedRoots.has(root)) return;
        try {
            new MutationObserver(mutationHandler).observe(root, { childList: true, subtree: true });
            observedRoots.add(root);
            injectStyleInto(root);
        } catch (e) {
            // 不可观察的根（极少见）直接跳过，不影响其它根
        }
    }

    function initUnifiedObserver() {
        observeRoot(document.documentElement);

        // B 站：扩展把内容渲染在 shadow root 里，必须在这些根上分别挂 observer，
        // 否则 document 的 observer 收不到 shadow 内部的增删，卡片换一批就漏一批。
        if (needsShadowSupport()) {
            discoverShadowRoots(true).forEach(observeRoot);
        }
    }

    function initMultiPlatformBlocker() {
        if (window.onurlchange === undefined) { addUrlChangeEvent(); }

        // 顶层那次注入可能因文档根节点还没出现而失败，这里 DOM 已就绪，补一次
        injectAntiFlickerStyle();

        createManagementUI();

        // 先挂 observer 再扫，避免渲染间隙漏掉节点
        initUnifiedObserver();

        if (!isCurrentSiteDisabled() && !isCurrentPageExcluded()) {
            processAllContent();
        } else {
            cleanUpHiddenElements();
        }

        // B 站：改版扩展的 shadow root 常晚于本脚本出现（等接口数据回来才渲染），
        // 且 document 的 observer 看不到 shadow 内部，这里低频巡检补挂 + 补扫。
        if (needsShadowSupport()) {
            let knownShadowCount = -1;
            setInterval(() => {
                if (document.hidden) return;
                const roots = discoverShadowRoots(false);
                roots.forEach(observeRoot);
                if (roots.length !== knownShadowCount) {
                    knownShadowCount = roots.length;
                    if (!isCurrentSiteDisabled() && !isCurrentPageExcluded()) processAllContent();
                }
            }, 2000);
        }

        // 切回标签页补一次全量扫描：后台期间 rAF 与巡检都可能被挂起，回来时状态可能已经变了
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) return;
            if (isCurrentSiteDisabled() || isCurrentPageExcluded()) return;
            processAllContent();
        });

        // SPA 路由跳转时的清理与状态同步
        window.addEventListener('urlchange', function () {
            if (isCurrentPageExcluded()) {
                nodeQueue.clear();
                cleanUpHiddenElements();
                return;
            }

            setTimeout(() => {
                if (isCurrentPageExcluded()) {
                    cleanUpHiddenElements();
                    return;
                }
                queryAllGlobal('[data-kb-processed="true"]').forEach(el => {
                    delete el.dataset.kbProcessed;
                });
                processAllContent();
            }, 200);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMultiPlatformBlocker);
    } else {
        initMultiPlatformBlocker();
    }
})();
